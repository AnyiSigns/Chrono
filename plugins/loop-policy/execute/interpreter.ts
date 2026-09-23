// 服务自驱图解释器：顺序推进（读图数据 → 选实例 → pre → port.call 派发 → post → when 定下一 Scope → sink 收口）。
// 推式条件边 + 拒绝短路到 sink + 回合重入（Graph.loop）+ MAX_STEPS/gas 自限 + 审批/提问跨 run 续跑。
// 游标是服务进程内状态（跨 run 续跑时序列化进队列项游标落世界）。

import { dispatchNode, toCalls } from './dispatch.ts'
import {
  contractId,
  contractIndex,
  contractPost,
  contractPre,
  graphEdges,
  graphLoop,
  graphNodes,
  graphSink,
  numericThreshold,
} from './model.ts'
import { buildView } from './gate.ts'
import { asString, directivesOf, isRecord, nestedDirectivesOf, numberField } from './plan.ts'
import { attributionOf } from './seed.ts'
import { evalPost, evalPre, evalWhen } from './rules.ts'
import { selectInstance } from './scope.ts'
import {
  configureProviders,
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
import { runSink, summaryOfRun } from './sink.ts'
import type { CallEnv, Json, Rec, RunState, ServiceEvent } from './types.ts'

interface IterResult {
  refused: Rec | null
  pending: Rec | null
}

interface NodeRunResult {
  refusal: Rec | null
  pending: Rec | null
}

/** 解释一次图执行（一个回合：可含多次 iter）。 */
export async function interpretGraph(input: InterpretInput): Promise<InterpretResult> {
  const { bag, env, model, trace } = input
  configureProviders(bag)
  const view = buildView(model)
  const ids = graphNodes(model.graph)
  const edges = graphEdges(model.graph)
  const sink = graphSink(model.graph)
  const contracts = contractIndex(model)
  const scopeCtx = { workspace_id: asString(bag['workspace_id']), session_id: asString(bag['session_id']) }
  const maxTurnIter = numericThreshold(model.thresholds, 'max_turn_iter', 6)
  const maxSteps = numericThreshold(model.thresholds, 'max_steps', 64)
  const directives: Json[] = []
  const events: ServiceEvent[] = []
  const pendingCursor = input.resume !== null && isRecord(input.resume['cursor']) ? (input.resume['cursor'] as Rec) : null

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
      patchQuestionAnswer(iter, nodeIndex, asString(pendingCursor['call_id']), resumePayload(input.resume), rs.lastCalls)
      // 答案回灌：dispatch 已发生 ⇒ 视作本 iter 派发过工具，并把答案追加为工具消息供重入的 assemble 看到。
      rs.dispatchedTools = true
      rs.extraMessages.push({ role: 'tool', content: JSON.stringify({ answers: resumePayload(input.resume)['answers'] ?? null }) })
    }
    rs.questionPending = false
  } else {
    rs = freshState()
    iter = { outputs: new Map(), inputs: new Map(), executed: new Set() }
  }

  for (;;) {
    const result = await runIter(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives)
    if (result.pending !== null) {
      return { directives, events, pending: result.pending, summary: summaryOfRun(rs, result.pending), state: rs, ended: 'pending' }
    }
    if (result.refused !== null) {
      await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, result.refused)
      return { directives, events, pending: null, summary: summaryOfRun(rs, null), state: rs, ended: 'refused' }
    }
    const loopCtx = ruleCtx(rs, model, bag, iter, trace.effLog, 0)
    const loopWhen = asString(graphLoop(model.graph)['when']) ?? ''
    // 无 loop.when ⇒ 不重入（缺省即单轮）；question_pending 优先 ⇒ 本 run 正常结束。
    const shouldLoop = !rs.questionPending && loopWhen.length > 0 && evalWhen(loopWhen, loopCtx, 0)
    if (!shouldLoop) {
      await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, null)
      return { directives, events, pending: null, summary: summaryOfRun(rs, null), state: rs, ended: trace.outcome === 'refused' ? 'refused' : 'done' }
    }
    if (rs.iter >= maxTurnIter || rs.steps >= maxSteps) {
      const reason = rs.iter >= maxTurnIter ? `max_turn_iter=${maxTurnIter}` : `max_steps=${maxSteps}`
      const refusal = refusalArtifact(model, 'budget', `${reason} reached while still dispatching`)
      trace.refuse(sink, rs.iter, 'budget', 'budget')
      await runSink(input, view, ids, edges, contracts, sink, scopeCtx, rs, iter, directives, refusal)
      return { directives, events, pending: null, summary: summaryOfRun(rs, null), state: rs, ended: 'refused' }
    }
    rs.iter += 1
    rs.dispatchedTools = false
    rs.questionPending = false
    rs.verifyFailed = false
    iter = { outputs: new Map(), inputs: new Map(), executed: new Set() }
  }
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
): Promise<IterResult> {
  const { model, trace, bag } = input
  for (let index = 0; index < ids.length; index++) {
    if (index === sink || iter.executed.has(index)) continue
    const contract = contracts.get(ids[index])
    if (contract === undefined) continue
    const ctx = ruleCtx(rs, model, bag, iter, trace.effLog, index)
    if (!isActivated(index, contract, edges, ctx)) continue
    iter.inputs.set(index, gatherInputs(index, edges, ctx))
    const dispatch = await runNode(input, view, ids, edges, contracts, scopeCtx, rs, iter, index, contract, directives)
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
  const effBefore = trace.effLog.length
  rs.steps += 1
  // 审批 / 提问需把跨 run 游标随队列项落世界：派发前把游标放进 bag（approval.enqueue / #48 question 读 args.cursor）。
  const preContractId = contractId(contract)
  let pendingCursor: Rec | null = null
  if (preContractId === 'approval.wait') {
    pendingCursor = graphCursor('approval', index, rs, iter, null, bag['input'])
    bag['cursor'] = pendingCursor
  }
  if (preContractId === 'tool.dispatch') {
    const questionCall = firstQuestionCall(Array.isArray(rs.lastCalls) ? rs.lastCalls : [])
    if (questionCall !== null) bag['cursor'] = graphCursor('question', index, rs, iter, questionCall, bag['input'])
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

  const output = isRecord(result.value) ? (result.value as Rec) : { value: result.value }
  applySideEffects(ids[index], output, rs)
  // post 的输入面含本 Scope outputs：先落槽再求值，不过则短路（不产产物）。
  iter.outputs.set(index, output)
  const post = evalPost(contractPost(contract), ruleCtx(rs, model, bag, iter, trace.effLog, index))
  if (!post.ok) {
    step['verdict'] = 'fail'
    step['post_failed'] = post.reason ?? 'post_failed'
    trace.refuse(index, rs.iter, 'capability_mismatch', attributionOf(model, 'capability_mismatch'))
    return { refusal: refusalArtifact(model, 'capability_mismatch', post.reason ?? 'post_failed'), pending: null }
  }
  iter.executed.add(index)
  for (const directive of directivesOf(output)) directives.push(directive)
  // 工具结果里的写计划冒泡（question / todo 等）：#27 只回 results，由 #33 收集。
  for (const directive of nestedDirectivesOf(output)) directives.push(directive)

  if (preContractId === 'approval.wait') {
    const extern = externPayload(output)
    if (extern !== null && extern['ok'] === true) {
      // approval.pending 事件只由 #32 approval.enqueue 发（规范载荷），本插件不重复发。
      const cursor = pendingCursor ?? graphCursor('approval', index, rs, iter, null, bag['input'])
      return { refusal: null, pending: { kind: 'approval', cursor } }
    }
  }
  if (preContractId === 'tool.dispatch') {
    // 一次性 grant 只服务于本次裁决放行：派发完成即从 bag 摘除，避免后续 iter 的未批准调用复用。
    if (bag['grant'] !== undefined) delete bag['grant']
    const calls = Array.isArray(rs.lastCalls) ? rs.lastCalls : []
    if (calls.length > 0) rs.dispatchedTools = true
    const questionCall = firstQuestionCall(calls)
    if (questionCall !== null) {
      rs.questionPending = true
      // #48 队列项的 resume 游标取自派发前，同批其它工具真实结果尚不可见；
      // 在此用派发后结果重建游标并替换进 #48 的写计划，恢复时只替换 question 项。
      // 游标内该节点的产出须去掉嵌套续跑游标，否则「游标 → 产出 → 写计划 → 游标」成环。
      const safe = cursorSafeOutput(output)
      const original = iter.outputs.get(index)
      iter.outputs.set(index, safe)
      const enriched = graphCursor('question', index, rs, iter, questionCall, bag['input'])
      if (original !== undefined) iter.outputs.set(index, original)
      patchResumeCursor(output, enriched)
    }
    appendToolMessages(rs, output)
  }
  if (preContractId === 'verify') {
    const report = output['report']
    if (isRecord(report) && report['skipped'] !== true && report['passed'] === false) rs.verifyFailed = true
    appendVerifyMessage(rs, report)
  }
  return { refusal: null, pending: null }
}

/** 一次性 `caps.grant` 有效期（毫秒）；`expires` 用帧 `env.now` 判，不取系统时钟。 */
const GRANT_TTL_MS = 10 * 60 * 1000

/**
 * 工具调用 → `sandbox.fsop` op（与 #28 tool-fs 的映射契约对齐）：read→read / glob→list / grep→grep /
 * edit→replace（old 非空）/ write（old 空）。映射住 #33（grant 签发者），#28 只透传 grant 不解释。
 */
function fsopOpOf(tool: string, args: Rec): { op: string; write: boolean } | null {
  if (tool === 'read') return { op: 'read', write: false }
  if (tool === 'glob') return { op: 'list', write: false }
  if (tool === 'grep') return { op: 'grep', write: false }
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
 * `fs` / `tier` / `expires`）。`paths` 为空 = 不适用；`fs` 只声明本次 op 所需维度（未声明不放宽）。
 */
function approvalGrant(bag: Rec, env: CallEnv, rs: RunState, cursor: Rec): Rec | null {
  const call = escalatedCall(cursor, rs)
  if (call === null) return null
  const callId = asString(call['call_id'])
  if (callId === null) return null
  const args = isRecord(call['args']) ? (call['args'] as Rec) : {}
  const mapped = fsopOpOf(asString(call['tool']) ?? '', args)
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
  return grant
}

function firstQuestionCall(calls: Rec[]): string | null {
  for (const call of calls) {
    if (call['tool'] === 'question' && typeof call['call_id'] === 'string') return call['call_id'] as string
  }
  return null
}

/** 深拷贝派发产出并把嵌套续跑游标置空，供嵌入游标自身（断开「游标↔产出」环）。 */
function cursorSafeOutput(output: Rec): Rec {
  const clone = JSON.parse(JSON.stringify(output)) as Rec
  nullResumeCursors(clone)
  return clone
}

function nullResumeCursors(node: Json): void {
  if (Array.isArray(node)) {
    for (const child of node) nullResumeCursors(child)
    return
  }
  if (!isRecord(node)) return
  const resume = node['resume']
  if (isRecord(resume) && resume['command'] === 'chat.resume' && isRecord(resume['args'])) {
    resume['args']['cursor'] = null
    return
  }
  for (const child of Object.values(node)) nullResumeCursors(child)
}

/** 替换工具结果里 `resume.command==='chat.resume'` 的游标（#48 队列项的续跑游标）。 */
function patchResumeCursor(value: Json, cursor: Rec): void {
  if (!isRecord(value)) return
  const results = Array.isArray(value['results']) ? (value['results'] as Json[]) : []
  for (const item of results) {
    if (!isRecord(item)) continue
    const result = item['result']
    if (isRecord(result) && Array.isArray(result['$directives'])) {
      for (const directive of result['$directives'] as Json[]) patchResumeDirective(directive, cursor)
    }
  }
}

function patchResumeDirective(node: Json, cursor: Rec): void {
  if (Array.isArray(node)) {
    for (const child of node) patchResumeDirective(child, cursor)
    return
  }
  if (!isRecord(node)) return
  const resume = node['resume']
  if (isRecord(resume) && resume['command'] === 'chat.resume' && isRecord(resume['args'])) {
    // 游标自身含 outputs（引用本 output），替换后不得再递归进去（会成环）。
    ;(resume['args'] as Rec)['cursor'] = cursor
    return
  }
  for (const child of Object.values(node)) patchResumeDirective(child, cursor)
}

/** 从 step 输出提取 calls 与消息（供 gate / dispatch 与跨 iter 记忆）。 */
function applySideEffects(contractIdValue: string, output: Rec, rs: RunState): void {
  if (contractIdValue === 'agent.step' || contractIdValue === 'subagent') {
    rs.lastCalls = toCalls(output)
    const message = isRecord(output['message']) ? (output['message'] as Rec) : null
    rs.messages = message !== null ? [message] : []
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

function appendVerifyMessage(rs: RunState, report: Json | undefined): void {
  if (report === undefined) return
  rs.extraMessages.push({ role: 'tool', content: `verify: ${JSON.stringify(report)}` })
}
