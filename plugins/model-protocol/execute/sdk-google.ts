// SDK 适配器（v1 仅 @google/genai）：惰性 import，包缺失 / 加载失败 -> model_unsupported。
// SDK 请求**参数编形**在 `msg-dialect`（属方言）；本模块只发起调用并做**流式扫描**与整包扫描。
// 鉴权交 SDK 构造参数（apiKey）；`CHRONO_MODEL_SDK_MODULE` 是测试注入伪模块的接缝，缺省用真实包名。

import { ModelError } from './errors.ts'
import {
  asRecord,
  normalizeUsage,
  reasoningBlock,
  stringField,
  StreamAccumulator,
} from './stream.ts'
import type { ReasoningBlock } from './stream.ts'
import type { ModelOutput } from './adapters.ts'
import type { Json, Rec } from 'plugin-sdk'

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
    generateContentStream(
      params: Rec,
    ): Promise<AsyncIterable<GoogleChunk>> | AsyncIterable<GoogleChunk>
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
    throw new ModelError(
      'model_unsupported',
      `cannot load ${sdkPackage}: ${(err as Error).message}`,
    )
  }
  const module = isRecord(loaded) ? loaded : {}
  const candidate =
    module['GoogleGenAI'] ??
    (isRecord(module['default']) ? module['default']['GoogleGenAI'] : undefined) ??
    module['default']
  if (typeof candidate !== 'function') {
    throw new ModelError('model_unsupported', `${sdkPackage} does not export GoogleGenAI`)
  }
  return candidate as GoogleClientConstructor
}

/** Google usageMetadata 归一（含 totalTokenCount / cachedContentTokenCount）。 */
function normalizeGoogleUsage(metadata: Rec | undefined): Rec | null {
  if (metadata === undefined) return null
  const prompt = metadata['promptTokenCount']
  const completion = metadata['candidatesTokenCount']
  if (typeof prompt !== 'number' && typeof completion !== 'number') return null
  const promptTokens = typeof prompt === 'number' ? prompt : 0
  const completionTokens = typeof completion === 'number' ? completion : 0
  const usage: Rec = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      typeof metadata['totalTokenCount'] === 'number'
        ? metadata['totalTokenCount']
        : promptTokens + completionTokens,
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
  /** 由 `msg-dialect.build` 编好的 SDK 参数（model / contents / config）。 */
  sdk_params: Rec
}

function reasoningBlockOf(scan: CandidateScan, input: SdkCallInput): ReasoningBlock | null {
  if (scan.reasoning.length === 0 && scan.signature.length === 0) return null
  return reasoningBlock(input.provider, input.model, 'blocks', scan.reasoning, scan.signature)
}

function applyFragment(
  acc: StreamAccumulator,
  shard: Parameters<StreamAccumulator['apply']>[0],
  onDelta: (fragment: Rec) => void,
): void {
  const fragment = acc.apply(shard)
  if (fragment !== null) onDelta(fragment)
}

/** 流式补全：逐块回调分片，返回最终值。 */
export async function googleChat(
  input: SdkCallInput,
  onDelta: (fragment: Rec) => void,
): Promise<ModelOutput> {
  const Constructor = await loadGoogleSdk(input.sdk_package)
  try {
    const client = new Constructor({ apiKey: input.api_key })
    const stream = await client.models.generateContentStream(input.sdk_params)
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
          applyFragment(
            acc,
            { tool_call: { index, name: call.name, arguments_delta: JSON.stringify(call.args) } },
            onDelta,
          )
        })
      } else {
        if (typeof chunk.text === 'string') applyFragment(acc, { text: chunk.text }, onDelta)
        if (Array.isArray(chunk.functionCalls)) {
          chunk.functionCalls.forEach((raw, index) => {
            const call = isRecord(raw) ? raw : {}
            const name = typeof call['name'] === 'string' ? (call['name'] as string) : undefined
            applyFragment(
              acc,
              { tool_call: { index, name, arguments_delta: JSON.stringify(call['args'] ?? {}) } },
              onDelta,
            )
          })
        }
      }
      usage = normalizeGoogleUsage(chunk.usageMetadata) ?? usage
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
      output.reasoning_blocks = [
        reasoningBlock(input.provider, input.model, 'blocks', reasoning, signature),
      ]
    }
    const stop = acc.stopReasonValue
    if (stop !== null) output.stop_reason = stop
    return output
  } catch (err) {
    throw mapSdkError(err)
  }
}

/** 非流式补全：返回 {text, usage}。 */
export async function googleComplete(input: SdkCallInput): Promise<ModelOutput> {
  const Constructor = await loadGoogleSdk(input.sdk_package)
  try {
    const client = new Constructor({ apiKey: input.api_key })
    const response = await client.models.generateContent(input.sdk_params)
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
      usage: normalizeGoogleUsage(response.usageMetadata),
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
