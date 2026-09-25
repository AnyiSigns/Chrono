// 收口（sink）：按 sink 入边触发收集输入（或带拒绝）并派发；拒绝值归一 + refused_at 记录。
// sink 延后到回合收口（loop 终止 / 拒绝短路），保证「回合尾一次写」。

import { dispatchNode } from './dispatch.ts'
import { directivesOf, isRecord } from './plan.ts'
import { selectInstance } from './scope.ts'
import {
  gatherInputs,
  normalizeRefusalInput,
  refusalArtifact,
  ruleCtx,
  type InterpretInput,
  type IterState,
} from './iter-ctx.ts'
import type { GraphView } from './gate.ts'
import type { Json, Rec, RunState } from './types.ts'

export async function runSink(
  input: InterpretInput,
  view: GraphView,
  ids: string[],
  edges: Rec[],
  contracts: Map<string, Rec>,
  sink: number,
  scopeCtx: { workspace_id: string | null; session_id: string | null },
  rs: RunState,
  iter: IterState,
  directives: Json[],
  refusal: Rec | null,
): Promise<void> {
  const { model, port, env, trace, bag, pins } = input
  void view
  const contract = contracts.get(ids[sink])
  if (contract === undefined) {
    trace.refuse(sink, rs.iter, 'input_insufficient', 'graph')
    return
  }
  const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, sink)
  // 拒绝短路不丢弃本回合已产出的内容：把最后一步的助手消息一并交 commit，正文/推理/工具卡照常落盘，
  // 只额外补 `error` 码；否则流式时看得到、重载后整回合「记录全没」。
  let sinkInputs: Rec
  if (refusal !== null) {
    sinkInputs = { refusal }
    const lastMessage = rs.messages.length > 0 ? rs.messages[0] : null
    if (lastMessage !== null) sinkInputs['message'] = lastMessage
  } else {
    sinkInputs = gatherInputs(sink, edges, ctx)
  }
  if (refusal === null && sinkInputs['refusal'] !== undefined) {
    const artifact = normalizeRefusalInput(sinkInputs['refusal'], model)
    sinkInputs = { ...sinkInputs, refusal: artifact }
    if (trace.refusedAt === null) trace.refuse(sink, rs.iter, artifact['code'] as string, artifact['attributable_to'] as string)
  }
  if (refusal === null && Object.keys(sinkInputs).length === 0) {
    trace.refuse(sink, rs.iter, 'input_insufficient', 'graph')
    sinkInputs['refusal'] = refusalArtifact(model, 'input_insufficient', 'sink has no triggered input')
  }
  if (refusal !== null && (typeof refusal['code'] !== 'string' || refusal['code'] === '')) {
    const artifact = normalizeRefusalInput(refusal, model)
    sinkInputs = { ...sinkInputs, refusal: artifact }
    if (trace.refusedAt === null) trace.refuse(sink, rs.iter, artifact['code'] as string, artifact['attributable_to'] as string)
  }
  const chosen = selectInstance(model, contract, scopeCtx)
  if (chosen === null) {
    trace.refuse(sink, rs.iter, 'scope_mismatch', 'graph')
    return
  }
  const step = trace.startStep(sink, rs.iter, ids[sink], chosen.chosen_instance, chosen.chosen_agent)
  const effBefore = trace.effLog.length
  const result = await dispatchNode({
    nodeIndex: sink,
    iter: rs.iter,
    contract,
    instance: chosen,
    inputs: sinkInputs,
    bag,
    model,
    pins,
    rs,
    env,
    port,
    trace,
  })
  trace.attachEff(step, trace.effLog.slice(effBefore) as Rec[])
  if (result.ok && isRecord(result.value)) {
    iter.outputs.set(sink, result.value)
    iter.executed.add(sink)
    for (const directive of directivesOf(result.value)) directives.push(directive)
  } else {
    step['verdict'] = 'fail'
    step['refusal'] = result.code ?? 'downstream_refusal'
    if (trace.refusedAt === null) trace.refuse(sink, rs.iter, result.code ?? 'downstream_refusal', 'graph')
  }
}

/**
 * 显式挂起收口：回合级等人（approval.wait 返回 `pending`）不以静默 sink 收口，而是单独收集本轮已发生的事实。
 * 收口前先把用户消息（随 commitBag 的 `bag.input`）、助手消息与已执行工具结果（随 `rs.extraMessages` 的展示
 * parts）落账——它们已经发生，存续不该取决于后续是否获批；收口带挂起原因与 resume 游标，供跨宿主重启续跑。
 * 不走 `runSink` 的入边收集：`pending` 在种子里没有出边，且静默收口会让「等人」与「跑完了」不可区分。
 */
export async function runSuspend(
  input: InterpretInput,
  view: GraphView,
  ids: string[],
  edges: Rec[],
  contracts: Map<string, Rec>,
  sink: number,
  scopeCtx: { workspace_id: string | null; session_id: string | null },
  rs: RunState,
  iter: IterState,
  directives: Json[],
  pending: Rec,
): Promise<void> {
  const { model, port, env, trace, bag, pins } = input
  void view
  void edges
  const contract = contracts.get(ids[sink])
  if (contract === undefined) {
    trace.refuse(sink, rs.iter, 'input_insufficient', 'graph')
    return
  }
  // 已发生的助手消息作为终止消息交 commit：正文 / 推理 / 工具卡（审批未决，结果与状态留空）随 parts 落盘。
  const lastMessage = rs.messages.length > 0 ? rs.messages[0] : null
  const sinkInputs: Rec = { pending: { reason: pending['kind'] ?? 'pending', cursor: pending['cursor'] ?? null } }
  if (lastMessage !== null) sinkInputs['message'] = lastMessage
  const chosen = selectInstance(model, contract, scopeCtx)
  if (chosen === null) {
    trace.refuse(sink, rs.iter, 'scope_mismatch', 'graph')
    return
  }
  const step = trace.startStep(sink, rs.iter, ids[sink], chosen.chosen_instance, chosen.chosen_agent)
  const effBefore = trace.effLog.length
  const result = await dispatchNode({
    nodeIndex: sink,
    iter: rs.iter,
    contract,
    instance: chosen,
    inputs: sinkInputs,
    bag,
    model,
    pins,
    rs,
    env,
    port,
    trace,
  })
  trace.attachEff(step, trace.effLog.slice(effBefore) as Rec[])
  if (result.ok && isRecord(result.value)) {
    iter.outputs.set(sink, result.value)
    iter.executed.add(sink)
    for (const directive of directivesOf(result.value)) directives.push(directive)
    return
  }
  // 收口失败不改写挂起结局：挂起仍成立（游标已随队列项持久化），只记失败形态供取证。
  step['verdict'] = 'fail'
  step['refusal'] = result.code ?? 'downstream_refusal'
  if (trace.refusedAt === null) trace.refuse(sink, rs.iter, result.code ?? 'downstream_refusal', 'graph')
}

export function summaryOfRun(rs: RunState, pending: Rec | null): Rec {
  return {
    ok: pending === null,
    kind: 'interpret',
    iters: rs.iter,
    steps: rs.steps,
    pending: pending === null ? null : pending['kind'] ?? 'pending',
  }
}
