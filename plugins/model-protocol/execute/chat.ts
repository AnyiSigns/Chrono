// chat / complete：唯一模型调用路径的编排层。
// 取密钥（反向调 secrets.resolve，明文只存本进程内存）-> 按 impl 分派有界适配器（protocol×3 / sdk）
// -> 韧性重试 -> 流式逐段发 model.delta（run / thread 自帧 env）-> 返回最终值（含 usage / tool_calls）。
// 非幂等、永不缓存；不读投影、不写世界；世界 / 结果 / args 不取时间随机（重试等待与可选抖动只影响时延）。

import { getAdapter } from './adapters.ts'
import type { ModelOutput, RequestContext } from './adapters.ts'
import { ModelError, errorValue } from './errors.ts'
import { httpRequest, httpStream } from './http.ts'
import { isRecord } from './plan.ts'
import { authRefOf } from './port-link.ts'
import type { PortLink } from './port-link.ts'
import { normalizeQuirks } from './quirks.ts'
import type { Quirks } from './quirks.ts'
import { RateLimiter, resolvePolicy, withRetry } from './resilience.ts'
import type { RetryPolicy } from './resilience.ts'
import { createSseParser, StreamAccumulator } from './stream.ts'
import { googleChat, googleComplete } from './sdk-google.ts'
import type { SdkCallInput } from './sdk-google.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

export interface ChatDeps {
  secrets: PortLink
  limiter: RateLimiter
  emit: (topic: string, payload: Json) => void
}

interface ParsedChat {
  base_url: string
  model: string
  messages: Json[]
  params: Rec
  quirks: Quirks
  authRef: Rec | null
  tools: Json | undefined
  tool_choice: Json | undefined
  provider: string
  resilience: Json | undefined
}

/** 从 bag 解析连接 / 模型 / 消息 / 怪癖；缺必需字段抛 bad_args。 */
export function parseChatBag(bag: Json): ParsedChat {
  if (!isRecord(bag)) throw new BadArgsError('bag must be an object')
  const config = bag['config']
  if (!isRecord(config)) throw new BadArgsError('bag.config required')
  const baseUrl = config['base_url']
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new BadArgsError('config.base_url required')
  const model = config['model']
  if (typeof model !== 'string' || model.length === 0) throw new BadArgsError('config.model required')
  const messages = bag['messages'] ?? config['messages']
  if (!Array.isArray(messages)) throw new BadArgsError('bag.messages must be an array')
  const protocolOverride = typeof config['protocol'] === 'string' ? (config['protocol'] as string) : null
  const provider = typeof config['vendor'] === 'string' ? (config['vendor'] as string) : model
  return {
    base_url: baseUrl,
    model,
    messages,
    params: isRecord(config['params']) ? (config['params'] as Rec) : {},
    quirks: normalizeQuirks(config['quirks'], protocolOverride),
    authRef: authRefOf(config),
    tools: bag['tools'],
    tool_choice: bag['tool_choice'],
    provider,
    resilience: bag['resilience'],
  }
}

/** 解析密钥：失败作数据（结构化错误码原样回灌）。 */
async function resolveSecret(parsed: ParsedChat, secrets: PortLink): Promise<string | null> {
  if (parsed.authRef === null) return null
  const outcome = await secrets.call('secrets', 'resolve', { auth_ref: parsed.authRef })
  if (!outcome.ok) throw new ModelError('model_auth_failed', `secret resolve failed: ${outcome.code}`)
  if (typeof outcome.value !== 'string' || outcome.value.length === 0) {
    throw new ModelError('model_auth_failed', 'secret resolve returned no value')
  }
  return outcome.value
}

function requestContext(parsed: ParsedChat, secret: string | null, stream: boolean): RequestContext {
  return {
    base_url: parsed.base_url,
    model: parsed.model,
    messages: parsed.messages,
    params: parsed.params,
    quirks: parsed.quirks,
    secret,
    stream,
    tools: parsed.tools,
    tool_choice: parsed.tool_choice,
  }
}

/** 跨重试分片去重：同一前缀只上行一次（流断整请求重试时不重不漏）。 */
class DeltaGate {
  private emittedText = 0
  private emittedReasoning = 0
  private readonly emittedArgs = new Map<number, number>()
  private readonly emittedMeta = new Set<number>()
  private attemptText = 0
  private attemptReasoning = 0
  private attemptArgs = new Map<number, number>()

  private readonly push: (fragment: Rec) => void

  constructor(push: (fragment: Rec) => void) {
    this.push = push
  }

  beginAttempt(): void {
    if (this.emittedText > 0 || this.emittedReasoning > 0 || this.emittedArgs.size > 0 || this.emittedMeta.size > 0) {
      // 流断整请求重试：先上行 reset 让消费方丢弃已累积分片，再重放新流（不重不漏）。
      this.push({ reset: true })
      this.emittedText = 0
      this.emittedReasoning = 0
      this.emittedArgs.clear()
      this.emittedMeta.clear()
    }
    this.attemptText = 0
    this.attemptReasoning = 0
    this.attemptArgs = new Map()
  }

  accept(fragment: Rec): void {
    const filtered: Rec = {}
    this.acceptText(fragment, filtered)
    this.acceptReasoning(fragment, filtered)
    this.acceptToolCall(fragment, filtered)
    if (fragment['usage'] !== undefined) filtered['usage'] = fragment['usage']
    if (fragment['stop_reason'] !== undefined) filtered['stop_reason'] = fragment['stop_reason']
    if (fragment['done'] !== undefined) filtered['done'] = fragment['done']
    if (Object.keys(filtered).length > 0) this.push(filtered)
  }

  private acceptText(fragment: Rec, filtered: Rec): void {
    const text = fragment['text']
    if (typeof text !== 'string' || text.length === 0) return
    const cumulative = this.attemptText + text.length
    this.attemptText = cumulative
    if (cumulative <= this.emittedText) return
    const start = Math.max(0, this.emittedText - (cumulative - text.length))
    filtered['text'] = text.slice(start)
    this.emittedText = cumulative
  }

  private acceptReasoning(fragment: Rec, filtered: Rec): void {
    const reasoning = fragment['reasoning']
    if (typeof reasoning !== 'string' || reasoning.length === 0) return
    const cumulative = this.attemptReasoning + reasoning.length
    this.attemptReasoning = cumulative
    if (cumulative <= this.emittedReasoning) return
    const start = Math.max(0, this.emittedReasoning - (cumulative - reasoning.length))
    filtered['reasoning'] = reasoning.slice(start)
    this.emittedReasoning = cumulative
  }

  private acceptToolCall(fragment: Rec, filtered: Rec): void {
    const call = fragment['tool_call']
    if (!isRecord(call)) return
    const index = typeof call['index'] === 'number' ? call['index'] : 0
    const emitted: Rec = { index }
    if ((call['id'] !== undefined || call['name'] !== undefined) && !this.emittedMeta.has(index)) {
      this.emittedMeta.add(index)
      if (call['id'] !== undefined) emitted['id'] = call['id']
      if (call['name'] !== undefined) emitted['name'] = call['name']
    }
    const delta = call['arguments_delta']
    if (typeof delta === 'string' && delta.length > 0) {
      const attemptCum = (this.attemptArgs.get(index) ?? 0) + delta.length
      this.attemptArgs.set(index, attemptCum)
      const already = this.emittedArgs.get(index) ?? 0
      if (attemptCum > already) {
        emitted['arguments_delta'] = delta.slice(Math.max(0, already - (attemptCum - delta.length)))
        this.emittedArgs.set(index, attemptCum)
      }
    }
    if (Object.keys(emitted).length > 1) filtered['tool_call'] = emitted
  }
}

function protocolLabel(parsed: ParsedChat): string {
  return parsed.quirks.impl === 'sdk' ? 'sdk' : parsed.quirks.protocol
}

function outputValue(output: ModelOutput, parsed: ParsedChat, includeReasoning: boolean): Rec {
  const value: Rec = {
    ok: true,
    text: output.text,
    tool_calls: output.tool_calls,
    usage: output.usage,
    model: parsed.model,
    protocol: protocolLabel(parsed),
  }
  if (includeReasoning && output.reasoning !== undefined) value['reasoning'] = output.reasoning
  if (output.stop_reason !== undefined) value['stop_reason'] = output.stop_reason
  return value
}

/** 一次流式尝试：打开 SSE、逐段解析、经门去重后上行。 */
async function streamAttempt(
  adapter: ReturnType<typeof getAdapter>,
  ctx: RequestContext,
  policy: RetryPolicy,
  gate: DeltaGate,
  now: number,
): Promise<ModelOutput> {
  gate.beginAttempt()
  const built = adapter.build(ctx)
  const response = await httpStream({
    method: 'POST',
    url: built.url,
    headers: built.headers,
    body: JSON.stringify(built.body),
    timeout_ms: policy.request_timeout_ms,
    now,
  })
  const accumulator = new StreamAccumulator()
  const parser = createSseParser()
  let sawTerminal = false
  for await (const chunk of response.chunks) {
    for (const data of parser.push(chunk)) {
      const fragments = adapter.handleStreamData(data, accumulator)
      for (const fragment of fragments) {
        if (fragment['done'] === true) sawTerminal = true
        gate.accept(fragment)
      }
    }
  }
  if (!sawTerminal) throw new ModelError('model_stream_broken', 'stream ended without terminal', { retryable: true })
  const output: ModelOutput = {
    text: accumulator.text,
    tool_calls: accumulator.toolCalls() as unknown as Json[],
    usage: accumulator.usageValue,
  }
  if (accumulator.reasoning.length > 0) output.reasoning = accumulator.reasoning
  const stop = accumulator.stopReasonValue
  if (stop !== null) output.stop_reason = stop
  return output
}

/** 一次非流式尝试：单次 HTTP，解析完整响应。 */
async function fullAttempt(
  adapter: ReturnType<typeof getAdapter>,
  ctx: RequestContext,
  policy: RetryPolicy,
  now: number,
): Promise<ModelOutput> {
  const built = adapter.build(ctx)
  const response = await httpRequest({
    method: 'POST',
    url: built.url,
    headers: built.headers,
    body: JSON.stringify(built.body),
    timeout_ms: policy.request_timeout_ms,
    now,
  })
  let json: Json
  try {
    json = JSON.parse(response.body) as Json
  } catch (err) {
    throw new ModelError('model_unsupported', `invalid response body: ${(err as Error).message}`)
  }
  return adapter.parseFull(json)
}

function sdkInput(parsed: ParsedChat, secret: string | null): SdkCallInput {
  return {
    sdk_package: parsed.quirks.sdk_package,
    api_key: secret ?? '',
    model: parsed.model,
    messages: parsed.messages,
    params: parsed.params,
    quirks: parsed.quirks,
  }
}

/** chat：流式（impl=sdk 走 SDK 适配器，impl=protocol 走三协议适配器）。 */
export async function chat(deps: ChatDeps, bag: Json, env: CallEnv): Promise<Json> {
  let parsed: ParsedChat
  try {
    parsed = parseChatBag(bag)
  } catch (err) {
    throw err instanceof BadArgsError ? err : new BadArgsError((err as Error).message)
  }
  try {
    const secret = await resolveSecret(parsed, deps.secrets)
    const policy = resolvePolicy(parsed.resilience)
    // impl=sdk 与三协议同规：每次 attempt 新建适配器 / 经同一 DeltaGate 去重（重试先上行 reset）
    if (parsed.quirks.impl === 'sdk') {
      const gate = new DeltaGate((fragment) => emitDelta(deps, parsed, env, fragment))
      const output = await withRetry(
        parsed.provider,
        () => {
          gate.beginAttempt()
          return googleChat(sdkInput(parsed, secret), (fragment) => gate.accept(fragment))
        },
        { policy, limiter: deps.limiter, now: env.now },
      )
      return outputValue(output, parsed, true)
    }
    const ctx = requestContext(parsed, secret, true)
    const gate = new DeltaGate((fragment) => emitDelta(deps, parsed, env, fragment))
    const output = await withRetry(
      parsed.provider,
      () => streamAttempt(getAdapter(parsed.quirks.protocol, parsed.quirks), ctx, policy, gate, env.now),
      { policy, limiter: deps.limiter, now: env.now },
    )
    return outputValue(output, parsed, true)
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

/** complete：非流式单次补全，不发 model.delta；其余（密钥 / 韧性）同 chat。 */
export async function complete(deps: ChatDeps, bag: Json, env: CallEnv): Promise<Json> {
  const parsed = parseChatBag(bag)
  try {
    const secret = await resolveSecret(parsed, deps.secrets)
    const policy = resolvePolicy(parsed.resilience)
    const output =
      parsed.quirks.impl === 'sdk'
        ? await withRetry(parsed.provider, () => googleComplete(sdkInput(parsed, secret)), { policy, limiter: deps.limiter, now: env.now })
        : await withRetry(parsed.provider, () => fullAttempt(getAdapter(parsed.quirks.protocol, parsed.quirks), requestContext(parsed, secret, false), policy, env.now), { policy, limiter: deps.limiter, now: env.now })
    return { ok: true, text: output.text, usage: output.usage }
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

function emitDelta(deps: ChatDeps, parsed: ParsedChat, env: CallEnv, fragment: Rec): void {
  deps.emit('model.delta', {
    run: env.run,
    thread: env.thread,
    model: parsed.model,
    protocol: protocolLabel(parsed),
    ...fragment,
  })
}
