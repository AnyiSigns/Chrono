// 解释器共用上下文：一次 iter 的槽状态、规则上下文构造、推式条件边判定、拒绝产物归一。
// 被 interpreter（前推 / 节点派发）与 sink（收口）共用，避免两者互相 import。

import { contractInputs, edgePorts, edgeWhen, type GraphModel } from './model.ts'
import { directivesOf, isRecord } from './plan.ts'
import { attributionOf } from './seed.ts'
import { evalWhen, todoIncomplete, type RuleCtx } from './rules.ts'
import type { GraphView } from './gate.ts'
import type { CallEnv, Json, PortCaller, Rec, RunState, ServiceEvent } from './types.ts'
import type { TraceRecorder } from './trace.ts'

export interface InterpretInput {
  bag: Rec
  env: CallEnv
  model: GraphModel
  pins: Rec
  port: PortCaller
  trace: TraceRecorder
  resume: Rec | null
}

export interface InterpretResult {
  directives: Json[]
  events: ServiceEvent[]
  pending: Rec | null
  summary: Rec
  state: RunState
  ended: 'done' | 'refused' | 'pending'
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
    lastCalls: [],
  }
}

export { configureProviders } from './dispatch.ts'

export function externPayload(value: Json): Rec | null {
  for (const directive of directivesOf(value)) {
    if (isRecord(directive) && directive['kind'] === 'extern' && isRecord(directive['payload'])) {
      return directive['payload'] as Rec
    }
  }
  return null
}

function portBindingMode(contract: Rec, inputName: string): string {
  for (const port of contractInputs(contract)) {
    if (port['name'] === inputName && typeof port['binding_mode'] === 'string') return port['binding_mode'] as string
  }
  return 'all'
}

export function ruleCtx(rs: RunState, model: GraphModel, bag: Rec, iter: IterState, effLog: Json[], nodeIndex: number): RuleCtx {
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
  return evalWhen(edgeWhen(edge), ctx, source)
}

/** 节点激活：入边端口按 binding_mode（all / any）满足。 */
export function isActivated(index: number, contract: Rec, edges: Rec[], ctx: RuleCtx): boolean {
  if (index === 0) return true
  const incoming = edges.filter((edge) => {
    const ports = edgePorts(edge)
    return ports !== null && ports.to[0] === index
  })
  if (incoming.length === 0) return false
  const byPort = new Map<string, Rec[]>()
  for (const edge of incoming) {
    const ports = edgePorts(edge) as { to: [number, string] }
    const list = byPort.get(ports.to[1]) ?? []
    list.push(edge)
    byPort.set(ports.to[1], list)
  }
  for (const [name, portEdges] of byPort) {
    const triggered = portEdges.filter((edge) => edgeTriggered(edge, ctx)).length
    const mode = portBindingMode(contract, name)
    if (mode === 'any') {
      if (triggered === 0) return false
    } else if (triggered !== portEdges.length) {
      return false
    }
  }
  return true
}

/** 按入边端口收集节点输入（同端口取首个触发）。 */
export function gatherInputs(index: number, edges: Rec[], ctx: RuleCtx): Rec {
  const out: Rec = {}
  for (const edge of edges) {
    const ports = edgePorts(edge)
    if (ports === null || ports.to[0] !== index) continue
    if (!edgeTriggered(edge, ctx)) continue
    const [source, outPort] = ports.from
    const inPort = ports.to[1]
    if (out[inPort] !== undefined) continue
    const sourceOutput = ctx.outputs.get(source) ?? {}
    out[inPort] = sourceOutput[outPort] ?? null
  }
  return out
}

export function refusalArtifact(model: GraphModel, code: string, message: string): Rec {
  return { code, message, attributable_to: attributionOf(model, code) }
}

/** 把边触发的拒绝值（gate deny / approval denied）归一成带码的拒绝产物。 */
export function normalizeRefusalInput(value: Json, model: GraphModel): Rec {
  if (isRecord(value) && typeof value['code'] === 'string' && value['code'].length > 0) return value as Rec
  const denied =
    value === 'deny' ||
    value === 'denied' ||
    (isRecord(value) && (value['verdict'] === 'deny' || value['decision'] === 'denied'))
  if (denied) return { code: 'denied', message: 'denied by guard or user', attributable_to: attributionOf(model, 'denied') }
  return { code: 'downstream_refusal', message: 'downstream refused', attributable_to: attributionOf(model, 'downstream_refusal') }
}
