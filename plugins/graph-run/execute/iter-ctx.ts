// 解释器共用上下文：一次 iter 的槽状态、规则上下文构造、推式条件边判定、拒绝产物归一。
// 被 interpreter（前推 / 节点派发）与 sink（收口）共用，避免两者互相 import。

import { attributionOf, contractInputs, edgePorts, edgeWhen, type GraphModel } from './model.ts'
import { edgeKey } from './graph.ts'
import { directivesOf, isRecord } from './plan.ts'
import { evalWhen, todoIncomplete, type RuleCtx } from './rules.ts'
import type { GraphView } from './view.ts'
import type { CallEnv, Json, PortCaller, Rec, RunState, ServiceEvent } from './types.ts'
import type { TraceRecorder } from './trace.ts'
import type { Ended, GraphProgress, LifecycleState } from './lifecycle.ts'

export interface InterpretInput {
  bag: Rec
  env: CallEnv
  model: GraphModel
  pins: Rec
  port: PortCaller
  trace: TraceRecorder
  resume: Rec | null
  /** 图数据 def 引用闭包（`graph-gate.closure` 读链式条目 / 图 def 用；服务不读投影）。 */
  refs: Rec
}

export interface InterpretResult {
  directives: Json[]
  events: ServiceEvent[]
  pending: Rec | null
  summary: Rec
  state: RunState
  /** 段 / 回合终态标记：段边界为 `stepping`（计划含续跑 eval，不是回合终态、不收口）。 */
  ended: Ended
  /** 解释器生命周期状态（封闭枚举，与图拓扑无关）。 */
  lifecycle: LifecycleState
  /** 图内进度（数据，非状态）。 */
  progress: GraphProgress
  /** 预算主动收口的 `stop_reason`（命名哪一维预算用尽）；非预算收口为 null。 */
  stopReason: string | null
  /** 契约版本拒绝等预先构造的精确结局；为 null 时由收口方按拒绝码派生。 */
  refusedOutcome: Json | null
}

export interface IterState {
  outputs: Map<number, Rec>
  inputs: Map<number, Rec>
  executed: Set<number>
}

export function freshState(): RunState {
  return {
    iter: 1,
    steps: 0,
    slots: {},
    shared: {},
    extraMessages: [],
    messages: [],
    dispatchedTools: false,
    questionPending: false,
    verifyFailed: false,
    loopSignatures: [],
    loopNudged: false,
    loopNudge: null,
    lastCalls: [],
    committedParts: [],
  }
}

export function externPayload(value: Json): Rec | null {
  for (const directive of directivesOf(value)) {
    if (isRecord(directive) && directive['kind'] === 'extern' && isRecord(directive['payload'])) {
      return directive['payload'] as Rec
    }
  }
  return null
}

/** 输入端口声明：binding_mode（缺省 all）与 required（缺省 false）。 */
function portSpec(contract: Rec, inputName: string): { mode: string; required: boolean } {
  for (const port of contractInputs(contract)) {
    if (port['name'] !== inputName) continue
    const mode = typeof port['binding_mode'] === 'string' ? (port['binding_mode'] as string) : 'all'
    return { mode, required: port['required'] === true }
  }
  return { mode: 'all', required: false }
}

export function ruleCtx(
  rs: RunState,
  model: GraphModel,
  bag: Rec,
  iter: IterState,
  effLog: Json[],
  nodeIndex: number,
): RuleCtx {
  return {
    nodeIndex,
    outputs: iter.outputs,
    inputs: iter.inputs,
    shared: rs.shared,
    thresholds: model.thresholds,
    effLog,
    state: {
      dispatched_tools: rs.dispatchedTools,
      question_pending: rs.questionPending,
      verify_failed: rs.verifyFailed,
      todo_incomplete: todoIncomplete(bag['todo']),
      last_calls: rs.lastCalls,
      tools: bag['tools'] ?? null,
    },
  }
}

/** 入边触发判定（source 已求值 + when 成立）。 */
export function edgeTriggered(edge: Rec, ctx: RuleCtx): boolean {
  const ports = edgePorts(edge)
  if (ports === null) return false
  const source = ports.from[0]
  if (!ctx.outputs.has(source)) return false
  const when = evalWhen(edgeWhen(edge), ctx, source)
  // 未知判据不激活边（fail-closed）；未知判据会在解释器入口被判据校验先行拒绝。
  return when.ok && when.value
}

/** 入边端口按 binding_mode（all / any）解析后的结果：是否激活 + 收集到的输入 + 已消费 / 被击败的边。 */
export interface InputResolution {
  activated: boolean
  inputs: Rec
  /** 被消费（作为输入选中）的边。 */
  taken: Rec[]
  /** 触发但未被选中（any 端口败者）的边，确定性记为 branch_not_taken。 */
  defeated: Rec[]
}

/** 边源节点是否已求值（有 outputs）：未求值的源不作「分支已评估但未触发」计。 */
function sourceEvaluated(edge: Rec, ctx: RuleCtx): boolean {
  const ports = edgePorts(edge)
  return ports !== null && ctx.outputs.has(ports.from[0])
}

/** 取边源输出的指定字段（与旧 gatherInputs 同口径）。 */
function edgeValue(edge: Rec, ctx: RuleCtx): Json {
  const ports = edgePorts(edge)
  if (ports === null) return null
  const [source, outPort] = ports.from
  const sourceOutput = ctx.outputs.get(source) ?? {}
  return sourceOutput[outPort] ?? null
}

/**
 * 节点入边解析（确定性）：入边按目标端口分组（声明序），
 * - `any` 端口：>=1 触发即激活，**按声明序取首个**，其余触发边记 `defeated`；
 * - `all` 端口：required 时全部边必须触发；optional 时零触发允许（输入缺省），
 *   但零触发仅在**所有这些边的源都已求值**（分支已判定而未走）时成立——源从未求值即不可达，仍不激活。
 * 节点 0（入口）恒激活，输入由调用方按需预置（composite 子图入口）。
 */
export function resolveInputs(
  index: number,
  contract: Rec,
  edges: Rec[],
  ctx: RuleCtx,
): InputResolution {
  const inputs: Rec = {}
  const taken: Rec[] = []
  const defeated: Rec[] = []
  if (index === 0) return { activated: true, inputs, taken, defeated }
  const order: string[] = []
  const byPort = new Map<string, Rec[]>()
  for (const edge of edges) {
    const ports = edgePorts(edge)
    if (ports === null || ports.to[0] !== index) continue
    const name = ports.to[1]
    let list = byPort.get(name)
    if (list === undefined) {
      list = []
      byPort.set(name, list)
      order.push(name)
    }
    list.push(edge)
  }
  if (order.length === 0) return { activated: false, inputs, taken, defeated }
  let activated = true
  for (const name of order) {
    const portEdges = byPort.get(name) as Rec[]
    const { mode, required } = portSpec(contract, name)
    const triggered = portEdges.filter((edge) => edgeTriggered(edge, ctx))
    if (mode === 'any') {
      if (triggered.length === 0) {
        activated = false
        continue
      }
      const chosen = triggered[0]
      inputs[name] = edgeValue(chosen, ctx)
      taken.push(chosen)
      for (let i = 1; i < triggered.length; i++) defeated.push(triggered[i])
      continue
    }
    const allEvaluated = portEdges.every((edge) => sourceEvaluated(edge, ctx))
    const satisfied = required
      ? triggered.length === portEdges.length
      : triggered.length === portEdges.length || (allEvaluated && triggered.length === 0)
    if (!satisfied) {
      activated = false
      continue
    }
    for (const edge of triggered) {
      // all 端口同名字段仍单槽：先到先得，后到记 defeated（不静默丢）。
      if (inputs[name] !== undefined) {
        defeated.push(edge)
        continue
      }
      inputs[name] = edgeValue(edge, ctx)
      taken.push(edge)
    }
  }
  return { activated, inputs, taken, defeated }
}

/**
 * 源节点输出端口的分支互斥检查：同一输出端口的出边是**一个分支选择**，
 * 至多一条可触发；>1 触发即判 `redundant`（两「互斥」分支同时走的编排错误）。
 * 返回被过度触发的端口与其触发边（声明序）；无则 null。
 */
export function overTriggeredBranch(
  nodeIndex: number,
  edges: Rec[],
  ctx: RuleCtx,
): { port: string; edges: Rec[] } | null {
  const byPort = new Map<string, Rec[]>()
  for (const edge of edges) {
    const ports = edgePorts(edge)
    if (ports === null || ports.from[0] !== nodeIndex) continue
    const key = ports.from[1]
    const list = byPort.get(key) ?? []
    list.push(edge)
    byPort.set(key, list)
  }
  for (const [port, list] of byPort) {
    if (list.length < 2) continue
    const triggered = list.filter((edge) => edgeTriggered(edge, ctx))
    if (triggered.length > 1) return { port, edges: triggered }
  }
  return null
}

export function refusalArtifact(model: GraphModel, code: string, message: string): Rec {
  return { code, message, attributable_to: attributionOf(model, code) }
}

/** 把解析结果里的已取 / 被击败边登记到 trace（分支审计，确定性；解释器与收口共用）。 */
export function consumeBranches(
  resolved: InputResolution,
  index: number,
  trace: TraceRecorder,
): void {
  for (const edge of resolved.taken) {
    const key = edgeKey(edge)
    if (key !== null) trace.markBranch(key)
  }
  for (const edge of resolved.defeated) {
    const key = edgeKey(edge)
    if (key !== null) trace.noteBranchNotTaken(key, index, 'any_defeated')
  }
}

/** 把边触发的拒绝值（gate deny / approval denied）归一成带码的拒绝产物。 */
export function normalizeRefusalInput(value: Json, model: GraphModel): Rec {
  if (isRecord(value) && typeof value['code'] === 'string' && value['code'].length > 0)
    return value as Rec
  const denied =
    value === 'deny' ||
    value === 'denied' ||
    (isRecord(value) && (value['verdict'] === 'deny' || value['decision'] === 'denied'))
  if (denied)
    return {
      code: 'denied',
      message: 'denied by guard or user',
      attributable_to: attributionOf(model, 'denied'),
    }
  return {
    code: 'downstream_refusal',
    message: 'downstream refused',
    attributable_to: attributionOf(model, 'downstream_refusal'),
  }
}
