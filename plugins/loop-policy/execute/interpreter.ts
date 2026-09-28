// 服务自驱图解释器：顺序推进（读图数据 → 选实例 → pre → port.call 派发 → post → when 定下一 Scope → sink 收口）。
// 推式条件边 + 拒绝短路到 sink + 回合重入（Graph.loop）+ MAX_STEPS/gas 自限 + 审批/提问跨 run 续跑。
// 游标是服务进程内状态（跨 run 续跑时序列化进队列项游标落世界）。

import { assistantRecord, dispatchNode, netScopeOf, providerResolver, toCalls } from './dispatch.ts'
import { checkpointLevel, checkpointThresholds, contextPressure, emitCheckpoint } from './checkpoint.ts'
import { displayParts } from './commit-parts.ts'
import { isCancelled } from './cancel.ts'
import { appendStep, toolCallsForLog } from './steplog.ts'
import {
  contractId,
  contractIndex,
  contractPost,
  contractPre,
  edgeWhen,
  graphEdges,
  graphLoop,
  graphNodes,
  graphSink,
  numericThreshold,
} from './model.ts'
import { buildView } from './gate.ts'
import { LifecycleMachine, endedOf, type GraphProgress } from './lifecycle.ts'
import { asString, directivesOf, evalDirective, isRecord, nestedDirectivesOf, numberField } from './plan.ts'
import { attributionOf, retriableOf } from './seed.ts'
import { evalPost, evalPre, evalWhen, unknownWhenExpr } from './rules.ts'
import { selectInstance } from './scope.ts'
import {
  externPayload,
  freshState,
  gatherInputs,
  isActivated,
  refusalArtifact,
  ruleCtx,
  type InterpretInput,
  type InterpretResult,
  type IterState,
} from './iter-ctx.ts'
import { graphCursor, patchQuestionAnswer, resumePayload, resumeVerdict, restoreState } from './cursor.ts'
import { checkContractVersion } from './contract/index.ts'
import { restoreFromSteps, turnSteps } from './reconstruct.ts'
import { runSink, runSuspend, summaryOfRun } from './sink.ts'
import type { TraceRecorder } from './trace.ts'
import type { TurnOutcome } from './contract/index.ts'
import type { CallEnv, Json, Rec, RunState, ServiceEvent } from './types.ts'

interface IterResult {
  refused: Rec | null
  pending: Rec | null
  cancelled?: boolean
}

interface NodeRunResult {
  refusal: Rec | null
  pending: Rec | null
  cancelled?: boolean
}

/** 终态附加信息：预算主动收口的 `stop_reason` 与契约版本拒绝的精确结局。 */
interface TerminalExtra {
  stopReason?: string | null
  refusedOutcome?: TurnOutcome | null
}

/**
 * 解释一次图执行。
 * 有 `turn_id` 时**一段 = 一个 iter**：段尾若回合未完，返回计划含 `{kind:'eval', command:'chat.resume', args:{turn_id}}`，
 * 宿主在同一个 run 里插入下一轮继续执行；回合已完才收口。无 `turn_id`（单测直调 / 无回合身份）保持同步多 iter。
 */
export async function interpretGraph(input: InterpretInput): Promise<InterpretResult> {
  const { bag, env, model, trace } = input
  const providerOf = providerResolver(bag)
  const view = buildView(model)
  const ids = graphNodes(model.graph)
  const edges = graphEdges(model.graph)
  const sink = graphSink(model.graph)
  const contracts = contractIndex(model)
  const scopeCtx = { workspace_id: asString(bag['workspace_id']), session_id: asString(bag['session_id']) }
  const maxTurnIter = numericThreshold(model.thresholds, 'max_turn_iter', 6)
  const maxSteps = numericThreshold(model.thresholds, 'max_steps', 64)
  const turnId = asString(bag['turn_id'])
  const loopWhen = asString(graphLoop(model.graph)['when']) ?? ''
  const directives: Json[] = []
  const events: ServiceEvent[] = []
  const pendingCursor = input.resume !== null && isRecord(input.resume['cursor']) ? (input.resume['cursor'] as Rec) : null
  const continuation = input.resume !== null && input.resume['continuation'] === true

  // 取消检查点（入口）：标志在进入解释前已置时立即停，不派发任何节点（含模型与工具）。
  if (isCancelled(turnId)) {
    const stopped = freshState()
    const machine = new LifecycleMachine({ iter: stopped.iter, node_index: null, contract_id: null })
    machine.send('settle')
    machine.send('finalize')
    return {
      directives,
      events,
      pending: null,
      summary: summaryOfRun(stopped, null),
      state: stopped,
      ended: endedOf(machine.state, 'cancelled'),
      lifecycle: machine.state,
      progress: progressOf(stopped, trace),
      stopReason: null,
      refusedOutcome: null,
    }
  }

  let rs: RunState
  let iter: IterState
  if (pendingCursor !== null && (pendingCursor['kind'] === 'approval' || pendingCursor['kind'] === 'question')) {
    const restored = restoreState(pendingCursor)
    rs = restored.rs
    iter = restored.iter
    // 续跑优先用游标内原始输入：作答 / 裁决那一刻的槽已是 approval.decide / question.answer，
    // 直接用会丢原始用户消息（游标随队列项落世界，opaque，不透明）。
    if (pendingCursor['original_input'] !== undefined) bag['input'] = pendingCursor['original_input']
    const nodeIndex = numberField(pendingCursor['node_index']) ?? 0
    if (pendingCursor['kind'] === 'approval') {
      const verdict = resumeVerdict(input.resume) ?? 'denied'
      iter.outputs.set(nodeIndex, { decision: verdict })
      iter.executed.add(nodeIndex)
      // 批准放行：构造一次性 `caps.grant`（绑定被批准的 call_id、只放宽本次、带 expires）随派发 bag 下传。
      if (verdict === 'approved') {
        const grant = approvalGrant(bag, env, rs, pendingCursor)
        if (grant !== null) bag['grant'] = grant
      }
    } else {
      // 作答续跑：答案回灌为该工具调用的结果，本段图内进度不变（派发已发生）——段尾重入，
      // 下一段据步记录重建 extra_messages（含答案与同批其它工具真实结果）后重跑 assemble + step。
      const payload = resumePayload(input.resume)
      const answers = payload['answers'] ?? null
      const callId = asString(pendingCursor['call_id'])
      patchQuestionAnswer(iter, nodeIndex, callId, payload, rs.lastCalls)
      rs.dispatchedTools = true
      // 答案以与同步环同形的 assistant(tool_calls) → tool(result) 序列回灌 extra_messages：
      // 无回合身份（同步重入）时本段重跑 assemble 即见答案；有回合身份时改由步记录在重入段重建。
      appendToolMessages(rs, { results: [{ call_id: callId ?? 'question', ok: true, result: { answers } }] })
      // 作答步序号：取该回合已落步记录（含悬挂派发步与挂起收口步）的最大 seq 之后，
      // 避免与已落盘步同键被去重——游标取于派发前，其 `steps` 不含悬挂步与挂起收口步。
      let maxSeq = rs.steps
      for (const record of turnSteps(bag, turnId)) {
        if (!isRecord(record)) continue
        const seq = numberField(record['seq'])
        if (seq !== null && seq > maxSeq) maxSeq = seq
      }
      rs.steps = maxSeq + 1
      if (turnId !== null) {
        // 作答步只带 question 项：重入重建时原位覆盖该 pending 结果，不覆盖同批其它工具的真实结果。
        const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
        const parts = calls.map((call) => ({
          type: 'tool',
          call_id: call['call_id'] ?? null,
          tool: call['tool'] ?? '',
          args: call['args'] ?? null,
          result: null,
          status: 'ok',
        }))
        await appendStep(input.port, {
          type: 'step.result',
          turn_id: turnId,
          seq: rs.steps,
          assistant: { content: '', parts },
          tool_results: [{ call_id: callId ?? 'question', ok: true, result: { answers } }],
        })
      }
    }
    rs.questionPending = false
  } else if (continuation) {
    // 段续跑：解释器状态来自本回合的会话步记录，本题 iter 全新（每段是一个 iter）。
    const restored = restoreFromSteps(turnSteps(bag, turnId))
    rs = restored.rs
    iter = restored.iter
  } else {
    rs = freshState()
    iter = { outputs: new Map(), inputs: new Map(), executed: new Set() }
  }

  // 生命周期机：状态只经转换表变更；图内进度是随状态携带的数据。
  const machine = new LifecycleMachine({ iter: rs.iter, node_index: null, contract_id: null })
  const finish = (
    ended: InterpretResult['ended'],
    pending: Rec | null = null,
    extra: TerminalExtra = {},
  ): InterpretResult => ({
    directives,
    events,
    pending,
    summary: summaryOfRun(rs, pending),
    state: rs,
    ended,
    lifecycle: machine.state,
    progress: progressOf(rs, trace),
    stopReason: extra.stopReason ?? null,
    refusedOutcome: extra.refusedOutcome ?? null,
  })
  // 拒绝收口：进 settling → runSink 落盘本轮内容 → settled；拒绝码与归因原样进 trace / 结局。
  const refuseTerminal = async (code: string, message: string): Promise<InterpretResult> => {
    trace.refuse(sink, rs.iter, code, attributionOf(model, code))
    machine.send('settle')
    await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, refusalArtifact(model, code, message))
    machine.send('finalize')
    return finish(endedOf(machine.state, 'refused'))
  }
  // 预算主动收口：不是失败，保留已完成内容并以 `committed` + `stop_reason` 收口（命名哪一维预算用尽）。
  const stopTerminal = async (stopReason: string): Promise<InterpretResult> => {
    machine.send('settle')
    await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, null)
    machine.send('finalize')
    return finish(endedOf(machine.state, 'done'), null, { stopReason })
  }

  // 契约边界：bag 带 `contract_version` 时主版本必须一致，未知主版本立即拒绝并给结构化结局；
  // 缺失视为未标注版本（兼容接受），是否记录由调用方决定（见 methods.ts 的 summary.contract_version）。
  if (bag['contract_version'] !== undefined && bag['contract_version'] !== null) {
    const version = checkContractVersion(bag['contract_version'])
    if (!version.ok) {
      trace.refuse(sink, rs.iter, 'contract_version_mismatch', 'owner')
      machine.send('settle')
      machine.send('finalize')
      return finish(endedOf(machine.state, 'refused'), null, { refusedOutcome: version.outcome })
    }
  }

  // 判据 fail-closed：任何未知 `when` 判据（边与 loop）在进入迭代前显式拒绝，不静默按 false 处理。
  const unknownWhen = unknownWhenExpr([...edges.map((edge) => edgeWhen(edge)), loopWhen])
  if (unknownWhen !== null) {
    return refuseTerminal('when_unsat', `unknown predicate: ${unknownWhen}`)
  }
  const started = machine.send('step', progressOf(rs, trace))
  if (!started.ok) {
    return refuseTerminal('invalid_contract', `invalid lifecycle transition ${started.failure.from}--${started.failure.event}`)
  }

  for (;;) {
    const result = await runIter(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, providerOf)
    if (result.cancelled === true) {
      // 取消：不再派发新工具 / 模型，也不写拒绝产物；内容已落步记录，终态由调用方经 CAS 落 `cancelled`。
      machine.send('settle')
      machine.send('finalize')
      return finish(endedOf(machine.state, 'cancelled'))
    }
    if (result.pending !== null) {
      // 显式挂起收口：先把本轮已发生的用户 / 助手消息与已执行工具结果落账，再以 `suspended` 收口。
      machine.send('suspend', progressOf(rs, trace))
      await runSuspend(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, result.pending)
      return finish(endedOf(machine.state, 'done'), result.pending)
    }
    if (result.refused !== null) {
      machine.send('settle')
      await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, result.refused)
      machine.send('finalize')
      return finish(endedOf(machine.state, 'refused'))
    }
    const loopCtx = ruleCtx(rs, model, bag, iter, trace.effLog, 0)
    // 无 loop.when ⇒ 不重入（缺省即单轮）；question_pending 优先 ⇒ 本 run 正常结束。
    let shouldLoop = false
    if (!rs.questionPending && loopWhen.length > 0) {
      const when = evalWhen(loopWhen, loopCtx, 0)
      if (!when.ok) return refuseTerminal(when.code ?? 'when_unsat', when.reason ?? `unknown_when:${loopWhen}`)
      shouldLoop = when.value
    }
    if (!shouldLoop) {
      machine.send('settle')
      await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, null)
      machine.send('finalize')
      return finish(endedOf(machine.state, trace.outcome === 'refused' ? 'refused' : 'done'))
    }
    // 预算先于机械轮数上限收口：分段后一段约 1 eval 轮 + N write 轮，预算阶梯须先于 MAX_SUBMISSION_ROUNDS 生效。
    // 这是用户预算主动停，不是失败：已完成内容保留，`committed` + `stop_reason` 收口（命名哪一维预算用尽）。
    if (rs.iter >= maxTurnIter || rs.steps >= maxSteps) {
      return stopTerminal(rs.iter >= maxTurnIter ? 'turn_iter' : 'steps')
    }
    if (turnId === null) {
      // 无回合身份：同步重入（单测直调 / 无会话回合），与分段前一致。
      machine.send('segment', progressOf(rs, trace))
      rs.iter += 1
      rs.dispatchedTools = false
      rs.questionPending = false
      rs.verifyFailed = false
      iter = { outputs: new Map(), inputs: new Map(), executed: new Set() }
      continue
    }
    // 段尾：本段已完成、回合未完 ⇒ 在同一 run 里续下一段（宿主按命令名解析入口）。
    // 段标记步记录把「段序号」落进回合作日志，下一段据此重建 iter / steps，预算不在无步记录的循环里失效。
    // 游标只带 `turn_id`；投影切片经 `inject` 由宿主执行期并入，服务不内嵌整份投影。
    machine.send('segment', progressOf(rs, trace))
    let markerSeq = rs.steps + 1
    // 段边界检查点：上下文压力越阈即在下一段模型调用前压缩（compress 为后端，只算不写）。
    // 失败只跳过记录、不阻断续段（拿到结果也照常分段自续跑）。
    const pressure = contextPressure(rs)
    if (pressure !== null) {
      const thresholds = checkpointThresholds(model, bag)
      const level = checkpointLevel(pressure.ratio, thresholds)
      if (level !== null) {
        const checkpoint = await emitCheckpoint({ port: input.port, bag, model, rs, turnId, level })
        if (checkpoint.emitted) markerSeq += 1
      }
    }
    await appendStep(input.port, {
      type: 'checkpoint',
      turn_id: turnId,
      seq: markerSeq,
      summary: { kind: 'segment', iter: rs.iter + 1 },
      covered_upto: markerSeq,
    })
    directives.push(evalDirective('chat.resume', continuationArgs(bag, turnId), { ids: ['ids'] }))
    return finish(endedOf(machine.state, 'done'))
  }
}

/** 图内进度：最近一步的节点与契约 id + 当前段序号（数据，供 UI 映射「正在思考 / 正在调工具」）。 */
function progressOf(rs: RunState, trace: TraceRecorder): GraphProgress {
  const last = trace.steps.length > 0 ? trace.steps[trace.steps.length - 1] : null
  const nodeIndex = last !== null && typeof last['node_index'] === 'number' ? (last['node_index'] as number) : null
  const contract = last !== null && typeof last['contract_id'] === 'string' ? (last['contract_id'] as string) : null
  return { iter: rs.iter, node_index: nodeIndex, contract_id: contract }
}

/** 自续跑 eval 的 args：回合身份 + 线程（投影切片由 `inject` 注入）。 */
function continuationArgs(bag: Rec, turnId: string): Rec {
  const args: Rec = { turn_id: turnId }
  const thread = asString(bag['thread'])
  if (thread !== null) args['thread'] = thread
  return args
}

/** 跑一次 iter：拓扑序前推，sink 延后到回合收口。 */
async function runIter(
  input: InterpretInput,
  view: ReturnType<typeof buildView>,
  ids: string[],
  edges: Rec[],
  contracts: Map<string, Rec>,
  sink: number,
  scopeCtx: { workspace_id: string | null; session_id: string | null },
  rs: RunState,
  iter: IterState,
  directives: Json[],
  providerOf: (tool: string) => string,
): Promise<IterResult> {
  const { model, trace, bag } = input
  const turnId = asString(bag['turn_id'])
  for (let index = 0; index < ids.length; index++) {
    if (index === sink || iter.executed.has(index)) continue
    // 取消检查点（每次派发前）：模型与工具都在此闸后，命中即不派发本节点。
    if (isCancelled(turnId)) return { refused: null, pending: null, cancelled: true }
    const contract = contracts.get(ids[index])
    if (contract === undefined) continue
    const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, index)
    if (!isActivated(index, contract, edges, ctx)) continue
    iter.inputs.set(index, gatherInputs(index, edges, ctx))
    const dispatch = await runNode(input, view, ids, edges, contracts, scopeCtx, rs, iter, index, contract, directives, providerOf)
    if (dispatch.cancelled === true) return { refused: null, pending: null, cancelled: true }
    if (dispatch.refusal !== null) {
      trace.notTaken(countRemaining(ids, iter, sink))
      return { refused: dispatch.refusal, pending: null }
    }
    if (dispatch.pending !== null) return { refused: null, pending: dispatch.pending }
  }
  trace.notTaken(Math.max(0, ids.length - 1 - iter.executed.size))
  return { refused: null, pending: null }
}

function countRemaining(ids: string[], iter: IterState, sink: number): number {
  let count = 0
  for (let i = 0; i < ids.length; i++) if (i !== sink && !iter.executed.has(i)) count += 1
  return count
}

/** post 失败原因 → 拒绝码：模型空产出可重试；其余按能力错配（不可重试）。 */
function postRefusalCode(reason: string): string {
  return reason === 'empty_output' ? 'empty_output' : 'capability_mismatch'
}

/** 求值 pre → 选实例 → 派发 → 求值 post；拒绝短路。 */
async function runNode(
  input: InterpretInput,
  view: ReturnType<typeof buildView>,
  ids: string[],
  edges: Rec[],
  contracts: Map<string, Rec>,
  scopeCtx: { workspace_id: string | null; session_id: string | null },
  rs: RunState,
  iter: IterState,
  index: number,
  contract: Rec,
  directives: Json[],
  providerOf: (tool: string) => string,
): Promise<NodeRunResult> {
  const { model, env, trace, bag, pins } = input
  void view
  void edges
  const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, index)
  const pre = evalPre(contractPre(contract), ctx)
  if (!pre.ok) {
    trace.refuse(index, rs.iter, pre.code ?? 'pre_unsat', attributionOf(model, pre.code ?? 'pre_unsat'))
    return { refusal: refusalArtifact(model, pre.code ?? 'pre_unsat', pre.reason ?? 'pre_unsat'), pending: null }
  }
  const chosen = selectInstance(model, contract, scopeCtx)
  if (chosen === null) {
    trace.refuse(index, rs.iter, 'scope_mismatch', attributionOf(model, 'scope_mismatch'))
    return { refusal: refusalArtifact(model, 'scope_mismatch', `no instance for ${ids[index]}`), pending: null }
  }
  const step = trace.startStep(index, rs.iter, ids[index], chosen.chosen_instance, chosen.chosen_agent)
  // 回合步记录按 `turn_id` 键；无回合身份（如单测直调）时跳过步记录写入。
  const turnId = asString(bag['turn_id'])
  const toolsList = Array.isArray(bag['tools']) ? (bag['tools'] as Json[]) : []
  // 审批 / 提问需把跨 run 游标随队列项落世界：派发前把游标放进 bag（approval.enqueue / #48 question 读 args.cursor）。
  const preContractId = contractId(contract)
  let pendingCursor: Rec | null = null
  if (preContractId === 'approval.wait') {
    pendingCursor = graphCursor('approval', index, rs, iter, null, bag['input'], turnId)
    bag['cursor'] = pendingCursor
  }
  if (preContractId === 'tool.dispatch') {
    const questionCall = firstQuestionCall(Array.isArray(rs.lastCalls) ? rs.lastCalls : [])
    if (questionCall !== null) bag['cursor'] = graphCursor('question', index, rs, iter, questionCall, bag['input'], turnId)
  }

  // post 不过：可重试码（如模型偶发空产出）重跑本节点，达上限才收口为拒绝；其余立即拒绝。
  const postRetryMax = numericThreshold(model.thresholds, 'post_retry_max', 2)
  let output: Rec = {}
  let logSeq = rs.steps
  for (let attempt = 0; ; attempt++) {
    const effBefore = trace.effLog.length
    rs.steps += 1
    logSeq = rs.steps
    // 先写意图再执行：有副作用的工具派发前，step.intent 必须已落盘；写不进就不派发。
    if (turnId !== null && preContractId === 'tool.dispatch') {
      const intent = await appendStep(input.port, {
        type: 'step.intent',
        turn_id: turnId,
        seq: logSeq,
        kind: 'tool.dispatch',
        tool_calls: toolCallsForLog(Array.isArray(rs.lastCalls) ? rs.lastCalls : []),
      })
      if (!intent.ok) {
        step['verdict'] = 'fail'
        step['refusal'] = 'owner_unavailable'
        trace.refuse(index, rs.iter, 'owner_unavailable', 'owner')
        return { refusal: refusalArtifact(model, 'owner_unavailable', 'turn step append failed'), pending: null }
      }
    }
    const result = await dispatchNode({
      nodeIndex: index,
      iter: rs.iter,
      contract,
      instance: chosen,
      inputs: iter.inputs.get(index) ?? {},
      bag,
      model,
      pins,
      rs,
      env,
      port: input.port,
      trace,
    })
    trace.attachEff(step, trace.effLog.slice(effBefore) as Rec[])

    // 取消检查点（派发后）：模型调用被 abort，或派发期间置了标志 ⇒ 不再处理产出、不短路成拒绝。
    if (isCancelled(asString(bag['turn_id']))) {
      step['verdict'] = 'cancelled'
      return { refusal: null, pending: null, cancelled: true }
    }

    if (result.outcome === 'transport_failed') {
      step['verdict'] = 'fail'
      step['refusal'] = 'transport_failed'
      trace.refuse(index, rs.iter, 'transport_failed', attributionOf(model, 'transport_failed'))
      return { refusal: refusalArtifact(model, 'transport_failed', result.code ?? 'transport_failed'), pending: null }
    }
    if (result.outcome === 'error') {
      const code = result.code ?? 'downstream_refusal'
      step['verdict'] = 'fail'
      step['refusal'] = code
      trace.refuse(index, rs.iter, code, attributionOf(model, code))
      return { refusal: refusalArtifact(model, code, `node ${ids[index]} failed`), pending: null }
    }

    output = isRecord(result.value) ? (result.value as Rec) : { value: result.value }
    applySideEffects(ids[index], output, rs, providerOf)
    // post 的输入面含本 Scope outputs：先落槽再求值，不过则短路（不产产物）。
    iter.outputs.set(index, output)
    const post = evalPost(contractPost(contract), ruleCtx(rs, model, bag, iter, trace.effLog, index))
    if (post.ok) break
    const reason = post.reason ?? 'post_failed'
    const code = postRefusalCode(reason)
    if (retriableOf(model, code) && attempt < postRetryMax) continue
    step['verdict'] = 'fail'
    step['post_failed'] = reason
    trace.refuse(index, rs.iter, code, attributionOf(model, code))
    return { refusal: refusalArtifact(model, code, reason), pending: null }
  }
  iter.executed.add(index)
  for (const directive of directivesOf(output)) directives.push(directive)
  // 工具结果里的写计划冒泡（question / todo 等）：#27 只回 results，由 #33 收集。
  for (const directive of nestedDirectivesOf(output)) directives.push(directive)

  if (preContractId === 'approval.wait') {
    const extern = externPayload(output)
    if (extern !== null && extern['ok'] === true) {
      // approval.pending 事件只由 #32 approval.enqueue 发（规范载荷），本插件不重复发。
      const cursor = pendingCursor ?? graphCursor('approval', index, rs, iter, null, bag['input'], turnId)
      return { refusal: null, pending: { kind: 'approval', cursor } }
    }
  }
  if (preContractId === 'tool.dispatch') {
    // 一次性 grant 只服务于本次裁决放行：派发完成即从 bag 摘除，避免后续 iter 的未批准调用复用。
    if (bag['grant'] !== undefined) delete bag['grant']
    const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
    if (calls.length > 0) rs.dispatchedTools = true
    const questionCall = firstQuestionCall(calls)
    if (questionCall !== null) rs.questionPending = true
    appendToolMessages(rs, output)
    // 工具已执行：把结果步追加进回合日志（工具卡状态随之定稿）。
    if (turnId !== null) {
      await appendStep(input.port, {
        type: 'step.result',
        turn_id: turnId,
        seq: logSeq,
        assistant: accumulatedAssistant(rs, toolsList),
        tool_results: Array.isArray(output['results']) ? (output['results'] as Json[]) : [],
      })
    }
    if (questionCall !== null) {
      // 提问挂起：段以 awaiting 收束、回合保持 open（段终态，不是回合终态，故不 settle）。
      // 游标随队列项持久化；作答经 `chat.resume` 续同一回合——与审批挂起收束同形。
      return { refusal: null, pending: { kind: 'question', cursor: bag['cursor'] ?? null } }
    }
  }
  if (preContractId === 'agent.step' || preContractId === 'subagent') {
    // 子代理返回结构化结果：落 `checkpoint` 步记录（父回合吸收蒸馏结论，不吸收子代理全程记录）。
    if (preContractId === 'subagent' && turnId !== null) {
      const structured = isRecord(output['result']) ? (output['result'] as Rec) : null
      if (structured !== null && Object.keys(structured).length > 0) {
        await appendStep(input.port, {
          type: 'checkpoint',
          turn_id: turnId,
          seq: logSeq,
          summary: structured,
          covered_upto: logSeq,
        })
      }
    }
    // 带工具调用的助手承接帧先落盘：工具结果未知时工具卡也已在历史里（结果未知 ≠ 没有记录）。
    const message = isRecord(output['message']) ? (output['message'] as Rec) : null
    const calls = message !== null && Array.isArray(message['tool_calls']) ? (message['tool_calls'] as Json[]) : []
    if (turnId !== null && message !== null && calls.length > 0) {
      await appendStep(input.port, {
        type: 'step.result',
        turn_id: turnId,
        seq: logSeq,
        assistant: assistantRecord(rs, message, toolsList),
      })
    }
  }
  if (preContractId === 'tool.gate') {
    // 工具被拒绝不是回合拒绝：拒绝作工具结果回灌，回合继续（模型可换方案）。
    const verdict = asString(output['verdict'])
    if (verdict === 'deny') {
      const results = feedBackDenied(rs)
      rs.dispatchedTools = true
      if (turnId !== null) {
        await appendStep(input.port, {
          type: 'step.result',
          turn_id: turnId,
          seq: logSeq,
          assistant: accumulatedAssistant(rs, toolsList),
          tool_results: results,
        })
      }
    }
  }
  if (preContractId === 'verify') {
    const report = output['report']
    if (isRecord(report) && report['skipped'] !== true && report['passed'] === false) rs.verifyFailed = true
    if (report !== undefined) {
      const text = `verify: ${JSON.stringify(report)}`
      rs.extraMessages.push({ role: 'tool', content: text })
      // 报告落步记录（checkpoint 形状的非终态步）：后续段据步记录重建 extra_messages，报告不丢。
      if (turnId !== null) {
        await appendStep(input.port, {
          type: 'checkpoint',
          turn_id: turnId,
          seq: logSeq,
          summary: { kind: 'verify', text },
          covered_upto: logSeq,
        })
      }
    }
  }
  return { refusal: null, pending: null }
}

/** 一次性 `caps.grant` 有效期（毫秒）；`expires` 用帧 `env.now` 判，不取系统时钟。 */
const GRANT_TTL_MS = 10 * 60 * 1000

/**
 * 工具调用 → `sandbox.fsop` op（与 #28 tool-fs 的映射契约对齐）：read→read / glob→list / grep→grep /
 * stat→stat / edit→replace（old 非空）/ write（old 空）。映射住 #33（grant 签发者），#28 只透传 grant 不解释。
 */
function fsopOpOf(tool: string, args: Rec): { op: string; write: boolean } | null {
  if (tool === 'read') return { op: 'read', write: false }
  if (tool === 'glob') return { op: 'list', write: false }
  if (tool === 'grep') return { op: 'grep', write: false }
  if (tool === 'stat') return { op: 'stat', write: false }
  if (tool === 'edit') {
    const old = args['old']
    return typeof old === 'string' && old.length > 0 ? { op: 'replace', write: true } : { op: 'write', write: true }
  }
  const explicit = args['op']
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { op: explicit, write: explicit === 'write' || explicit === 'replace' }
  }
  return null
}

/** 触发升级的 call（从游标 gate 产出的 decisions 取 index，再回到 `last_calls` 拿 call_id / args）。 */
function escalatedCall(cursor: Rec, rs: RunState): Rec | null {
  const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
  const outputs = isRecord(cursor['outputs']) ? (cursor['outputs'] as Rec) : {}
  for (const value of Object.values(outputs)) {
    if (!isRecord(value) || !Array.isArray(value['decisions'])) continue
    for (const decision of value['decisions'] as Json[]) {
      if (!isRecord(decision) || decision['verdict'] !== 'escalate') continue
      const index = numberField(decision['index']) ?? -1
      const call = calls[index]
      if (isRecord(call)) return call
    }
  }
  return calls.length > 0 ? calls[0] : null
}

/**
 * 裁决批准后构造一次性 `caps.grant`（形状与 #25 `sandbox` 消费口径一致：`call_id` / `op` / `paths` /
 * `fs` / `net` / `tier` / `expires`）。`paths` 为空 = 不适用；`fs` / `net` 只声明本次所需维度（未声明不放宽）。
 * net 越档升级批准时，签发 `op:"exec"` + `net:<声明范围>`，供 sandbox exec / tool-browser 本插件侧放行本次。
 */
function approvalGrant(bag: Rec, env: CallEnv, rs: RunState, cursor: Rec): Rec | null {
  const call = escalatedCall(cursor, rs)
  if (call === null) return null
  const callId = asString(call['call_id'])
  if (callId === null) return null
  const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
  const tool = asString(call['tool']) ?? ''
  const mapped = fsopOpOf(tool, args)
  const path = asString(args['path'])
  const now = numberField(env.now) ?? numberField(bag['now']) ?? 0
  const grant: Rec = {
    call_id: callId,
    tier: bag['tier'] ?? null,
    expires: now + GRANT_TTL_MS,
  }
  if (mapped !== null) grant['op'] = mapped.op
  if (path !== null) grant['paths'] = [path]
  if (mapped !== null) grant['fs'] = mapped.write ? { write: 'full' } : { read: 'full' }
  // net 越档：从游标里升级裁决的 rule 取声明范围（resume 时 bag 无目录，不能反查 caps），
  // 随批准签发 net 放宽；sandbox 只认绑定 `exec` 的 grant，fs 未映射时补上。
  const netEscalation = netEscalationOf(cursor, rs)
  if (netEscalation !== null) {
    grant['net'] = netEscalation.net
    if (grant['op'] === undefined) grant['op'] = 'exec'
  }
  return grant
}

/** 首个升级裁决若是 net 越档，返回其声明 net 范围（与 `escalatedCall` 取同一条，避免张冠李戴）。 */
function netEscalationOf(cursor: Rec, rs: RunState): { call: Rec; net: string } | null {
  const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
  const outputs = isRecord(cursor['outputs']) ? (cursor['outputs'] as Rec) : {}
  for (const value of Object.values(outputs)) {
    if (!isRecord(value) || !Array.isArray(value['decisions'])) continue
    for (const decision of value['decisions'] as Json[]) {
      if (!isRecord(decision) || decision['verdict'] !== 'escalate') continue
      // 只看首个升级项（与 escalatedCall 同选）：不是 net 越档即返回 null。
      if (decision['reason'] !== 'net_outside_tier') return null
      const index = numberField(decision['index']) ?? -1
      const call = calls[index]
      if (isRecord(call)) return { call, net: netScopeOf(decision['rule']) }
      return null
    }
  }
  return null
}

function firstQuestionCall(calls: Rec[]): string | null {
  for (const call of calls) {
    if (call['tool'] === 'question' && typeof call['call_id'] === 'string') return call['call_id'] as string
  }
  return null
}

/** 从 step 输出提取 calls 与消息（供 gate / dispatch 与跨 iter 记忆）。 */
function applySideEffects(
  contractIdValue: string,
  output: Rec,
  rs: RunState,
  providerOf: (tool: string) => string,
): void {
  if (contractIdValue === 'agent.step' || contractIdValue === 'subagent') {
    rs.lastCalls = toCalls(output, providerOf)
    const message = isRecord(output['message']) ? (output['message'] as Rec) : null
    rs.messages = message !== null ? [message] : []
    // 最近一次模型调用用量暂存本段状态，供下一次上下文组装校准估算（缺失时保留上一次已知值）。
    if (message !== null && isRecord(message['usage'])) rs.shared['last_usage'] = message['usage']
    return
  }
  // 上下文组装算出的模型参数（含预算用的 `max_output`）暂存本段状态，供模型调用对齐真实输出上限。
  // 组装清单（used / budget）另存一份，供段边界检查点判定上下文压力；缓存提示原样留给模型调用。
  if (contractIdValue === 'context.assemble') {
    const params = isRecord(output['params']) ? (output['params'] as Rec) : null
    if (params !== null) rs.shared['model_params'] = params
    if (isRecord(output['manifest'])) rs.shared['context_manifest'] = output['manifest']
    if (isRecord(output['cache'])) rs.shared['last_cache'] = output['cache']
  }
}

function appendToolMessages(rs: RunState, output: Rec): void {
  const calls = Array.isArray(rs.lastCalls) ? (rs.lastCalls as Rec[]) : []
  const message = rs.messages.length > 0 ? rs.messages[0] : null
  // 先回灌 assistant 消息（带 tool_calls），再回灌各工具结果（带 tool_call_id）：
  // 形成规范的 assistant(tool_calls) → tool(tool_call_id) 序列，模型才认得出「已调用并拿到结果」。
  if (message !== null && calls.length > 0) rs.extraMessages.push(message)
  const results = Array.isArray(output['results']) ? (output['results'] as Json[]) : []
  results.forEach((result, index) => {
    const rec = isRecord(result) ? result : null
    const fromResult = rec !== null && typeof rec['call_id'] === 'string' ? (rec['call_id'] as string) : null
    const fromCall =
      calls[index] !== undefined && typeof calls[index]['call_id'] === 'string'
        ? (calls[index]['call_id'] as string)
        : null
    rs.extraMessages.push({
      role: 'tool',
      tool_call_id: fromResult ?? fromCall ?? `call-${index}`,
      content: JSON.stringify(result),
    })
  })
}

/** 累积展示记录：正文取最后一条助手消息，parts 由已回灌时间线（含工具结果）折叠而成。 */
function accumulatedAssistant(rs: RunState, tools: Json[]): Rec {
  const partial = rs.messages.length > 0 && isRecord(rs.messages[0]) ? (rs.messages[0] as Rec) : {}
  const assistant: Rec = { content: typeof partial['content'] === 'string' ? (partial['content'] as string) : '' }
  const parts = displayParts(rs.extraMessages, null, tools)
  if (parts.some((part) => isRecord(part) && part['type'] !== 'text')) assistant['parts'] = parts
  return assistant
}

/** 门禁拒绝：把拒绝原因作工具结果回灌，保住配对与助手正文，回合继续。 */
function feedBackDenied(rs: RunState): Rec[] {
  const calls = Array.isArray(rs.lastCalls) ? (rs.lastCalls as Rec[]) : []
  const message = rs.messages.length > 0 ? rs.messages[0] : null
  if (message !== null && calls.length > 0) rs.extraMessages.push(message)
  const results = calls.map((call, index) => ({
    call_id: typeof call['call_id'] === 'string' ? (call['call_id'] as string) : `call-${index}`,
    ok: false,
    error: { code: 'denied', message: 'tool call denied by guard; choose another approach' },
  }))
  for (const result of results) {
    rs.extraMessages.push({ role: 'tool', tool_call_id: result.call_id, content: JSON.stringify(result) })
  }
  return results
}


