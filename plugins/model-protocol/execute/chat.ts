// chat / complete：唯一模型调用路径的编排层。
// 取密钥（反向调 secrets.resolve，明文只存本进程内存）-> 经 msg-dialect 编请求（build）/ 资产内联 ->
// 韧性重试（throttle 决策）-> 流式逐段发 model.delta（本插件自持 http / SSE 传输与逐段解码）->
// 返回最终值（含 usage / tool_calls）。非幂等、永不缓存；不读投影、不写世界；不自取时间。
// 逐段流式解码留本插件：跨插件 port.call 不能传流式回调 / AsyncIterable。

import { getStreamDecoder } from './adapters.ts'
import type { ModelOutput } from './adapters.ts'
import { DialectClient } from './dialect-link.ts'
import type { DialectQuirks } from './dialect-link.ts'
import { ModelError, classifyHttpStatus, errorValue, parseRetryAfter } from './errors.ts'
import { httpRequest, httpStream } from './http.ts'
import { authRefOf, isRecord } from './plan.ts'
import { fetchPolicy, portThrottle, withRetry } from './resilience.ts'
import type { RetryPolicy } from './resilience.ts'
import { createSseParser, reasoningBlock, StreamAccumulator } from './stream.ts'
import { googleChat, googleComplete } from './sdk-google.ts'
import type { SdkCallInput } from './sdk-google.ts'
import {
  applyQuirksRepairs,
  applyRequestRepairs,
  nextRepairs,
  rememberRepairs,
  repairKey,
  repairsFor,
} from './quirk-repair.ts'
import type { RepairKind } from './quirk-repair.ts'
import { capabilityWithRepairs, protocolLabel } from './downgrade.ts'
import { BadArgsError } from 'plugin-sdk'
import type { CallEnv, Json, PortCaller, Rec } from 'plugin-sdk'

export interface ChatDeps {
  secrets: PortCaller
  throttle: PortCaller
  dialect: PortCaller
  emit: (topic: string, payload: Json) => void
}

interface ParsedChat {
  base_url: string
  model: string
  messages: Json[]
  params: Rec
  quirksRaw: Json | undefined
  protocolOverride: string | null
  capabilityProfile: Json | undefined
  cache: Rec | undefined
  authRef: Rec | null
  tools: Json | undefined
  tool_choice: Json | undefined
  provider: string
  resilience: Json | undefined
  /** 本次调用所属回合 id（缺省 null）：用于把在途 HTTP 请求登记进可中止表。 */
  turn_id: string | null
}

/** 调用方在 config 上显式给出的推理能力表（优先于协议 / 厂商默认）。 */
function profileCapabilityOf(config: Rec): Json | undefined {
  return isRecord(config['reasoning_capability']) ? config['reasoning_capability'] : undefined
}

/** 4xx 归类：把响应体片段并入消息，供字段协商判定（截断，避免超长）。 */
function classifyWithSnippet(status: number, headers: Rec, body: string, now: number): Error {
  const retryAfterMs = parseRetryAfter(headers as Record<string, string>, now)
  const base = classifyHttpStatus(status, retryAfterMs) ?? new Error('unexpected status')
  if (base instanceof ModelError && status >= 400 && status < 500) {
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (snippet.length > 0) {
      return new ModelError(base.code, `${base.message}: ${snippet}`, {
        retryable: base.retryable,
        retryAfterMs: base.retryAfterMs,
      })
    }
  }
  return base
}

/** 每次调用最多新增的字段退让次数（点名字段 + 梯队探测合计）。 */
const MAX_REPAIRS_PER_CALL = 3

/**
 * 4xx 字段协商：按已记忆的退让（baseline）+ 本次探测（trial）改写请求重试。
 * 只有真正跑通的 trial 才写入记忆——盲试不成功不会让该端点被永久降级。
 * 非 `model_bad_request` / 无档可退 / 超过限次 → 原样抛出，由上层作数据回灌。
 */
async function negotiateOutput(
  key: string,
  parsed: ParsedChat,
  quirks: DialectQuirks,
  attempt: (
    effective: ParsedChat,
    effectiveQuirks: DialectQuirks,
    applied: ReadonlySet<RepairKind>,
  ) => Promise<ModelOutput>,
): Promise<ModelOutput> {
  const baseline = repairsFor(key)
  const trial = new Set<RepairKind>()
  for (let probe = 0; ; probe += 1) {
    const applied = new Set<RepairKind>([...baseline, ...trial])
    const effective = { ...parsed, ...applyRequestRepairs(parsed, applied) }
    const effectiveQuirks = applyQuirksRepairs(quirks, applied)
    try {
      const output = await attempt(effective, effectiveQuirks, applied)
      if (trial.size > 0) rememberRepairs(key, [...trial])
      return output
    } catch (err) {
      if (
        !(err instanceof ModelError) ||
        err.code !== 'model_bad_request' ||
        probe >= MAX_REPAIRS_PER_CALL
      ) {
        throw err
      }
      const next = nextRepairs(err.message, applied)
      if (next.length === 0) throw err
      for (const kind of next) trial.add(kind)
    }
  }
}

/** 缓存提示：厂商中立，只保留已知键；空对象视为未给。 */
function parseCache(value: Json | undefined): Rec | undefined {
  if (!isRecord(value)) return undefined
  const hint: Rec = {}
  if (Array.isArray(value['breakpoints'])) {
    hint['breakpoints'] = (value['breakpoints'] as Json[]).filter(
      (item): item is number => typeof item === 'number' && Number.isInteger(item),
    )
  }
  if (value['system'] === true) hint['system'] = true
  if (value['tools'] === true) hint['tools'] = true
  if (typeof value['key'] === 'string' && value['key'].length > 0)
    hint['key'] = value['key'] as string
  return Object.keys(hint).length === 0 ? undefined : hint
}

/** 从 bag 解析连接 / 模型 / 消息 / 怪癖原料 / 缓存提示；缺必需字段抛 bad_args。 */
export function parseChatBag(bag: Json): ParsedChat {
  if (!isRecord(bag)) throw new BadArgsError('bag must be an object')
  const config = bag['config']
  if (!isRecord(config)) throw new BadArgsError('bag.config required')
  const baseUrl = config['base_url']
  if (typeof baseUrl !== 'string' || baseUrl.length === 0)
    throw new BadArgsError('config.base_url required')
  const model = config['model']
  if (typeof model !== 'string' || model.length === 0)
    throw new BadArgsError('config.model required')
  const messages = bag['messages'] ?? config['messages']
  if (!Array.isArray(messages)) throw new BadArgsError('bag.messages must be an array')
  const protocolOverride =
    typeof config['protocol'] === 'string' ? (config['protocol'] as string) : null
  const provider = typeof config['vendor'] === 'string' ? (config['vendor'] as string) : model
  return {
    base_url: baseUrl,
    model,
    messages,
    params: isRecord(config['params']) ? (config['params'] as Rec) : {},
    quirksRaw: config['quirks'],
    protocolOverride,
    capabilityProfile: profileCapabilityOf(config),
    cache: parseCache(bag['cache']),
    authRef: authRefOf(config),
    tools: bag['tools'],
    tool_choice: bag['tool_choice'],
    provider,
    resilience: bag['resilience'],
    turn_id:
      typeof bag['turn_id'] === 'string' && bag['turn_id'].length > 0
        ? (bag['turn_id'] as string)
        : null,
  }
}

/** 解析密钥：失败作数据（结构化错误码原样回灌）。 */
async function resolveSecret(parsed: ParsedChat, secrets: PortCaller): Promise<string | null> {
  if (parsed.authRef === null) return null
  const outcome = await secrets.call('secrets', 'resolve', { auth_ref: parsed.authRef })
  if (!outcome.ok)
    throw new ModelError('model_auth_failed', `secret resolve failed: ${outcome.code}`)
  if (typeof outcome.value !== 'string' || outcome.value.length === 0) {
    throw new ModelError('model_auth_failed', 'secret resolve returned no value')
  }
  return outcome.value
}

/** 组装 `msg-dialect.build` 入参；空值字段省略以免误编进请求体。 */
function buildArgs(
  parsed: ParsedChat,
  quirks: DialectQuirks,
  secret: string | null,
  stream: boolean,
): Rec {
  const args: Rec = {
    quirks,
    provider: parsed.provider,
    base_url: parsed.base_url,
    model: parsed.model,
    messages: parsed.messages,
    params: parsed.params,
    secret,
    stream,
  }
  if (parsed.capabilityProfile !== undefined) args['capability_profile'] = parsed.capabilityProfile
  if (parsed.tools !== undefined) args['tools'] = parsed.tools
  if (parsed.tool_choice !== undefined) args['tool_choice'] = parsed.tool_choice
  if (parsed.cache !== undefined) args['cache'] = parsed.cache
  return args
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
    if (
      this.emittedText > 0 ||
      this.emittedReasoning > 0 ||
      this.emittedArgs.size > 0 ||
      this.emittedMeta.size > 0
    ) {
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

function outputValue(
  output: ModelOutput,
  parsed: ParsedChat,
  protocol: string,
  includeReasoning: boolean,
): Rec {
  const value: Rec = {
    ok: true,
    text: output.text,
    tool_calls: output.tool_calls,
    usage: output.usage,
    model: parsed.model,
    protocol,
  }
  if (includeReasoning && output.reasoning !== undefined) value['reasoning'] = output.reasoning
  if (
    includeReasoning &&
    output.reasoning_blocks !== undefined &&
    output.reasoning_blocks.length > 0
  ) {
    value['reasoning_blocks'] = output.reasoning_blocks as unknown as Json
  }
  if (output.stop_reason !== undefined) value['stop_reason'] = output.stop_reason
  return value
}

/** 流式最终值的中立推理块：适配器给了就用，没有则由推理文本兜底成一块。 */
function streamReasoningBlocks(
  accumulator: StreamAccumulator,
  provider: string,
  model: string,
): Json[] {
  const blocks = accumulator.reasoningBlocksValue
  if (blocks.length > 0) return blocks as unknown as Json[]
  if (accumulator.reasoning.length === 0) return []
  return [reasoningBlock(provider, model, 'text', accumulator.reasoning) as unknown as Json]
}

/** 一次流式尝试：经 msg-dialect 编请求，打开 SSE、逐段解码、经门去重后上行。 */
async function streamAttempt(
  decoder: ReturnType<typeof getStreamDecoder>,
  parsed: ParsedChat,
  quirks: DialectQuirks,
  secret: string | null,
  policy: RetryPolicy,
  gate: DeltaGate,
  now: number,
  turnId: string | null,
  dialect: DialectClient,
  capture?: { partial?: Record<string, Json> },
): Promise<ModelOutput> {
  gate.beginAttempt()
  const built = await dialect.build(buildArgs(parsed, quirks, secret, true))
  if (
    built.kind !== 'http' ||
    built.url === undefined ||
    built.headers === undefined ||
    built.body === undefined
  ) {
    throw new ModelError('model_unsupported', 'msg-dialect.build did not return an HTTP request')
  }
  const response = await httpStream({
    method: 'POST',
    url: built.url,
    headers: built.headers,
    body: JSON.stringify(built.body),
    timeout_ms: policy.request_timeout_ms,
    now,
    turn_id: turnId ?? undefined,
    classify: (status, headers, body) => classifyWithSnippet(status, headers, body, now),
  })
  const accumulator = new StreamAccumulator()
  const parser = createSseParser()
  let sawTerminal = false
  try {
    for await (const chunk of response.chunks) {
      for (const data of parser.push(chunk)) {
        const fragments = decoder.handleStreamData(data, accumulator)
        for (const fragment of fragments) {
          if (fragment['done'] === true) sawTerminal = true
          gate.accept(fragment)
        }
      }
    }
  } catch (err) {
    // 中止 / 断流：留下已产出的碎片，供上层（取消）落盘，避免刷新后内容丢失。
    if (capture !== undefined && (accumulator.text.length > 0 || accumulator.reasoning.length > 0)) {
      capture.partial = {
        text: accumulator.text,
        reasoning: accumulator.reasoning,
        tool_calls: accumulator.toolCalls() as unknown as Json[],
      }
    }
    throw err
  }
  if (!sawTerminal)
    throw new ModelError('model_stream_broken', 'stream ended without terminal', {
      retryable: true,
    })
  const output: ModelOutput = {
    text: accumulator.text,
    tool_calls: accumulator.toolCalls() as unknown as Json[],
    usage: accumulator.usageValue,
  }
  if (accumulator.reasoning.length > 0) output.reasoning = accumulator.reasoning
  const blocks = streamReasoningBlocks(accumulator, parsed.provider, parsed.model)
  if (blocks.length > 0)
    output.reasoning_blocks = blocks as unknown as ModelOutput['reasoning_blocks']
  const stop = accumulator.stopReasonValue
  if (stop !== null) output.stop_reason = stop
  return output
}

/** 一次非流式尝试：经 msg-dialect 编请求 + 单次 HTTP + 整包解析。 */
async function fullAttempt(
  parsed: ParsedChat,
  quirks: DialectQuirks,
  secret: string | null,
  policy: RetryPolicy,
  now: number,
  turnId: string | null,
  dialect: DialectClient,
): Promise<ModelOutput> {
  const built = await dialect.build(buildArgs(parsed, quirks, secret, false))
  if (
    built.kind !== 'http' ||
    built.url === undefined ||
    built.headers === undefined ||
    built.body === undefined
  ) {
    throw new ModelError('model_unsupported', 'msg-dialect.build did not return an HTTP request')
  }
  const response = await httpRequest({
    method: 'POST',
    url: built.url,
    headers: built.headers,
    body: JSON.stringify(built.body),
    timeout_ms: policy.request_timeout_ms,
    now,
    turn_id: turnId ?? undefined,
    classify: (status, headers, body) => classifyWithSnippet(status, headers, body, now),
  })
  let json: Json
  try {
    json = JSON.parse(response.body) as Json
  } catch (err) {
    throw new ModelError('model_unsupported', `invalid response body: ${(err as Error).message}`)
  }
  return dialect.parseFull({ quirks, provider: parsed.provider, model: parsed.model, json })
}

function sdkInput(
  parsed: ParsedChat,
  quirks: DialectQuirks,
  secret: string | null,
  sdkParams: Rec,
): SdkCallInput {
  return {
    sdk_package: quirks.sdk_package,
    api_key: secret ?? '',
    provider: parsed.provider,
    model: parsed.model,
    sdk_params: sdkParams,
  }
}

/** chat：流式（impl=sdk 走 SDK 适配器，impl=protocol 走三协议流式解码）。 */
export async function chat(deps: ChatDeps, bag: Json, env: CallEnv): Promise<Json> {
  let parsed: ParsedChat
  try {
    parsed = parseChatBag(bag)
  } catch (err) {
    throw err instanceof BadArgsError ? err : new BadArgsError((err as Error).message)
  }
  // 中止时已产出的助手碎片（正文 / 推理 / 工具调用）：随失败值上行，供取消路径落盘留痕。
  const capture: { partial?: Record<string, Json> } = {}
  try {
    const dialect = new DialectClient(deps.dialect)
    const quirks = await dialect.normalizeQuirks(parsed.quirksRaw, parsed.protocolOverride)
    const secret = await resolveSecret(parsed, deps.secrets)
    const policy = await fetchPolicy(deps.throttle, parsed.resilience)
    const throttle = portThrottle(deps.throttle)
    parsed.messages = await dialect.inlineAssets(parsed.messages, quirks.protocol)
    // impl=sdk 与三协议同规：每次 attempt 新建解码器 / 经同一 DeltaGate 去重（重试先上行 reset）
    if (quirks.impl === 'sdk') {
      const gate = new DeltaGate((fragment) => emitDelta(deps, parsed, env, quirks, fragment))
      const output = await withRetry(
        parsed.provider,
        async () => {
          gate.beginAttempt()
          const built = await dialect.build(buildArgs(parsed, quirks, secret, true))
          if (built.kind !== 'sdk' || built.params === undefined) {
            throw new ModelError('model_unsupported', 'msg-dialect.build did not return SDK params')
          }
          return googleChat(sdkInput(parsed, quirks, secret, built.params), (fragment) =>
            gate.accept(fragment),
          )
        },
        { policy, throttle, now: env.now },
      )
      return outputValue(output, parsed, protocolLabel(quirks), true)
    }
    const gate = new DeltaGate((fragment) => emitDelta(deps, parsed, env, quirks, fragment))
    const key = repairKey(parsed.provider, parsed.base_url, parsed.model)
    const output = await negotiateOutput(
      key,
      parsed,
      quirks,
      async (effective, effectiveQuirks, applied) => {
        const capabilityProfile = await capabilityWithRepairs(
          dialect,
          effectiveQuirks,
          parsed.capabilityProfile,
          applied,
        )
        return await withRetry(
          parsed.provider,
          () =>
            streamAttempt(
              getStreamDecoder(effectiveQuirks.protocol, effectiveQuirks.reasoning_response_field, {
                provider: parsed.provider,
                model: parsed.model,
              }),
              { ...effective, capabilityProfile },
              effectiveQuirks,
              secret,
              policy,
              gate,
              env.now,
              effective.turn_id,
              dialect,
              capture,
            ),
          { policy, throttle, now: env.now },
        )
      },
    )
    return outputValue(output, parsed, protocolLabel(quirks), true)
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message, capture.partial)
    throw err
  }
}

/** complete：非流式单次补全，不发 model.delta；其余（密钥 / 韧性）同 chat。 */
export async function complete(deps: ChatDeps, bag: Json, env: CallEnv): Promise<Json> {
  const parsed = parseChatBag(bag)
  try {
    const dialect = new DialectClient(deps.dialect)
    const quirks = await dialect.normalizeQuirks(parsed.quirksRaw, parsed.protocolOverride)
    const secret = await resolveSecret(parsed, deps.secrets)
    const policy = await fetchPolicy(deps.throttle, parsed.resilience)
    const throttle = portThrottle(deps.throttle)
    parsed.messages = await dialect.inlineAssets(parsed.messages, quirks.protocol)
    const protocolComplete = (): Promise<ModelOutput> => {
      const key = repairKey(parsed.provider, parsed.base_url, parsed.model)
      return negotiateOutput(
        key,
        parsed,
        quirks,
        async (effective, effectiveQuirks, applied) => {
          const capabilityProfile = await capabilityWithRepairs(
            dialect,
            effectiveQuirks,
            parsed.capabilityProfile,
            applied,
          )
          return await withRetry(
            parsed.provider,
            () =>
              fullAttempt(
                { ...effective, capabilityProfile },
                effectiveQuirks,
                secret,
                policy,
                env.now,
                effective.turn_id,
                dialect,
              ),
            { policy, throttle, now: env.now },
          )
        },
      )
    }
    const output =
      quirks.impl === 'sdk'
        ? await withRetry(
            parsed.provider,
            async () => {
              const built = await dialect.build(buildArgs(parsed, quirks, secret, false))
              if (built.kind !== 'sdk' || built.params === undefined) {
                throw new ModelError(
                  'model_unsupported',
                  'msg-dialect.build did not return SDK params',
                )
              }
              return googleComplete(sdkInput(parsed, quirks, secret, built.params))
            },
            { policy, throttle, now: env.now },
          )
        : await protocolComplete()
    return { ok: true, text: output.text, usage: output.usage }
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    if (err instanceof ModelError) return errorValue(err.code, err.message)
    throw err
  }
}

function emitDelta(
  deps: ChatDeps,
  parsed: ParsedChat,
  env: CallEnv,
  quirks: DialectQuirks,
  fragment: Rec,
): void {
  deps.emit('model.delta', {
    run: env.run,
    thread: env.thread,
    model: parsed.model,
    protocol: protocolLabel(quirks),
    ...fragment,
  })
}
