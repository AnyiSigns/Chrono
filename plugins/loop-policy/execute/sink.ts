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
  let sinkInputs = refusal !== null ? { refusal } : gatherInputs(sink, edges, ctx)
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

export function summaryOfRun(rs: RunState, pending: Rec | null): Rec {
  return {
    ok: pending === null,
    kind: 'interpret',
    iters: rs.iter,
    steps: rs.steps,
    pending: pending === null ? null : pending['kind'] ?? 'pending',
  }
}
