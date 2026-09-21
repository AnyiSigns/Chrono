// SDK 适配器（v1 仅 @google/genai）：惰性 import，包缺失 / 加载失败 -> model_unsupported。
// SDK 包是本插件自己的 npm 依赖（package.json + lockfile 钉版本）；世界只存 quirks.sdk_package 这个名字。
// 鉴权交 SDK 构造参数（apiKey）；`CHRONO_MODEL_SDK_MODULE` 是测试注入伪模块的接缝，缺省用真实包名。

import { ModelError } from './errors.ts'
import { encodeReasoning, setByPath } from './quirks.ts'
import type { Quirks } from './quirks.ts'
import { StreamAccumulator } from './stream.ts'
import type { Json, Rec } from './types.ts'
import type { ModelOutput } from './adapters.ts'

const SUPPORTED_SDK = '@google/genai'

export interface GoogleChunk {
  text?: string
  usageMetadata?: Rec
  functionCalls?: Json[]
}

export interface GoogleResponse {
  text?: string
  usageMetadata?: Rec
  functionCalls?: Json[]
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
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: typeof metadata['totalTokenCount'] === 'number' ? metadata['totalTokenCount'] : promptTokens + completionTokens,
  }
}

function toContents(messages: Json[]): Json[] {
  const contents: Json[] = []
  for (const message of messages) {
    if (!isRecord(message) || message['role'] === 'system') continue
    const role = message['role'] === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: [{ text: typeof message['content'] === 'string' ? message['content'] : '' }] })
  }
  return contents
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

function buildConfig(params: Rec, quirks: Quirks, messages: Json[]): Rec {
  const config: Rec = {}
  if (typeof params['temperature'] === 'number') config['temperature'] = params['temperature']
  if (typeof params['max_tokens'] === 'number') config[quirks.max_tokens_field] = params['max_tokens']
  const reasoning = encodeReasoning(quirks, params['reasoning'])
  if (reasoning !== null) setByPath(config, reasoning.path, reasoning.value)
  const system = systemInstruction(messages)
  if (system !== null) config['systemInstruction'] = system
  return config
}

export interface SdkCallInput {
  sdk_package: string | null
  api_key: string
  model: string
  messages: Json[]
  params: Rec
  quirks: Quirks
}

/** 流式补全：逐块回调分片，返回最终值。 */
export async function googleChat(
  input: SdkCallInput,
  onDelta: (fragment: Rec) => void,
): Promise<ModelOutput> {
  const Constructor = await loadGoogleSdk(input.sdk_package)
  try {
    const client = new Constructor({ apiKey: input.api_key })
    const params: Rec = { model: input.model, contents: toContents(input.messages), config: buildConfig(input.params, input.quirks, input.messages) }
    const stream = await client.models.generateContentStream(params)
    const acc = new StreamAccumulator()
    let usage: Rec | null = null
    for await (const chunk of stream) {
      const text = typeof chunk.text === 'string' ? chunk.text : undefined
      const fragment = acc.apply(text === undefined ? {} : { text })
      if (fragment !== null) onDelta(fragment)
      if (Array.isArray(chunk.functionCalls)) {
        chunk.functionCalls.forEach((call, index) => {
          const record = isRecord(call) ? call : {}
          const args = JSON.stringify(record['args'] ?? {})
          const callFragment = acc.apply({
            tool_call: { index, name: typeof record['name'] === 'string' ? record['name'] : undefined, arguments_delta: args },
          })
          if (callFragment !== null) onDelta(callFragment)
        })
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
    const reasoning = acc.reasoning
    if (reasoning.length > 0) output.reasoning = reasoning
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
    const params: Rec = { model: input.model, contents: toContents(input.messages), config: buildConfig(input.params, input.quirks, input.messages) }
    const response = await client.models.generateContent(params)
    const calls: Json[] = Array.isArray(response.functionCalls)
      ? response.functionCalls.map((call) => {
          const record = isRecord(call) ? call : {}
          return { id: null, name: record['name'] ?? null, arguments: record['args'] ?? {} }
        })
      : []
    return {
      text: typeof response.text === 'string' ? response.text : '',
      tool_calls: calls,
      usage: normalizeUsage(response.usageMetadata),
    }
  } catch (err) {
    throw mapSdkError(err)
  }
}
