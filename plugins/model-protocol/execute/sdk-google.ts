// SDK 适配器（v1 仅 @google/genai）：惰性 import，包缺失 / 加载失败 -> model_unsupported。
// SDK 包是本插件自己的 npm 依赖（package.json + lockfile 钉版本）；世界只存 quirks.sdk_package 这个名字。
// 鉴权交 SDK 构造参数（apiKey）；`CHRONO_MODEL_SDK_MODULE` 是测试注入伪模块的接缝，缺省用真实包名。
// contents 按 Gemini 线形状编形：assistant 的 tool_calls 编成 functionCall part、tool 结果编成 functionResponse part；
// 能力表允许时把捕获的思考文本与 thought signature 按 parts 回传（Gemini 3 工具循环的硬要求）。

import { ModelError } from './errors.ts'
import { encodeReasoning, setByPath } from './quirks.ts'
import type { Quirks } from './quirks.ts'
import { asRecord, stringField, StreamAccumulator } from './stream.ts'
import { readReasoningBlocks, reasoningBlock, replayableBlocks, sendsReasoningParam } from './reasoning.ts'
import type { ReasoningBlock, ReasoningCapability } from './reasoning.ts'
import type { Json, Rec } from 'plugin-sdk'
import type { ModelOutput } from './adapters.ts'

const SUPPORTED_SDK = '@google/genai'

export interface GoogleChunk {
  text?: string
  usageMetadata?: Rec
  functionCalls?: Json[]
  candidates?: Json[]
}

export interface GoogleResponse {
  text?: string
  usageMetadata?: Rec
  functionCalls?: Json[]
  candidates?: Json[]
}

export interface GoogleClient {
  models: {
    generateContentStream(params: Rec): Promise<AsyncIterable<GoogleChunk>> | AsyncIterable<GoogleChunk>
    generateContent(params: Rec): Promise<GoogleResponse>
  }
}

export type GoogleClientConstructor = new (options: { apiKey: string }) => GoogleClient

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SDK 运行期异常归类：网络 / 服务错误可重试；已是结构化错误则原样。 */
function mapSdkError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  const message = err instanceof Error ? err.message : 'sdk call failed'
  return new ModelError('model_server_error', message, { retryable: true })
}

/** 惰性加载 Google SDK；不支持的包名 / 加载失败 -> model_unsupported。 */
export async function loadGoogleSdk(sdkPackage: string | null): Promise<GoogleClientConstructor> {
  if (sdkPackage !== SUPPORTED_SDK) {
    throw new ModelError('model_unsupported', `unsupported sdk_package: ${sdkPackage ?? '(none)'}`)
  }
  const specifier = process.env['CHRONO_MODEL_SDK_MODULE'] ?? sdkPackage
  let loaded: Json
  try {
    loaded = (await import(specifier)) as unknown as Json
  } catch (err) {
    throw new ModelError('model_unsupported', `cannot load ${sdkPackage}: ${(err as Error).message}`)
  }
  const module = isRecord(loaded) ? loaded : {}
  const candidate = module['GoogleGenAI'] ?? (isRecord(module['default']) ? module['default']['GoogleGenAI'] : undefined) ?? module['default']
  if (typeof candidate !== 'function') {
    throw new ModelError('model_unsupported', `${sdkPackage} does not export GoogleGenAI`)
  }
  return candidate as GoogleClientConstructor
}

function normalizeUsage(metadata: Rec | undefined): Rec | null {
  if (metadata === undefined) return null
  const prompt = metadata['promptTokenCount']
  const completion = metadata['candidatesTokenCount']
  if (typeof prompt !== 'number' && typeof completion !== 'number') return null
  const promptTokens = typeof prompt === 'number' ? prompt : 0
  const completionTokens = typeof completion === 'number' ? completion : 0
  const usage: Rec = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof metadata['totalTokenCount'] === 'number' ? metadata['totalTokenCount'] : promptTokens + completionTokens,
  }
  if (typeof metadata['cachedContentTokenCount'] === 'number') {
    usage['cached_content_tokens'] = metadata['cachedContentTokenCount'] as number
  }
  return usage
}

/** 工具调用 arguments：中性形状是对象；字符串则尝试解析。 */
function toolArguments(value: Json | undefined): Json {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Json
    } catch {
      return { input: value }
    }
  }
  return isRecord(value) ? value : {}
}

/** 工具结果载荷：能解析成对象就原样，其余包成 `{result}`（Gemini functionResponse.response 要求对象）。 */
function toolResponsePayload(content: Json | undefined): Json {
  const raw = typeof content === 'string' ? content : content === undefined ? '' : JSON.stringify(content)
  try {
    const parsed = JSON.parse(raw) as Json
    if (isRecord(parsed)) return parsed
    return { result: parsed }
  } catch {
    return { result: raw }
  }
}

/** 回传的思考 parts：文本按 thought 标记，签名附到首个 functionCall part（Gemini 3 的绑定位置）。 */
function reasoningParts(blocks: ReasoningBlock[]): { parts: Json[]; signature: string } {
  const parts: Json[] = []
  let signature = ''
  for (const block of blocks) {
    if (block.payload.length > 0) parts.push({ text: block.payload, thought: true })
    const opaque = block.signature.length > 0 ? block.signature : block.encrypted
    if (opaque.length > 0) signature = opaque
  }
  return { parts, signature }
}

interface ContentContext {
  capability: ReasoningCapability
  provider: string
  model: string
}

/** messages -> Gemini contents：assistant 的 tool_calls 编成 functionCall part、tool 结果编成 functionResponse part。 */
function toContents(messages: Json[], ctx: ContentContext): Json[] {
  const contents: Json[] = []
  const callNames = new Map<string, string>()
  for (const message of messages) {
    if (!isRecord(message) || message['role'] === 'system') continue
    const role = message['role']
    if (role === 'assistant') {
      const parts: Json[] = []
      const text = typeof message['content'] === 'string' ? message['content'] : ''
      if (ctx.capability.replay_form === 'parts') {
        const replay = replayableBlocks(readReasoningBlocks(message), ctx.capability, ctx.provider, ctx.model)
        const replayed = reasoningParts(replay)
        parts.push(...replayed.parts)
        pushAssistantCalls(parts, message['tool_calls'], callNames)
        attachSignature(parts, replayed.signature)
      } else {
        pushAssistantCalls(parts, message['tool_calls'], callNames)
      }
      if (text.length > 0) parts.unshift({ text })
      if (parts.length === 0) parts.push({ text: '' })
      contents.push({ role: 'model', parts })
      continue
    }
    if (role === 'tool') {
      const id = typeof message['tool_call_id'] === 'string' ? (message['tool_call_id'] as string) : ''
      const name = callNames.get(id) ?? ''
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: toolResponsePayload(message['content']) } }] })
      continue
    }
    contents.push({ role: 'user', parts: [{ text: typeof message['content'] === 'string' ? message['content'] : '' }] })
  }
  return contents
}

function pushAssistantCalls(parts: Json[], raw: Json | undefined, callNames: Map<string, string>): void {
  if (!Array.isArray(raw)) return
  for (const item of raw) {
    const call = asRecord(item)
    if (call === null) continue
    const name = typeof call['name'] === 'string' ? (call['name'] as string) : ''
    if (typeof call['id'] === 'string') callNames.set(call['id'] as string, name)
    parts.push({ functionCall: { name, args: toolArguments(call['arguments']) } })
  }
}

function attachSignature(parts: Json[], signature: string): void {
  if (signature.length === 0) return
  for (const part of parts) {
    if (isRecord(part) && isRecord(part['functionCall'])) {
      part['thoughtSignature'] = signature
      return
    }
  }
}

function systemInstruction(messages: Json[]): string | null {
  const parts: string[] = []
  for (const message of messages) {
    if (isRecord(message) && message['role'] === 'system' && typeof message['content'] === 'string') {
      parts.push(message['content'])
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}

function buildConfig(params: Rec, quirks: Quirks, messages: Json[], capability: ReasoningCapability): Rec {
  const config: Rec = {}
  if (typeof params['temperature'] === 'number') config['temperature'] = params['temperature']
  if (typeof params['max_tokens'] === 'number') config[quirks.max_tokens_field] = params['max_tokens']
  if (sendsReasoningParam(capability)) {
    const reasoning = encodeReasoning(quirks, params['reasoning'])
    if (reasoning !== null) setByPath(config, reasoning.path, reasoning.value)
  }
  const system = systemInstruction(messages)
  if (system !== null) config['systemInstruction'] = system
  return config
}

/** 从候选 parts 取归一化部件：文本（含 thought 标记）、functionCall、thoughtSignature。 */
interface CandidateScan {
  text: string
  reasoning: string
  signature: string
  calls: { name: string; args: Json }[]
  sawParts: boolean
}

function scanCandidates(source: { candidates?: Json[] }): CandidateScan {
  const scan: CandidateScan = { text: '', reasoning: '', signature: '', calls: [], sawParts: false }
  const candidates = source.candidates
  if (!Array.isArray(candidates)) return scan
  const candidate = asRecord(candidates[0])
  if (candidate === null) return scan
  const content = asRecord(candidate['content'])
  if (content === null) return scan
  const parts = content['parts']
  if (!Array.isArray(parts)) return scan
  scan.sawParts = true
  for (const raw of parts) {
    const part = asRecord(raw)
    if (part === null) continue
    const signature = stringField(part, 'thoughtSignature')
    if (signature !== undefined) scan.signature = signature
    const text = stringField(part, 'text')
    if (text !== undefined) {
      if (part['thought'] === true) scan.reasoning += text
      else scan.text += text
    }
    const call = asRecord(part['functionCall'])
    if (call !== null) {
      const name = typeof call['name'] === 'string' ? (call['name'] as string) : ''
      scan.calls.push({ name, args: toolArguments(call['args']) })
    }
  }
  return scan
}

export interface SdkCallInput {
  sdk_package: string | null
  api_key: string
  provider: string
  model: string
  messages: Json[]
  params: Rec
  quirks: Quirks
  capability: ReasoningCapability
}

function contentContext(input: SdkCallInput): ContentContext {
  return { capability: input.capability, provider: input.provider, model: input.model }
}

function reasoningBlockOf(scan: CandidateScan, input: SdkCallInput): ReasoningBlock | null {
  if (scan.reasoning.length === 0 && scan.signature.length === 0) return null
  return reasoningBlock(input.provider, input.model, 'blocks', scan.reasoning, scan.signature)
}

/** 流式补全：逐块回调分片，返回最终值。 */
export async function googleChat(
  input: SdkCallInput,
  onDelta: (fragment: Rec) => void,
): Promise<ModelOutput> {
  const Constructor = await loadGoogleSdk(input.sdk_package)
  try {
    const client = new Constructor({ apiKey: input.api_key })
    const params: Rec = {
      model: input.model,
      contents: toContents(input.messages, contentContext(input)),
      config: buildConfig(input.params, input.quirks, input.messages, input.capability),
    }
    const stream = await client.models.generateContentStream(params)
    const acc = new StreamAccumulator()
    let usage: Rec | null = null
    let reasoning = ''
    let signature = ''
    for await (const chunk of stream) {
      const scan = scanCandidates(chunk)
      if (scan.sawParts) {
        if (scan.text.length > 0) applyFragment(acc, { text: scan.text }, onDelta)
        if (scan.reasoning.length > 0) {
          reasoning += scan.reasoning
          applyFragment(acc, { reasoning: scan.reasoning }, onDelta)
        }
        if (scan.signature.length > 0) signature = scan.signature
        scan.calls.forEach((call, index) => {
          applyFragment(acc, { tool_call: { index, name: call.name, arguments_delta: JSON.stringify(call.args) } }, onDelta)
        })
      } else {
        if (typeof chunk.text === 'string') applyFragment(acc, { text: chunk.text }, onDelta)
        if (Array.isArray(chunk.functionCalls)) {
          chunk.functionCalls.forEach((raw, index) => {
            const call = isRecord(raw) ? raw : {}
            const name = typeof call['name'] === 'string' ? (call['name'] as string) : undefined
            applyFragment(acc, { tool_call: { index, name, arguments_delta: JSON.stringify(call['args'] ?? {}) } }, onDelta)
          })
        }
      }
      usage = normalizeUsage(chunk.usageMetadata) ?? usage
    }
    // SDK 流以迭代结束为终止标记：补一条 done，消费方与三协议路径同规收口
    onDelta({ done: true })
    const output: ModelOutput = {
      text: acc.text,
      tool_calls: acc.toolCalls() as unknown as Json[],
      usage,
    }
    if (reasoning.length > 0) output.reasoning = reasoning
    if (reasoning.length > 0 || signature.length > 0) {
      output.reasoning_blocks = [reasoningBlock(input.provider, input.model, 'blocks', reasoning, signature)]
    }
    const stop = acc.stopReasonValue
    if (stop !== null) output.stop_reason = stop
    return output
  } catch (err) {
    throw mapSdkError(err)
  }
}

function applyFragment(acc: StreamAccumulator, shard: Parameters<StreamAccumulator['apply']>[0], onDelta: (fragment: Rec) => void): void {
  const fragment = acc.apply(shard)
  if (fragment !== null) onDelta(fragment)
}

/** 非流式补全：返回 {text, usage}。 */
export async function googleComplete(input: SdkCallInput): Promise<ModelOutput> {
  const Constructor = await loadGoogleSdk(input.sdk_package)
  try {
    const client = new Constructor({ apiKey: input.api_key })
    const params: Rec = {
      model: input.model,
      contents: toContents(input.messages, contentContext(input)),
      config: buildConfig(input.params, input.quirks, input.messages, input.capability),
    }
    const response = await client.models.generateContent(params)
    const scan = scanCandidates(response)
    const calls: Json[] = scan.sawParts
      ? scan.calls.map((call) => ({ id: null, name: call.name, arguments: call.args }))
      : Array.isArray(response.functionCalls)
        ? response.functionCalls.map((raw) => {
            const call = isRecord(raw) ? raw : {}
            return { id: null, name: call['name'] ?? null, arguments: call['args'] ?? {} }
          })
        : []
    const output: ModelOutput = {
      text: scan.sawParts ? scan.text : typeof response.text === 'string' ? response.text : '',
      tool_calls: calls,
      usage: normalizeUsage(response.usageMetadata),
    }
    const block = reasoningBlockOf(scan, input)
    if (block !== null) {
      output.reasoning = scan.reasoning
      output.reasoning_blocks = [block]
    }
    return output
  } catch (err) {
    throw mapSdkError(err)
  }
}
