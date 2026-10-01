// 服务自驱图解释器：顺序推进（读图数据 → 选实例 → pre → port.call 派发 → post → when 定下一 Scope → sink 收口）。
// 推式条件边 + 拒绝短路到 sink + 回合重入（Graph.loop）+ MAX_STEPS/gas 自限 + 审批/提问跨 run 续跑。
// 游标是服务进程内状态（跨 run 续跑时序列化进队列项游标落世界）。

import {
  assistantRecord,
  dispatchNode,
  lastReasoningOf,
  netScopeOf,
  providerResolver,
  toCalls,
} from './dispatch.ts'
import { commitParts, committedFromSteps, committedPartsOf, displayParts, incrementalParts, mergeParts } from './commit-parts.ts'
import { isCancelled } from './cancel.ts'
import { appendStep, nextStepSeq, toolCallsForLog } from './steplog.ts'
import {
  attributionOf,
  contractId,
  contractIndex,
  contractOutputs,
  contractPost,
  contractPre,
  edgeWhen,
  graphEdges,
  graphLoop,
  graphNodes,
  graphSink,
  nodeId,
  nodeImpl,
  nodeSubgraph,
  numericThreshold,
  retriableOf,
} from './model.ts'
import { buildView } from './view.ts'
import { edgeKey, topoOrder } from './graph.ts'
import { LifecycleMachine, endedOf, type GraphProgress } from './lifecycle.ts'
import { detectStall, segmentSignature } from './loop-guard.ts'
import {
  asString,
  directivesOf,
  evalDirective,
  isRecord,
  nestedDirectivesOf,
  numberField,
} from './plan.ts'
import { evalPost, evalPre, evalWhen, unknownWhenExpr } from './rules.ts'
import { selectInstance } from './scope.ts'
import {
  consumeBranches,
  externPayload,
  freshState,
  overTriggeredBranch,
  refusalArtifact,
  resolveInputs,
  ruleCtx,
  type InterpretInput,
  type InterpretResult,
  type IterState,
} from './iter-ctx.ts'
import {
  graphCursor,
  patchQuestionAnswer,
  resumePayload,
  resumeVerdict,
  restoreState,
} from './cursor.ts'
import { restoreFromSteps, turnSteps } from './reconstruct.ts'
import { runSink, runSuspend, summaryOfRun } from './sink.ts'
import type { TraceRecorder } from './trace.ts'
import type { CallEnv, GraphModel, Json, PortCaller, Rec, RunState, ServiceEvent } from './types.ts'

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

/** 终态附加信息：预算主动收口的 `stop_reason`。 */
interface TerminalExtra {
  stopReason?: string | null
}

/** 空转 nudge：升级阶梯的第一步——先提示模型换策略，再次命中才收口。 */
const LOOP_NUDGE =
  '检测到连续无进展（相同调用/结果重复、或短周期来回）。请停止重复同一操作：换用不同策略，或直接给出结论并结束本轮。'

/**
 * 客户端在本回合轮次边界是否有排队输入：据此挂起，等其由 `resume` 提升为 `step.user` 再恢复。
 * 读取失败（端口不支持 / 回合未知）一律按无输入处理（fail-open 到原行为，不误挂起）。
 */
async function hasPendingInput(input: InterpretInput, turnId: string): Promise<boolean> {
  try {
    const res = await input.port.call('session', 'turn_has_pending_input', { turn_id: turnId })
    return res.ok && isRecord(res.value) && res.value['pending'] === true
  } catch {
    return false
  }
}

/** 派发失败值里携带的中止碎片（`error.partial`）。 */
function partialOf(result: { value: Json }): Rec | null {
  const value = result.value
  if (!isRecord(value) || !isRecord(value['error'])) return null
  const partial = value['error']['partial']
  return isRecord(partial) ? partial : null
}

/**
 * 取消 / 中止时把模型已产出的碎片（正文 / 推理）落一条 `step.result`：刷新 / 重放后仍在，
 * 不因未走完收口节点而丢失。best-effort：写不进不影响取消收口。
 */
async function persistPartialStep(
  input: InterpretInput,
  bag: Rec,
  rs: RunState,
  partial: Rec,
): Promise<void> {
  const turnId = asString(bag['turn_id'])
  if (turnId === null) return
  const text = asString(partial['text']) ?? ''
  const reasoning = asString(partial['reasoning']) ?? ''
  if (text.length === 0 && reasoning.length === 0) return
  const parts: Json[] = []
  if (reasoning.length > 0) parts.push({ type: 'reasoning', text: reasoning })
  if (text.length > 0) parts.push({ type: 'text', text })
  const record: Rec = {
    type: 'step.result',
    turn_id: turnId,
    seq: nextStepSeq(rs),
    assistant: { content: text, parts },
  }
  await appendStep(input.port, record)
}

/** 签名窗口上限：repeat/cycle/low_novelty 所需的最大回看段数。 */
const LOOP_WINDOW = 16

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
  const scopeCtx = {
    workspace_id: asString(bag['workspace_id']),
    session_id: asString(bag['session_id']),
  }
  const maxTurnIter = numericThreshold(model.thresholds, 'max_turn_iter', 6)
  const maxSteps = numericThreshold(model.thresholds, 'max_steps', 64)
  const loopRepeatN = numericThreshold(model.thresholds, 'loop_repeat_n', 3)
  const loopNoveltyWindow = numericThreshold(model.thresholds, 'loop_novelty_window', 8)
  const loopNoveltyMin = numericThreshold(model.thresholds, 'loop_novelty_min', 2)
  // per-tool 白名单：轮询类工具（参数/结果随外部状态变化）豁免空转判定；图可经 loop.allow_tools 声明。
  const loopAllow = new Set(
    (Array.isArray(graphLoop(model.graph)['allow_tools'])
      ? (graphLoop(model.graph)['allow_tools'] as Json[])
      : []
    ).filter((item): item is string => typeof item === 'string'),
  )
  const turnId = asString(bag['turn_id'])
  const loopWhen = asString(graphLoop(model.graph)['when']) ?? ''
  const directives: Json[] = []
  const events: ServiceEvent[] = []
  const pendingCursor =
    input.resume !== null && isRecord(input.resume['cursor'])
      ? (input.resume['cursor'] as Rec)
      : null
  const continuation = input.resume !== null && input.resume['continuation'] === true
  // 分支全域登记（含 composite 子图在展开时追加）：供 `branch_not_taken` 精确计数，与 sink 位置无关。
  trace.declareBranches(
    edges.map((edge) => edgeKey(edge)).filter((key): key is string => key !== null),
  )
  // 子图运行期展开的 gas 预算（与步预算 / 深度上限共同防嵌套失控）。
  const gas = { remaining: numericThreshold(model.thresholds, 'gas', 64) }

  // 取消检查点（入口）：标志在进入解释前已置时立即停，不派发任何节点（含模型与工具）。
  if (isCancelled(turnId)) {
    const stopped = freshState()
    const machine = new LifecycleMachine({
      iter: stopped.iter,
      node_index: null,
      contract_id: null,
    })
    machine.send('settle')
    machine.send('finalize')
    trace.finalizeBranches()
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
  if (
    pendingCursor !== null &&
    (pendingCursor['kind'] === 'approval' || pendingCursor['kind'] === 'question')
  ) {
    const restored = restoreState(pendingCursor)
    rs = restored.rs
    iter = restored.iter
    // 展示段基线是不进游标的派生物：恢复后从步日志重导，续写增量才不重复回灌已落盘的段。
    rs.committedParts = committedFromSteps(turnSteps(bag, turnId))
    // 续跑优先用游标内原始输入：作答 / 裁决那一刻的槽已是 approval.decide / question.answer，
    // 直接用会丢原始用户消息（游标随队列项落世界，opaque，不透明）。
    if (pendingCursor['original_input'] !== undefined)
      bag['input'] = pendingCursor['original_input']
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
      // 结果取整份 payload（`{answers, render?}`）：`render` 是 question 服务的动态卡描述符，
      // 随结果进展示段（commit-parts 口径），使作答后的落盘 part 仍带题干与 `detail.id`。
      const payload = resumePayload(input.resume)
      const callId = asString(pendingCursor['call_id'])
      patchQuestionAnswer(iter, nodeIndex, callId, payload, rs.lastCalls)
      rs.dispatchedTools = true
      // 答案以与同步环同形的 assistant(tool_calls) → tool(result) 序列回灌 extra_messages：
      // 无回合身份（同步重入）时本段重跑 assemble 即见答案；有回合身份时改由步记录在重入段重建。
      appendToolMessages(rs, {
        results: [{ call_id: callId ?? 'question', ok: true, result: payload }],
      })
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
        // 显式工具卡步：并入已落盘基线，后续增量比较据它判「无新内容」，不重复回写。
        commitParts(rs, mergeParts(committedPartsOf(rs), parts))
        await appendStep(input.port, {
          type: 'step.result',
          turn_id: turnId,
          seq: rs.steps,
          assistant: { content: '', parts },
          tool_results: [{ call_id: callId ?? 'question', ok: true, result: payload }],
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
  ): InterpretResult => {
    trace.finalizeBranches()
    return {
      directives,
      events,
      pending,
      summary: summaryOfRun(rs, pending),
      state: rs,
      ended,
      lifecycle: machine.state,
      progress: progressOf(rs, trace),
      stopReason: extra.stopReason ?? null,
      refusedOutcome: null,
    }
  }
  // 拒绝收口：进 settling → runSink 落盘本轮内容 → settled；拒绝码与归因原样进 trace / 结局。
  const refuseTerminal = async (code: string, message: string): Promise<InterpretResult> => {
    trace.refuse(sink, rs.iter, code, attributionOf(model, code))
    machine.send('settle')
    await runSink(
      input,
      view,
      ids,
      edges,
      contracts,
      sink,
      scopeCtx,
      rs,
      iter,
      directives,
      refusalArtifact(model, code, message),
    )
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

  // 判据 fail-closed：任何未知 `when` 判据（边与 loop）在进入迭代前显式拒绝，不静默按 false 处理。
  const unknownWhen = unknownWhenExpr([...edges.map((edge) => edgeWhen(edge)), loopWhen])
  if (unknownWhen !== null) {
    return refuseTerminal('when_unsat', `unknown predicate: ${unknownWhen}`)
  }
  // 运行期轻量闭合校验（G6）：篡改 / 旧代 `bag.graph` 形状非法时结构化拒绝，不静默误执行。
  // 完整六不变量 + 演化规则仍在 propose / validate 期由 `graph-gate` 执行，此处只做廉价结构检查。
  const structural = await closureError(input.port, model, model.graph, input.refs)
  if (structural !== null) {
    return refuseTerminal(structural.code, structural.message)
  }
  const started = machine.send('step', progressOf(rs, trace))
  if (!started.ok) {
    return refuseTerminal(
      'invalid_contract',
      `invalid lifecycle transition ${started.failure.from}--${started.failure.event}`,
    )
  }

  for (;;) {
    const extraStart = rs.extraMessages.length
    const result = await runIter(
      input,
      view,
      ids,
      edges,
      contracts,
      sink,
      scopeCtx,
      rs,
      iter,
      directives,
      providerOf,
      gas,
      0,
      null,
    )
    // nudge 已在本次 runIter 的组装消费（一次性），此处清掉，避免下一段重复注入。
    rs.loopNudge = null
    if (result.cancelled === true) {
      // 取消：不再派发新工具 / 模型，也不写拒绝产物；内容已落步记录，终态由调用方经 CAS 落 `cancelled`。
      machine.send('settle')
      machine.send('finalize')
      return finish(endedOf(machine.state, 'cancelled'))
    }
    if (result.pending !== null) {
      // 显式挂起收口：先把本轮已发生的用户 / 助手消息与已执行工具结果落账，再以 `suspended` 收口。
      machine.send('suspend', progressOf(rs, trace))
      await runSuspend(
        input,
        view,
        ids,
        edges,
        contracts,
        sink,
        scopeCtx,
        rs,
        iter,
        directives,
        result.pending,
      )
      return finish(endedOf(machine.state, 'done'), result.pending)
    }
    if (result.refused !== null) {
      machine.send('settle')
      await runSink(
        input,
        view,
        ids,
        edges,
        contracts,
        sink,
        scopeCtx,
        rs,
        iter,
        directives,
        result.refused,
      )
      machine.send('finalize')
      return finish(endedOf(machine.state, 'refused'))
    }
    const loopCtx = ruleCtx(rs, model, bag, iter, trace.effLog, 0)
    // 无 loop.when ⇒ 不重入（缺省即单轮）；question_pending 优先 ⇒ 本 run 正常结束。
    let shouldLoop = false
    if (!rs.questionPending && loopWhen.length > 0) {
      const when = evalWhen(loopWhen, loopCtx, 0)
      if (!when.ok)
        return refuseTerminal(when.code ?? 'when_unsat', when.reason ?? `unknown_when:${loopWhen}`)
      shouldLoop = when.value
    }
    // 无进展空转检测（确定性）：签名 = 动作 + 观察（工具结果）+ 状态增量。升级阶梯：首次命中先注入
    // nudge 提示换策略，再次命中才收口——既不「报告写完又被反复拉起」，也不因一次误判直接终止。
    const segmentResults = rs.extraMessages
      .slice(extraStart)
      .filter((message): message is Rec => isRecord(message) && message['role'] === 'tool')
      .map((message) => {
        const content = message['content']
        if (typeof content !== 'string') return null
        try {
          return JSON.parse(content) as Json
        } catch {
          return content as Json
        }
      })
      .filter((value): value is Json => value !== null)
    const todo = bag['todo']
    const todoDone =
      isRecord(todo) && Array.isArray(todo['items'])
        ? (todo['items'] as Json[]).filter(
            (item) => isRecord(item) && item['status'] === 'completed',
          ).length
        : 0
    const allowHit = rs.lastCalls.some((call) => loopAllow.has(asString(call['tool'])))
    const window = allowHit
      ? rs.loopSignatures
      : [
          ...rs.loopSignatures,
          segmentSignature({
            calls: Array.isArray(rs.lastCalls) ? rs.lastCalls : [],
            results: segmentResults,
            state: { todo_done: todoDone, verify_failed: rs.verifyFailed },
          }),
        ]
    const verdict = allowHit
      ? null
      : detectStall(window, loopRepeatN, loopNoveltyWindow, loopNoveltyMin)
    if (shouldLoop && verdict !== null) {
      if (!rs.loopNudged) {
        // 第一步：注入 nudge，给模型一次换策略的机会（多数空转在此解开）。
        rs.loopNudged = true
        rs.loopNudge = `${LOOP_NUDGE}（${verdict.kind}: ${verdict.detail}）`
      } else {
        // 第二步：nudge 后仍空转 ⇒ 主动收口（保留已完成内容，非失败），与预算收口同形。
        return stopTerminal('no_progress')
      }
    } else if (verdict === null && !allowHit) {
      rs.loopNudged = false
      rs.loopNudge = null
    }
    rs.loopSignatures = window.slice(-LOOP_WINDOW)
    // 待发输入门：本段结束后若客户端有排队输入，挂起等它落盘再 resume——恢复的那一轮即读到，不晚一轮。
    // 放在 settle 之前：否则回合会先收口，排队的消息就没机会进本轮上下文。
    if (turnId !== null && (await hasPendingInput(input, turnId))) {
      machine.send('suspend', progressOf(rs, trace))
      await runSuspend(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, { kind: 'input' })
      return finish(endedOf(machine.state, 'done'), { kind: 'input' })
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
    // 图内进度一并随续跑 args 交给 chat：下一段起点即可广播，UI 轮次实时更新（不等到回合收口）。
    const segmentProgress = progressOf(rs, trace)
    machine.send('segment', segmentProgress)
    const markerSeq = nextStepSeq(rs)
    await appendStep(input.port, {
      type: 'checkpoint',
      turn_id: turnId,
      seq: markerSeq,
      summary: {
        kind: 'segment',
        iter: rs.iter + 1,
        loop_signatures: rs.loopSignatures,
        loop_nudged: rs.loopNudged,
        loop_nudge: rs.loopNudge,
      },
      covered_upto: markerSeq,
    })
    // 下一段序号 = 本段 iter + 1（与下方 checkpoint 步记录一致）：下一段起点即可显示「正在进行的轮次」。
    directives.push(
      evalDirective('chat.resume', continuationArgs(bag, turnId, segmentProgress, rs.iter + 1), {
        ids: ['ids'],
      }),
    )
    return finish(endedOf(machine.state, 'done'))
  }
}

/** 图内进度：最近一步的节点与契约 id + 当前段序号（数据，供 UI 映射「正在思考 / 正在调工具」）。 */
function progressOf(rs: RunState, trace: TraceRecorder): GraphProgress {
  const last = trace.steps.length > 0 ? trace.steps[trace.steps.length - 1] : null
  const nodeIndex =
    last !== null && typeof last['node_index'] === 'number' ? (last['node_index'] as number) : null
  const contract =
    last !== null && typeof last['contract_id'] === 'string'
      ? (last['contract_id'] as string)
      : null
  return { iter: rs.iter, node_index: nodeIndex, contract_id: contract }
}

/**
 * 自续跑 eval 的 args：回合身份 + 线程 + 下一段图内进度（投影切片由 `inject` 注入）。
 * `progress.iter` 取下一段序号：chat 在下一段 `chat.turn.started` 上广播，UI 轮次实时更新。
 */
function continuationArgs(bag: Rec, turnId: string, progress: GraphProgress, iter: number): Rec {
  const args: Rec = {
    turn_id: turnId,
    progress: { ...progress, iter } as unknown as Json,
  }
  const thread = asString(bag['thread'])
  if (thread !== null) args['thread'] = thread
  return args
}

/** 子图运行期展开的 gas 预算（可变、跨嵌套共享）。 */
interface GasState {
  remaining: number
}

/** 图数据包装：把解析后的模型拼成机械闸读入口径（六类条目；`graph` 可取子图）。 */
function graphWrapperOf(model: GraphModel, graph?: Rec): Rec {
  return {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph: graph ?? model.graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
}

/**
 * 运行期轻量结构校验（G6）：委派 `graph-gate.closure` 做未知契约 + 闭合检查。
 * 完整六不变量 + 演化规则仍在 propose / validate 期执行（`graph-gate.validate`），此处只做廉价结构检查。
 * 提供方不可用时 fail-closed 拒绝（不静默误执行）。
 */
async function closureError(
  port: PortCaller,
  model: GraphModel,
  graph: Rec,
  refs: Rec,
): Promise<{ code: string; message: string } | null> {
  const outcome = await port.call('graph-gate', 'closure', {
    graph: graphWrapperOf(model, graph),
    refs,
  })
  if (!outcome.ok) {
    return {
      code: 'graph_gate_unavailable',
      message: outcome.message || 'graph-gate.closure transport failed',
    }
  }
  const value = isRecord(outcome.value) ? (outcome.value as Rec) : null
  const errors = value !== null && Array.isArray(value['errors']) ? (value['errors'] as Json[]) : []
  const first = errors.find((error): error is Rec => isRecord(error))
  if (first === undefined) return null
  return {
    code: asString(first['code']) ?? 'unknown_contract',
    message: `${asString(first['path']) ?? ''}: ${asString(first['message']) ?? ''}`,
  }
}

/** 跑一次 iter：拓扑序前推（G1），sink 延后到回合收口。 */
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
  gas: GasState,
  depth: number,
  parentIndex: number | null,
): Promise<IterResult> {
  const { model, trace, bag } = input
  const turnId = asString(bag['turn_id'])
  // G1：按拓扑序前推（源必先于目标求值），节点身份仍是 `ids` 的数组下标。
  for (const index of topoOrder(view.topo)) {
    if (index === sink || iter.executed.has(index)) continue
    // 取消检查点（每次派发前）：模型与工具都在此闸后，命中即不派发本节点。
    if (isCancelled(turnId)) return { refused: null, pending: null, cancelled: true }
    const contract = contracts.get(ids[index])
    if (contract === undefined) continue
    const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, index)
    const resolved = resolveInputs(index, contract, edges, ctx)
    if (!resolved.activated) continue
    consumeBranches(resolved, index, trace)
    iter.inputs.set(index, resolved.inputs)
    const dispatch = await runNode(
      input,
      view,
      ids,
      edges,
      contracts,
      scopeCtx,
      rs,
      iter,
      index,
      contract,
      directives,
      providerOf,
      gas,
      depth,
      parentIndex,
    )
    if (dispatch.cancelled === true) return { refused: null, pending: null, cancelled: true }
    if (dispatch.refusal !== null) return { refused: dispatch.refusal, pending: null }
    if (dispatch.pending !== null) return { refused: null, pending: dispatch.pending }
  }
  return { refused: null, pending: null }
}

/** post 失败原因 → 拒绝码：模型空产出可重试；其余按能力错配（不可重试）。 */
function postRefusalCode(reason: string): string {
  return reason === 'empty_output' ? 'empty_output' : 'capability_mismatch'
}

/** 子图 sink 结果 → composite 节点声明 outputs 的映射（确定性）：全命中即投影；单输出缺名即整体包裹；否则歧义。 */
function mapCompositeOutput(contract: Rec, sinkOutput: Rec): { value: Rec; ambiguous: boolean } {
  const outputs = contractOutputs(contract)
  const names = outputs
    .map((port) => (typeof port['name'] === 'string' ? (port['name'] as string) : ''))
    .filter((name) => name.length > 0)
  if (names.length === 0) return { value: sinkOutput, ambiguous: false }
  const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(sinkOutput, name))
  if (missing.length === 0) {
    const projected: Rec = {}
    for (const name of names) projected[name] = sinkOutput[name] ?? null
    return { value: projected, ambiguous: false }
  }
  if (names.length === 1) return { value: { [names[0]]: sinkOutput }, ambiguous: false }
  return { value: {}, ambiguous: true }
}

interface SubgraphResult {
  output: Rec | null
  code: string | null
  message: string | null
  pending: Rec | null
  cancelled?: boolean
}

/**
 * composite 节点（G2）：把 `node.subgraph` 当独立子图运行期展开——自己的 nodes / edges / entry_supply /
 * loop / sink，实例选择沿用父 `scope`、pins 与 pre / post / when；子图 sink 的产出映射回 composite 声明 outputs。
 * 子图入口节点（下标 0）接收 composite 节点的入边输入；子图 iter.outputs/inputs 隔离，`rs.steps` 单调共享
 * （故 `(turn_id,type,seq)` 全局唯一）；子图节点步记录带 `parent_index` 以保持 branch/instance/refused 可还原。
 */
async function runCompositeNode(
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
  chosen: { node: Rec },
  step: Rec,
  directives: Json[],
  providerOf: (tool: string) => string,
  gas: GasState,
  depth: number,
  parentIndex: number | null,
): Promise<NodeRunResult> {
  const { model, trace } = input
  const subgraph = nodeSubgraph(chosen.node)
  if (subgraph === null) {
    step['verdict'] = 'fail'
    step['refusal'] = 'capability_mismatch'
    trace.refuse(
      index,
      rs.iter,
      'capability_mismatch',
      attributionOf(model, 'capability_mismatch'),
      parentIndex,
    )
    return {
      refusal: refusalArtifact(
        model,
        'capability_mismatch',
        `composite ${nodeId(chosen.node) ?? ''} without subgraph`,
      ),
      pending: null,
    }
  }
  const maxDepth = numericThreshold(model.thresholds, 'max_subgraph_depth', 8)
  if (depth >= maxDepth) {
    step['verdict'] = 'fail'
    step['refusal'] = 'max_recur'
    trace.refuse(index, rs.iter, 'max_recur', attributionOf(model, 'max_recur'), parentIndex)
    return {
      refusal: refusalArtifact(model, 'max_recur', `subgraph depth ${depth} >= ${maxDepth}`),
      pending: null,
    }
  }
  const nested = await runSubgraph(
    input,
    view,
    scopeCtx,
    rs,
    subgraph,
    index,
    depth + 1,
    iter.inputs.get(index) ?? {},
    directives,
    providerOf,
    gas,
  )
  if (nested.cancelled === true) {
    step['verdict'] = 'cancelled'
    return { refusal: null, pending: null, cancelled: true }
  }
  if (nested.pending !== null) return { refusal: null, pending: nested.pending }
  if (nested.output === null) {
    const code = nested.code ?? 'subgraph_reject'
    step['verdict'] = 'fail'
    step['refusal'] = code
    if (trace.refusedAt === null)
      trace.refuse(index, rs.iter, code, attributionOf(model, code), parentIndex)
    return {
      refusal: refusalArtifact(model, code, nested.message ?? 'subgraph refused'),
      pending: null,
    }
  }
  const mapped = mapCompositeOutput(contract, nested.output)
  if (mapped.ambiguous) {
    step['verdict'] = 'fail'
    step['refusal'] = 'delegate_output_ambiguous'
    trace.refuse(
      index,
      rs.iter,
      'delegate_output_ambiguous',
      attributionOf(model, 'delegate_output_ambiguous'),
      parentIndex,
    )
    return {
      refusal: refusalArtifact(
        model,
        'delegate_output_ambiguous',
        'subgraph sink→outputs mapping not unique',
      ),
      pending: null,
    }
  }
  const output = mapped.value
  applySideEffects(contractId(contract) ?? '', output, rs, providerOf)
  iter.outputs.set(index, output)
  const post = evalPost(
    contractPost(contract),
    ruleCtx(rs, model, input.bag, iter, trace.effLog, index),
  )
  if (!post.ok) {
    const reason = post.reason ?? 'post_failed'
    const code = postRefusalCode(reason)
    step['verdict'] = 'fail'
    step['post_failed'] = reason
    trace.refuse(index, rs.iter, code, attributionOf(model, code), parentIndex)
    return { refusal: refusalArtifact(model, code, reason), pending: null }
  }
  const over = overTriggeredBranch(
    index,
    edges,
    ruleCtx(rs, model, input.bag, iter, trace.effLog, index),
  )
  if (over !== null) {
    step['verdict'] = 'fail'
    step['refusal'] = 'redundant'
    trace.refuse(index, rs.iter, 'redundant', attributionOf(model, 'redundant'), parentIndex)
    return {
      refusal: refusalArtifact(
        model,
        'redundant',
        `output port ${over.port} took multiple branches`,
      ),
      pending: null,
    }
  }
  iter.executed.add(index)
  for (const directive of directivesOf(output)) directives.push(directive)
  for (const directive of nestedDirectivesOf(output)) directives.push(directive)
  void ids
  void contracts
  return { refusal: null, pending: null }
}

/** 运行期展开子图：自己的拓扑 / sink；返回 sink 产出或结构化拒绝 / 挂起 / 取消。 */
async function runSubgraph(
  input: InterpretInput,
  parentView: ReturnType<typeof buildView>,
  scopeCtx: { workspace_id: string | null; session_id: string | null },
  rs: RunState,
  subgraph: Rec,
  parentIndex: number,
  depth: number,
  initialInputs: Rec,
  directives: Json[],
  providerOf: (tool: string) => string,
  gas: GasState,
): Promise<SubgraphResult> {
  const { model, trace } = input
  const nestedModel = { ...model, graph: subgraph }
  const view = buildView(nestedModel)
  const ids = graphNodes(subgraph)
  const edges = graphEdges(subgraph)
  const sink = graphSink(subgraph)
  const contracts = view.contracts
  trace.declareBranches(
    edges.map((edge) => edgeKey(edge)).filter((key): key is string => key !== null),
  )
  const structural = await closureError(input.port, model, subgraph, input.refs)
  if (structural !== null)
    return { output: null, code: structural.code, message: structural.message, pending: null }
  const iter: IterState = { outputs: new Map(), inputs: new Map(), executed: new Set() }
  if (Object.keys(initialInputs).length > 0) iter.inputs.set(0, initialInputs)
  const maxSteps = numericThreshold(model.thresholds, 'max_steps', 512)
  const maxDepth = numericThreshold(model.thresholds, 'max_subgraph_depth', 8)

  const runOne = async (index: number): Promise<SubgraphResult | null> => {
    const contract = contracts.get(ids[index])
    if (contract === undefined) return null
    if (depth > maxDepth)
      return {
        output: null,
        code: 'max_recur',
        message: `subgraph depth ${depth} > ${maxDepth}`,
        pending: null,
      }
    if (gas.remaining <= 0 || rs.steps >= maxSteps) {
      return {
        output: null,
        code: 'subgraph_incomplete',
        message: 'subgraph budget exhausted',
        pending: null,
      }
    }
    gas.remaining -= 1
    if (isCancelled(asString(input.bag['turn_id'])))
      return { output: null, code: null, message: null, pending: null, cancelled: true }
    const ctx = ruleCtx(rs, model, input.bag, iter, trace.effLog, index)
    const resolved = resolveInputs(index, contract, edges, ctx)
    if (!resolved.activated) return null
    consumeBranches(resolved, index, trace)
    // 子图入口已带 composite 入边输入：与边收集输入合并（预置优先）。
    const preset = iter.inputs.get(index)
    iter.inputs.set(
      index,
      preset !== undefined ? { ...resolved.inputs, ...preset } : resolved.inputs,
    )
    const dispatched = await runNode(
      input,
      parentView,
      ids,
      edges,
      contracts,
      scopeCtx,
      rs,
      iter,
      index,
      contract,
      directives,
      providerOf,
      gas,
      depth,
      parentIndex,
    )
    if (dispatched.cancelled === true)
      return { output: null, code: null, message: null, pending: null, cancelled: true }
    if (dispatched.pending !== null)
      return { output: null, code: null, message: null, pending: dispatched.pending }
    if (dispatched.refusal !== null) {
      return {
        output: null,
        code: dispatched.refusal['code'] as string,
        message: dispatched.refusal['message'] as string,
        pending: null,
      }
    }
    return null
  }

  for (const index of topoOrder(view.topo)) {
    if (iter.executed.has(index)) continue
    const result = await runOne(index)
    if (result !== null) return result
  }
  // sink 未被激活时仍按收口语义跑一次（与 `runSink` 同形；入口=sink 已在环内执行）。
  if (!iter.executed.has(sink) && contracts.has(ids[sink])) {
    const contract = contracts.get(ids[sink]) as Rec
    const ctx = ruleCtx(rs, model, input.bag, iter, trace.effLog, sink)
    const resolved = resolveInputs(sink, contract, edges, ctx)
    consumeBranches(resolved, sink, trace)
    const preset = iter.inputs.get(sink)
    iter.inputs.set(
      sink,
      preset !== undefined ? { ...resolved.inputs, ...preset } : resolved.inputs,
    )
    const dispatched = await runNode(
      input,
      parentView,
      ids,
      edges,
      contracts,
      scopeCtx,
      rs,
      iter,
      sink,
      contract,
      directives,
      providerOf,
      gas,
      depth,
      parentIndex,
    )
    if (dispatched.cancelled === true)
      return { output: null, code: null, message: null, pending: null, cancelled: true }
    if (dispatched.pending !== null)
      return { output: null, code: null, message: null, pending: dispatched.pending }
    if (dispatched.refusal !== null) {
      return {
        output: null,
        code: dispatched.refusal['code'] as string,
        message: dispatched.refusal['message'] as string,
        pending: null,
      }
    }
  }
  const output = iter.outputs.get(sink) ?? null
  if (output === null) {
    const refused = trace.refusedAt
    if (refused !== null && typeof refused['code'] === 'string') {
      return {
        output: null,
        code: refused['code'] as string,
        message: 'subgraph refused',
        pending: null,
      }
    }
    return {
      output: null,
      code: 'input_insufficient',
      message: 'subgraph sink has no output',
      pending: null,
    }
  }
  return { output, code: null, message: null, pending: null }
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
  gas: GasState,
  depth: number,
  parentIndex: number | null,
): Promise<NodeRunResult> {
  const { model, env, trace, bag, pins } = input
  void view
  const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, index)
  const pre = evalPre(contractPre(contract), ctx)
  if (!pre.ok) {
    trace.refuse(
      index,
      rs.iter,
      pre.code ?? 'pre_unsat',
      attributionOf(model, pre.code ?? 'pre_unsat'),
      parentIndex,
    )
    return {
      refusal: refusalArtifact(model, pre.code ?? 'pre_unsat', pre.reason ?? 'pre_unsat'),
      pending: null,
    }
  }
  const chosen = selectInstance(model, contract, scopeCtx)
  if (chosen === null) {
    trace.refuse(
      index,
      rs.iter,
      'scope_mismatch',
      attributionOf(model, 'scope_mismatch'),
      parentIndex,
    )
    return {
      refusal: refusalArtifact(model, 'scope_mismatch', `no instance for ${ids[index]}`),
      pending: null,
    }
  }
  const step = trace.startStep(
    index,
    rs.iter,
    ids[index],
    chosen.chosen_instance,
    chosen.chosen_agent,
  )
  if (parentIndex !== null) step['parent_index'] = parentIndex
  // composite 实例（G2）：实现是「运行期递归展开 node.subgraph」，不走 capability 派发。
  if (nodeImpl(chosen.node) === 'composite') {
    return runCompositeNode(
      input,
      view,
      ids,
      edges,
      contracts,
      scopeCtx,
      rs,
      iter,
      index,
      contract,
      chosen,
      step,
      directives,
      providerOf,
      gas,
      depth,
      parentIndex,
    )
  }
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
    if (questionCall !== null)
      bag['cursor'] = graphCursor('question', index, rs, iter, questionCall, bag['input'], turnId)
  }

  // post 不过：可重试码（如模型偶发空产出）重跑本节点，达上限才收口为拒绝；其余立即拒绝。
  const postRetryMax = numericThreshold(model.thresholds, 'post_retry_max', 2)
  let output: Rec = {}
  let logSeq = rs.steps
  for (let attempt = 0; ; attempt++) {
    const effBefore = trace.effLog.length
    logSeq = nextStepSeq(rs)
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
        trace.refuse(index, rs.iter, 'owner_unavailable', 'owner', parentIndex)
        return {
          refusal: refusalArtifact(model, 'owner_unavailable', 'turn step append failed'),
          pending: null,
        }
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
      contextSources: input.contextSources ?? [],
      trace,
    })
    trace.attachEff(step, trace.effLog.slice(effBefore) as Rec[])

    // 取消检查点（派发后）：模型调用被 abort，或派发期间置了标志 ⇒ 不再处理产出、不短路成拒绝。
    if (isCancelled(asString(bag['turn_id']))) {
      step['verdict'] = 'cancelled'
      // 中止前已产出的推理 / 正文先落盘，避免刷新后丢失这次段产出。
      const partial = partialOf(result)
      if (partial !== null) await persistPartialStep(input, bag, rs, partial)
      return { refusal: null, pending: null, cancelled: true }
    }

    if (result.outcome === 'transport_failed') {
      step['verdict'] = 'fail'
      step['refusal'] = 'transport_failed'
      trace.refuse(
        index,
        rs.iter,
        'transport_failed',
        attributionOf(model, 'transport_failed'),
        parentIndex,
      )
      return {
        refusal: refusalArtifact(model, 'transport_failed', result.code ?? 'transport_failed'),
        pending: null,
      }
    }
    if (result.outcome === 'error') {
      const code = result.code ?? 'downstream_refusal'
      step['verdict'] = 'fail'
      step['refusal'] = code
      trace.refuse(index, rs.iter, code, attributionOf(model, code), parentIndex)
      return { refusal: refusalArtifact(model, code, `node ${ids[index]} failed`), pending: null }
    }

    output = isRecord(result.value) ? (result.value as Rec) : { value: result.value }
    applySideEffects(ids[index], output, rs, providerOf)
    // post 的输入面含本 Scope outputs：先落槽再求值，不过则短路（不产产物）。
    iter.outputs.set(index, output)
    const post = evalPost(
      contractPost(contract),
      ruleCtx(rs, model, bag, iter, trace.effLog, index),
    )
    if (post.ok) break
    const reason = post.reason ?? 'post_failed'
    const code = postRefusalCode(reason)
    if (retriableOf(model, code) && attempt < postRetryMax) continue
    step['verdict'] = 'fail'
    step['post_failed'] = reason
    trace.refuse(index, rs.iter, code, attributionOf(model, code))
    return { refusal: refusalArtifact(model, code, reason), pending: null }
  }
  // G5：同一输出端口至多一条触发分支；>1 触发即「互斥分支同走」的编排错误，拒绝并短路。
  const over = overTriggeredBranch(index, edges, ruleCtx(rs, model, bag, iter, trace.effLog, index))
  if (over !== null) {
    step['verdict'] = 'fail'
    step['refusal'] = 'redundant'
    trace.refuse(index, rs.iter, 'redundant', attributionOf(model, 'redundant'), parentIndex)
    return {
      refusal: refusalArtifact(
        model,
        'redundant',
        `output port ${over.port} took multiple branches`,
      ),
      pending: null,
    }
  }
  iter.executed.add(index)
  for (const directive of directivesOf(output)) directives.push(directive)
  // 工具结果里的写计划冒泡（question / todo 等）：#27 只回 results，由 #33 收集。
  for (const directive of nestedDirectivesOf(output)) directives.push(directive)

  if (preContractId === 'approval.wait') {
    const extern = externPayload(output)
    if (extern !== null && extern['ok'] === true) {
      // approval.pending 事件只由 #32 approval.enqueue 发（规范载荷），本插件不重复发。
      const cursor =
        pendingCursor ?? graphCursor('approval', index, rs, iter, null, bag['input'], turnId)
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
      const record: Rec = {
        type: 'step.result',
        turn_id: turnId,
        seq: logSeq,
        assistant: accumulatedAssistant(rs, toolsList),
        tool_results: Array.isArray(output['results']) ? (output['results'] as Json[]) : [],
      }
      const reasoning = lastReasoningOf(rs)
      if (reasoning !== undefined) record['reasoning'] = reasoning
      await appendStep(input.port, record)
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
    const calls =
      message !== null && Array.isArray(message['tool_calls'])
        ? (message['tool_calls'] as Json[])
        : []
    if (turnId !== null && message !== null && calls.length > 0) {
      // 中立推理块不落此中间承接帧：投影侧对该步走「普通 step.result」分支，会与 tool.dispatch 的
      // intent 结果分支重复投影同一份推理；推理持久化只落在 dispatch / deny / 收口步（消费端实际读取处）。
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
        const record: Rec = {
          type: 'step.result',
          turn_id: turnId,
          seq: logSeq,
          assistant: accumulatedAssistant(rs, toolsList),
          tool_results: results,
        }
        const reasoning = lastReasoningOf(rs)
        if (reasoning !== undefined) record['reasoning'] = reasoning
        await appendStep(input.port, record)
      }
    }
  }
  if (preContractId === 'verify') {
    const report = output['report']
    if (isRecord(report) && report['skipped'] !== true && report['passed'] === false)
      rs.verifyFailed = true
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
    return typeof old === 'string' && old.length > 0
      ? { op: 'replace', write: true }
      : { op: 'write', write: true }
  }
  const explicit = args['op']
  if (typeof explicit === 'string' && explicit.length > 0) {
    return { op: explicit, write: explicit === 'write' || explicit === 'replace' }
  }
  return null
}

/**
 * 游标里全部升级裁决（决策序 = 调用序），逐项按 `index` 绑定回 `last_calls` 的 call。
 * 决策序按 outputs 键（节点下标）数值升序 + 数组声明序，确定性。
 */
function escalatedDecisions(cursor: Rec, rs: RunState): { call: Rec; decision: Rec }[] {
  const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
  const outputs = isRecord(cursor['outputs']) ? (cursor['outputs'] as Rec) : {}
  const entries = Object.entries(outputs).sort((a, b) => Number(a[0]) - Number(b[0]))
  const out: { call: Rec; decision: Rec }[] = []
  for (const [, value] of entries) {
    if (!isRecord(value) || !Array.isArray(value['decisions'])) continue
    for (const decision of value['decisions'] as Json[]) {
      if (!isRecord(decision) || decision['verdict'] !== 'escalate') continue
      const index = numberField(decision['index'])
      const call = index !== null ? calls[index] : undefined
      if (isRecord(call)) out.push({ call, decision })
    }
  }
  return out
}

/** net 范围宽窄序：none < limited < all。 */
function netRank(scope: string): number {
  return scope === 'all' ? 2 : scope === 'limited' ? 1 : 0
}

/**
 * 裁决批准后构造一次性 `caps.grant`（形状与 #25 `sandbox` 消费口径一致：`call_id` / `op` / `paths` /
 * `fs` / `net` / `tier` / `expires`）。`paths` 为空 = 不适用；`fs` / `net` 只声明本次所需维度（未声明不放宽）。
 *
 * 绑定与合并口径（G8，确定性）：grant 绑定**决策序首个可解析的升级 call**（无升级项时回落批内首个 call），
 * 但把**整批所有升级裁决**的维度并集并入这一份 grant——fs op / paths（声明序去重）+ fs 读写维度 + net
 * （取最宽范围）。这样「首个升级项不是 net」也不会丢 net 放宽。net 越档且无 fs op 映射时补 `op:"exec"`。
 */
function approvalGrant(bag: Rec, env: CallEnv, rs: RunState, cursor: Rec): Rec | null {
  const escalations = escalatedDecisions(cursor, rs)
  const calls = Array.isArray(rs.lastCalls) ? (rs.lastCalls.filter(isRecord) as Rec[]) : []
  const bound = escalations.length > 0 ? escalations[0].call : calls.length > 0 ? calls[0] : null
  if (bound === null) return null
  const callId = asString(bound['call_id'])
  if (callId === null) return null
  const now = numberField(env.now) ?? numberField(bag['now']) ?? 0
  const grant: Rec = {
    call_id: callId,
    tier: bag['tier'] ?? null,
    expires: now + GRANT_TTL_MS,
  }
  const paths = new Set<string>()
  let fsRead = false
  let fsWrite = false
  let op: string | null = null
  const candidates = escalations.length > 0 ? escalations.map((item) => item.call) : [bound]
  for (const call of candidates) {
    const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
    const tool = asString(call['tool']) ?? ''
    const mapped = fsopOpOf(tool, args)
    if (mapped !== null) {
      if (op === null) op = mapped.op
      if (mapped.write) fsWrite = true
      else fsRead = true
    }
    const path = asString(args['path'])
    if (path !== null) paths.add(path)
  }
  let net: string | null = null
  for (const { decision } of escalations) {
    if (decision['reason'] !== 'net_outside_tier') continue
    const scope = netScopeOf(decision['rule'])
    if (net === null || netRank(scope) > netRank(net)) net = scope
  }
  if (op !== null) grant['op'] = op
  if (paths.size > 0) grant['paths'] = [...paths]
  const fs: Rec = {}
  if (fsRead) fs['read'] = 'full'
  if (fsWrite) fs['write'] = 'full'
  if (Object.keys(fs).length > 0) grant['fs'] = fs
  if (net !== null) {
    grant['net'] = net
    // sandbox 只认绑定 `exec` 的 grant；fs 未映射（纯 net 越档）时补上。
    if (grant['op'] === undefined) grant['op'] = 'exec'
  }
  return grant
}

function firstQuestionCall(calls: Rec[]): string | null {
  for (const call of calls) {
    if (call['tool'] === 'question' && typeof call['call_id'] === 'string')
      return call['call_id'] as string
  }
  return null
}

/** 厂商中立推理块：优先模型产出里的 `reasoning_blocks[0]`，否则把推理文本编成文本块（缺失 undefined）。 */
function neutralReasoningOf(value: Json): Json | undefined {
  const raw = isRecord(value) ? value : {}
  const blocks = Array.isArray(raw['reasoning_blocks']) ? raw['reasoning_blocks'] : []
  for (const block of blocks) {
    if (isRecord(block) && typeof block['payload'] === 'string') return block
  }
  const text = raw['reasoning']
  if (typeof text === 'string' && text.length > 0) {
    return { provider: '', model: '', form: 'text', payload: text }
  }
  return undefined
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
    // 厂商中立推理块暂存：随 step.result 持久化，供 context-window 跨段按 `step.result.reasoning` 回灌。
    const neutral = neutralReasoningOf(output)
    if (neutral !== undefined) rs.shared['last_reasoning'] = neutral
    else delete rs.shared['last_reasoning']
    return
  }
  // 上下文组装算出的模型参数（含预算用的 `max_output`）暂存本段状态，供模型调用对齐真实输出上限；
  // 缓存提示原样留给模型调用。
  if (contractIdValue === 'context.assemble') {
    const params = isRecord(output['params']) ? (output['params'] as Rec) : null
    if (params !== null) rs.shared['model_params'] = params
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
    const fromResult =
      rec !== null && typeof rec['call_id'] === 'string' ? (rec['call_id'] as string) : null
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

/** 累积展示记录：正文取最后一条助手消息，parts 由已回灌时间线（含工具结果）折叠成本步增量。 */
function accumulatedAssistant(rs: RunState, tools: Json[]): Rec {
  const partial = rs.messages.length > 0 && isRecord(rs.messages[0]) ? (rs.messages[0] as Rec) : {}
  const assistant: Rec = {
    content: typeof partial['content'] === 'string' ? (partial['content'] as string) : '',
  }
  const full = displayParts(rs.extraMessages, null, tools)
  const parts = incrementalParts(committedPartsOf(rs), full)
  commitParts(rs, full)
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
    rs.extraMessages.push({
      role: 'tool',
      tool_call_id: result.call_id,
      content: JSON.stringify(result),
    })
  }
  return results
}
