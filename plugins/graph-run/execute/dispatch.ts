// 节点派发：按契约声明装配 bag、经反向调用 `port.call` 派发、按声明归一结果（发出者 = loop-policy）。
// 节点语义由契约的 `bag_pick` / `output_map` / `dispatch` 元数据声明（见 dispatch-rules.ts），
// 本文件只做通用解释：绑定 → 调用 → 归一；模型失败时的降级判定也在此。

import { resolveDowngrade } from './downgrade.ts'
import { commitParts, committedPartsOf, displayParts, incrementalParts } from './commit-parts.ts'
import { isCancelled } from './cancel.ts'
import {
  applyOutputMap,
  applyResultMap,
  buildBag,
  buildNamedBag,
  defaultModelBag,
  dispatchSpecOf,
  normalizeFor,
  runPreStep,
  type DispatchContext,
} from './dispatch-rules.ts'
import {
  effectsMethods,
  effectsPorts,
  nodeEntry,
  type GraphModel,
} from './model.ts'
import { checkToolCalls } from './rules.ts'
import { asArray, asString, isRecord, putOp } from './plan.ts'
import { appendStep, nextStepSeq } from './steplog.ts'
import type { ChosenInstance } from './scope.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, Json, PortCaller, Rec, RunState } from './types.ts'

export { netScopeOf } from './dispatch-rules.ts'
export { netRank } from 'plugin-sdk'

export interface NodeDispatchInput {
  nodeIndex: number
  iter: number
  contract: Rec
  instance: ChosenInstance
  inputs: Rec
  bag: Rec
  model: GraphModel
  pins: Rec
  rs: RunState
  env: CallEnv
  port: PortCaller
  /** 世界 `context-source` 成员表（身份名码元序）；`context.assemble` 前置逐一反向 `collect`。 */
  contextSources?: string[]
  /** 世界 `turn-hook` 成员表（身份名码元序）；`context.assemble` 前置（before-assemble）逐成员取增量。 */
  turnHooks?: string[]
  trace: TraceRecorder
}

export interface NodeDispatchResult {
  ok: boolean
  value: Json
  outcome: 'ok' | 'error' | 'transport_failed'
  code?: string
}

/** 派发目标：优先节点 `entry`，否则契约 effects 的首个端口 / 方法。 */
function target(contract: Rec, instance: ChosenInstance): { cap: string; method: string } {
  const entry = nodeEntry(instance.node)
  if (entry !== null) {
    const cap = asString(entry['cap'])
    const method = asString(entry['method'])
    if (cap !== null && method !== null) return { cap, method }
  }
  const ports = effectsPorts(contract)
  const methods = effectsMethods(contract)
  return { cap: ports[0] ?? '', method: methods[0] ?? 'invoke' }
}

/** 归一模型 tool_calls → 派发 calls（{call_id, tool, args}）；用于 gate / dispatch。 */
export function toCalls(value: Json, providerOf: (tool: string) => string): Rec[] {
  const checked = checkToolCalls(isRecord(value) ? value['tool_calls'] : undefined)
  return checked.calls.map((call, index) => {
    const id = typeof call['call_id'] === 'string' ? call['call_id'] : `call-${index}`
    const tool = typeof call['tool'] === 'string' ? call['tool'] : ''
    const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
    return { call_id: id, tool, args, port: providerOf(tool) }
  })
}

/**
 * 工具 → 提供者能力类解析器（供 guard 判据 (port, tool)）。
 * 按当次调用自己的 `bag.tools` 惰性读取，故不持跨调用可变状态：并发 `interpret` 各用各的目录。
 * 缺目录信息回落 `tool`。
 */
export function providerResolver(bag: Rec): (tool: string) => string {
  return (tool: string): string => {
    const tools = bag['tools']
    if (Array.isArray(tools)) {
      for (const item of tools) {
        if (!isRecord(item) || item['name'] !== tool) continue
        return asString(item['provider']) ?? 'tool'
      }
    }
    return 'tool'
  }
}

/** 助手展示记录：正文 + 可选用量 + 本步增量展示 parts（推理 / 正文 / 工具卡）。 */
export function assistantRecord(rs: RunState, message: Rec, tools: Json[]): Rec {
  const assistant: Rec = { content: typeof message['content'] === 'string' ? (message['content'] as string) : '' }
  if (isRecord(message['usage'])) assistant['meta'] = { usage: message['usage'] }
  // 展示段按**本步增量**落盘：只写新块与内容有变的工具卡，不存整回合累积前缀。
  const full = displayParts(rs.extraMessages, message, tools)
  const parts = incrementalParts(committedPartsOf(rs), full)
  commitParts(rs, full)
  // 纯文本回合不写 parts（content 已覆盖），避免历史无谓膨胀。
  if (parts.some((part) => isRecord(part) && part['type'] !== 'text')) assistant['parts'] = parts
  return assistant
}

/**
 * 回合收口步：把本轮最终助手消息（含工具卡 / 推理块）作为 step.result 追加进回合日志。
 * 挂起（inputs.pending）与收口共用同一形状：内容都先落盘，结局由 `turn.settle` 另写。
 */
function commitStepRecord(input: NodeDispatchInput): Rec | null {
  const turnId = asString(input.bag['turn_id'])
  if (turnId === null) return null
  const message = isRecord(input.inputs['message']) ? (input.inputs['message'] as Rec) : {}
  const tools = Array.isArray(input.bag['tools']) ? (input.bag['tools'] as Json[]) : []
  const record: Rec = {
    type: 'step.result',
    turn_id: turnId,
    // 单调分配：与 sink 是否最后无关，也不与后写步 / 标记步撞 `(turn_id,type,seq)`。
    seq: nextStepSeq(input.rs),
    assistant: assistantRecord(input.rs, message, tools),
    tool_results: Array.isArray(input.inputs['results']) ? (input.inputs['results'] as Json[]) : [],
  }
  if (isRecord(message['usage'])) record['usage'] = message['usage']
  const reasoning = lastReasoningOf(input.rs)
  // 厂商中立推理块（非展示 parts）：上下文投影按 `step.result.reasoning` 跨段回灌。
  if (reasoning !== undefined) record['reasoning'] = reasoning
  return record
}

/**
 * 本段最近一次模型调用的**厂商中立推理块**（`reasoning_blocks[0]`）或推理文本兜底块；
 * 供 step.result 持久化，使 context-window 投影能按 `step.result.reasoning` 跨段回灌。
 */
export function lastReasoningOf(rs: RunState): Json | undefined {
  return rs.shared['last_reasoning']
}

/** 收口节点：只追加最终内容步记录，不写世界、不定结局（结局由解释器 `turn.settle` 独占）。 */
async function appendCommitStep(input: NodeDispatchInput): Promise<NodeDispatchResult> {
  const record = commitStepRecord(input)
  if (record === null) return { ok: true, value: { appended: false }, outcome: 'ok' }
  const appended = await appendStep(input.port, record)
  if (!appended.ok) {
    return { ok: false, value: { ok: false, error: { code: 'owner_unavailable', message: 'turn step append failed' } }, outcome: 'error', code: 'owner_unavailable' }
  }
  return { ok: true, value: { appended: true }, outcome: 'ok' }
}

/** join：纯函数（同键取最新），不发 eff。 */
function joinOutput(input: NodeDispatchInput): Json {
  const merged: Rec = {}
  for (const key of ['left', 'right']) {
    const value = input.inputs[key]
    if (isRecord(value)) for (const [k, v] of Object.entries(value)) merged[k] = v
  }
  return { merged }
}

/** 本地纯处理（不发端口）：按契约声明名解析。 */
const LOCAL_STEPS: Record<string, (input: NodeDispatchInput) => Promise<NodeDispatchResult>> = {
  join: async (input) => ({ ok: true, value: joinOutput(input), outcome: 'ok' }),
  commit_step: appendCommitStep,
}

/** 派发一个节点；返回归一结果（不抛，失败作数据）。 */
export async function dispatchNode(input: NodeDispatchInput): Promise<NodeDispatchResult> {
  const spec = dispatchSpecOf(input.contract)
  const { cap, method } = target(input.contract, input.instance)

  if (spec === null) return defaultDispatch(input, cap, method)
  if (spec.local !== undefined) {
    const local = LOCAL_STEPS[spec.local]
    return local === undefined ? { ok: true, value: {}, outcome: 'ok' } : local(input)
  }

  const ctx: DispatchContext = {}
  for (const step of spec.pre ?? []) await runPreStep(input, step, ctx)

  let bag: Rec
  if (spec.bag !== undefined) {
    const built = buildNamedBag(input, spec.bag)
    if ('skip' in built) return { ok: true, value: built.skip, outcome: 'ok' }
    bag = built.bag
  } else {
    bag = await buildBag(input, spec, ctx)
  }

  const useCap = spec.cap ?? cap
  const useMethod = spec.method ?? method
  if (useCap.length === 0) return { ok: true, value: {}, outcome: 'ok' }
  const result = await callPort(input, useCap, useMethod, bag, spec.model === true, spec.output_map ?? null)
  if (!result.ok) return result
  if (spec.result_map !== undefined) return { ...result, value: applyResultMap(spec.result_map, result.value) }
  return result
}

/** 未声明派发元数据的契约：按默认模型路径（保持旧兜底）。 */
async function defaultDispatch(input: NodeDispatchInput, cap: string, method: string): Promise<NodeDispatchResult> {
  if (cap.length === 0) return { ok: true, value: {}, outcome: 'ok' }
  const isModel = effectsPorts(input.contract).includes('model') || cap === 'model'
  return callPort(input, cap, method, defaultModelBag(input), isModel, null)
}

/**
 * 反向调用 + eff_log 记录 + 模型失败降级。
 * `transport_failed` 是唯一进 refusal 的派发失败；节点业务错误原样作值（调用方判定）。
 */
async function callPort(
  input: NodeDispatchInput,
  cap: string,
  method: string,
  bag: Rec,
  isModel: boolean,
  map: string | null,
): Promise<NodeDispatchResult> {
  const outcome = await input.port.call(cap, method, bag)
  if (!outcome.ok) {
    input.trace.recordEff(input.iter, cap, method, bag, { code: outcome.code }, 'transport_failed')
    return { ok: false, value: { ok: false, error: { code: 'transport_failed', message: outcome.message } }, outcome: 'transport_failed', code: 'transport_failed' }
  }
  const value = outcome.value
  const isError = isRecord(value) && value['ok'] === false
  input.trace.recordEff(input.iter, cap, method, bag, value, isError ? 'error' : 'ok')
  const normalize = (target: string, produced: Json): Json =>
    map === null ? normalizeFor(target, method, produced) : applyOutputMap(map, produced)
  if (!isError) {
    return { ok: true, value: normalize(cap, value), outcome: 'ok' }
  }
  const error = isRecord(value['error']) ? (value['error'] as Rec) : {}
  const code = asString(error['code']) ?? 'downstream_refusal'
  // 已取消的回合不降级重试模型：abort 后的失败不该再起一次调用。
  if (isModel && !isCancelled(asString(input.bag['turn_id']))) {
    const downgraded = await resolveDowngrade(input.port, input.pins, input.model.thresholds, code, cap)
    if (downgraded !== null) {
      const retry = await input.port.call(downgraded.port, method, bag)
      if (retry.ok && !(isRecord(retry.value) && retry.value['ok'] === false)) {
        input.trace.recordEff(input.iter, downgraded.port, method, bag, retry.value, 'ok')
        // 降级端口按目标口径归一（与首调同规则，别名端口回落 identity）。
        return { ok: true, value: normalizeFor(downgraded.port, method, retry.value), outcome: 'ok' }
      }
      input.trace.recordEff(input.iter, downgraded.port, method, bag, retry.ok ? retry.value : { code: retry.code }, retry.ok ? 'error' : 'transport_failed')
    }
  }
  return { ok: false, value, outcome: 'error', code }
}

/** 从 tool.dispatch 的 results 里挑出成功项（供 wrote_files / extra_messages）。 */
export function successfulResults(value: Json): Rec[] {
  const results = isRecord(value) ? asArray(value['results']) : null
  if (results === null) return []
  return results.filter((item): item is Rec => isRecord(item) && item['ok'] === true)
}

/** 组装提交计划的占位辅助（供 dispatch 单测引用）。 */
export function dummyPut(body: Json): Json {
  return putOp(body)
}
