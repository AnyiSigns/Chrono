// 每线程视图 fold（纯函数）+ React-free store：快照 + 有序增量 + 定稿替换。
//
// 客户端真源：一个线程一份 view，渲染器只读 view，不各自持状态。
// store 只提供 getSnapshot / subscribe / commit，不 import 任何框架，壳侧可用 uSES 直接绑定。
//
// 事件语义（客户端 fold 内强制，共 9 条）：
// 1. 单连接有序：同一 SSE 连接内事件按到达顺序 fold，不重排。
// 2. run 生命周期单调：`run.started` / `chat.turn.started` 建立 / 替换在途回合；`model.delta` / `tool.*`
//    只作用于 run id 匹配的在途回合；`run.finished` 终结该 run。
// 2b. 回合挂起（`chat.turn.pending`，等审批 / 等作答）：回合未终结而宿主 run 结束 → 标记 `suspended`，
//     不收口；同一 `turn_id` 的续跑 `chat.turn.started` 复用原在途块（只换代 run id），不新开、不重放。
// 3. 迟到帧丢弃：已定稿 run 的后续 delta / tool 帧一律丢弃，防止定稿后冒出幽灵回合。
// 4. 缺 started 自愈：首个 delta / tool.start 到达即建在途回合，started 丢失不丢流。
// 5. 无关终局忽略：`run.finished` 无匹配在途回合即判定为无关 run（写 run / 周期 run /
//    已收束 run），忽略而不重拉——「事件到达即全量重拉」正是要消除的。真正的增量全丢
//    场景（断线）由规则 8 的重连快照兜底。
// 6. reset 语义：`model.delta.reset === true` 清空在途回合已累积正文与推理段再追加本帧
//    （流重试重放；修掉旧实现重复追加的缺陷）。
// 7. 快照权威：快照替换权威消息段（messages / conversation / refs / kind）；
//    在途回合只由生命周期事件（定稿 / 取消 / 线程切换 / 重连）清除。
// 8. 重连：连接 false→true 时由调用方清在途回合并强制快照重同步（断线期间增量不可信）。
// 9. 结局收束（全函数）：业务结局以 `chat.turn.settled` 为准，`run.finished` 只作机械信号；
//    `status=done` 且无业务结局是契约违例，显式标记而非静默当成功。

import {
  conversationList,
  conversationTurns,
  hasPendingUserMessage,
  loadConversation,
  threadKind,
} from './history-model.ts'

/** 已定稿 run 的记忆长度（丢弃迟到帧用；有界，防无界增长）。 */
export const FINISHED_MEMORY = 32

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runId(payload: any): string | null {
  return isRec(payload) && typeof payload.run === 'string' && payload.run.length > 0 ? payload.run : null
}

function threadOf(payload: any): string | null {
  return isRec(payload) && typeof payload.thread === 'string' && payload.thread.length > 0
    ? payload.thread
    : null
}

/** 回合身份 `turn_id`：同一用户回合跨 `send` + N 次 `resume` 恒定，用于跨 run 复用同一在途块。 */
function turnIdOf(payload: any): string | null {
  return isRec(payload) && typeof payload.turn_id === 'string' && payload.turn_id.length > 0
    ? payload.turn_id
    : null
}

function callIdOf(payload: any): string {
  return isRec(payload) && typeof payload.call_id === 'string' ? payload.call_id : ''
}

/** 回合事件携带的图内进度 `{iter, node_index, contract_id}`；缺失 / 形态非法回 null。 */
function progressOf(payload: any): any | null {
  return isRec(payload) && isRec(payload.progress) ? payload.progress : null
}

/** 事件里可选的非空字符串字段（缺失 / 空串回 null）。 */
function stringFieldOf(payload: any, key: string): string | null {
  return isRec(payload) && typeof payload[key] === 'string' && payload[key].length > 0 ? payload[key] : null
}

function deltaText(payload: any): string {
  if (!isRec(payload)) return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.delta === 'string') return payload.delta
  if (typeof payload.chunk === 'string') return payload.chunk
  return ''
}

function deltaReasoning(payload: any): string {
  return isRec(payload) && typeof payload.reasoning === 'string' ? payload.reasoning : ''
}

// ---- 结局收束（纯函数） ----

/** 回合终态种类（契约封闭集）。 */
export type OutcomeKind = 'committed' | 'refused' | 'cancelled' | 'interrupted'

/** 归一后的结局：展示只需 kind / 码 / 归因 / 可重试 / 下游 cause 码 / 消息。 */
export interface BusinessOutcome {
  kind: OutcomeKind
  code: string | null
  attributableTo: string | null
  retryable: boolean
  causeCode: string | null
  message: string | null
}

const OUTCOME_KINDS: readonly OutcomeKind[] = ['committed', 'refused', 'cancelled', 'interrupted']

/** 归一一条结局；形态非法回 null。 */
export function normalizeOutcome(value: any): BusinessOutcome | null {
  if (!isRec(value)) return null
  const kind = value.kind
  if (typeof kind !== 'string' || !OUTCOME_KINDS.includes(kind as OutcomeKind)) return null
  const cause = isRec(value.cause) ? value.cause : null
  return {
    kind: kind as OutcomeKind,
    code: typeof value.code === 'string' && value.code.length > 0 ? value.code : null,
    attributableTo:
      typeof value.attributableTo === 'string' && value.attributableTo.length > 0 ? value.attributableTo : null,
    retryable: value.retryable === true,
    causeCode: cause !== null && typeof cause.code === 'string' && cause.code.length > 0 ? cause.code : null,
    message: typeof value.message === 'string' && value.message.length > 0 ? value.message : null,
  }
}

/** 展示码：结局层码优先，其次下游 cause 码，最后 `unknown`。
 *  结局层通用包装 `downstream_refusal` 不吞掉下游具体码——有 `cause` 就展示 `cause`。 */
export function outcomeDisplayCode(outcome: BusinessOutcome | null): string {
  if (outcome === null) return 'unknown'
  if (outcome.code === 'downstream_refusal' && outcome.causeCode !== null) return outcome.causeCode
  return outcome.code ?? outcome.causeCode ?? 'unknown'
}

/** 显示结局：`kind` 增补 `violation`（契约违例），其余与业务结局同形。 */
export interface DisplayOutcome extends Omit<BusinessOutcome, 'kind'> {
  kind: OutcomeKind | 'violation'
}

function violationOutcome(): DisplayOutcome {
  return {
    kind: 'violation',
    code: 'contract_violation',
    attributableTo: 'owner',
    retryable: true,
    causeCode: null,
    message: null,
  }
}

/**
 * 三通道收束规则（全函数）：`run.finished` 是机械信号，业务结局是权威。
 * - 有业务结局：一律用业务结局（含 cancelled / interrupted，保证按结局分支渲染）；
 * - 无业务结局且 `status=done`：契约违例（I3），不得静默当成功；
 * - 无业务结局且 `status=refused / cancelled`：合成 `refused{attributableTo:'transport', code:reasons[0]}`；
 * - 其余状态（含 `idle`）：同样按契约违例 fail-closed。
 */
export function resolveDisplayOutcome(payload: any, businessOutcome: BusinessOutcome | null): DisplayOutcome {
  if (businessOutcome !== null) return businessOutcome
  const status = isRec(payload) && typeof payload.status === 'string' ? payload.status : ''
  if (status === 'done') return violationOutcome()
  if (status === 'refused' || status === 'cancelled') {
    const reasons = isRec(payload) && Array.isArray(payload.reasons) ? payload.reasons : []
    const code = reasons.find((item: unknown) => typeof item === 'string' && item.length > 0) ?? 'transport_refused'
    return {
      kind: 'refused',
      code,
      attributableTo: 'transport',
      retryable: true,
      causeCode: null,
      message: null,
    }
  }
  return violationOutcome()
}

/** 空视图：线程切换 / 首屏前的占位。 */
export function emptyView(thread: string | null = null): any {
  return {
    thread,
    conversation: null,
    conversations: [],
    refs: {},
    kind: 'main',
    messages: [],
    turns: [],
    inFlight: null,
    pendingUser: null,
    finishedRuns: [],
    revision: 0,
  }
}

function newInFlight(run: string | null, thread: string | null, turnId: string | null): any {
  // segments：到达序渲染段（reasoning / text / tool 段），渲染器按序交错展示；
  // text / reasoning / tools 仍冗余保留（供慢流判定与 contentKey），从 segments 同步得出。
  // turnId / suspended：跨 run（审批 / 提问续跑、段续跑）复用同一在途块；挂起时暂停流式观感。
  return {
    run,
    turnId,
    thread,
    text: '',
    reasoning: '',
    tools: [],
    segments: [],
    finalizing: false,
    cancelled: false,
    suspended: false,
    /** 图内进度（`chat.turn.pending` / `chat.turn.settled` 携带）；null = 尚无。 */
    progress: null,
    /** 预算收口原因（`chat.turn.settled.stop_reason`）；null = 无。 */
    stopReason: null,
    /** 解释器生命周期（`chat.turn.settled.lifecycle`）；null = 无。 */
    lifecycle: null,
    /** 业务结局（`chat.turn.settled` 记录）；机械信号收束时据此分支，不掩盖失败。 */
    outcome: null,
  }
}

/** 追加同类文本段：末段同类则合并，否则新开一段（保持到达序）。 */
function appendSegment(segments: any[], kind: string, text: string): any[] {
  if (text.length === 0) return segments
  const last = segments[segments.length - 1]
  if (last !== undefined && last.kind === kind) {
    return [...segments.slice(0, -1), { kind, text: last.text + text }]
  }
  return [...segments, { kind, text }]
}

function rememberFinished(view: any, run: string | null): any {
  if (run === null) return view
  const finishedRuns = [run, ...view.finishedRuns.filter((item: string) => item !== run)].slice(
    0,
    FINISHED_MEMORY,
  )
  return { ...view, finishedRuns }
}

function isFinished(view: any, run: string | null): boolean {
  return run !== null && view.finishedRuns.includes(run)
}

/** 取（必要时新建）在途回合：run 不匹配时以新 run 替换；自愈回合（run 缺失）被后续 run id 认领而非替换。 */
function ensureInFlight(view: any, run: string | null, payload: any): any {
  if (view.inFlight !== null) {
    if (run === null || view.inFlight.run === run) return view
    if (view.inFlight.run === null) {
      return { ...view, inFlight: { ...view.inFlight, run, turnId: view.inFlight.turnId ?? turnIdOf(payload) } }
    }
  }
  return { ...view, inFlight: newInFlight(run, threadOf(payload), turnIdOf(payload)) }
}

/**
 * 在途回合的运行中插入用户消息（`step.user`）：id 形状 `msg-<conv>-<turnId>-user-<insert_id>`，
 * 区别于回合开头那条 `msg-<conv>-<turnId>-user`。按追加序取，供在途流按同序并入渲染。
 */
export function insertedUserEntries(messages: any[], turnId: string | null): any[] {
  if (turnId === null || !Array.isArray(messages)) return []
  const suffix = `-${turnId}-user-`
  return messages.filter(
    (entry: any) =>
      isRec(entry) &&
      isRec(entry.def) &&
      entry.def.role === 'user' &&
      typeof entry.def.id === 'string' &&
      entry.def.id.includes(suffix),
  )
}

/**
 * 快照：替换权威消息段。在途回合处理：
 * - 流式中（未定稿）→ 保留（增量仍在途），并把新到的事件流用户插入段按追加序并入在途段——
 *   使插入气泡与其前后的助手 / 工具段同序渲染（落在「被追加时」的位置，而不是消息流顶部）；
 * - 定稿中（finalizing，run 已终局等权威消息）或已取消（cancelled）→ 原地替换为 null（快照即权威）。
 * 定稿替换因此不依赖任何外挂参数：定稿失败后下一次成功快照也会收口。
 */
export function applySnapshot(view: any, history: any, conversationId: unknown): any {
  const loaded = loadConversation(history, conversationId)
  const dropped =
    view.inFlight !== null && (view.inFlight.finalizing === true || view.inFlight.cancelled === true)
  let inFlight = dropped ? null : view.inFlight
  if (inFlight !== null) {
    const present = new Set(
      (inFlight.segments ?? [])
        .filter((segment: any) => segment.kind === 'user')
        .map((segment: any) => segment.id),
    )
    const additions = insertedUserEntries(loaded.messages, inFlight.turnId).filter(
      (entry: any) => !present.has(entry.def.id),
    )
    if (additions.length > 0) {
      inFlight = {
        ...inFlight,
        segments: [
          ...(inFlight.segments ?? []),
          ...additions.map((entry: any) => ({ kind: 'user', id: entry.def.id, def: entry.def })),
        ],
      }
    }
  }
  return {
    ...view,
    conversation: loaded.conversation,
    conversations: conversationList(history),
    refs: isRec(history) && isRec(history.refs) ? history.refs : {},
    kind: threadKind(loaded.conversation),
    messages: loaded.messages,
    turns: conversationTurns(history),
    inFlight,
    revision: view.revision + 1,
  }
}

/**
 * `chat.turn.started` / `run.started`：建立 / 替换在途回合；已定稿 run 忽略；自愈时缺 run id 则认领不替换。
 * **同一 `turn_id` 的续跑复用原在途块**并认领新 run（不新开）：否则挂起前已展示的内容与工具卡
 * 会在恢复时重新出现，观感像同一批工具被再次调用。
 */
export function applyRunStarted(view: any, payload: any): any {
  const run = runId(payload)
  const turnId = turnIdOf(payload)
  if (isFinished(view, run)) return view
  const progress = progressOf(payload)
  const withProgress = (next: any): any =>
    progress === null ? next : { ...next, inFlight: { ...next.inFlight, progress } }
  if (view.inFlight !== null && turnId !== null && view.inFlight.turnId === turnId) {
    return withProgress({ ...view, inFlight: { ...view.inFlight, run, suspended: false } })
  }
  if (view.inFlight !== null && view.inFlight.run === null) {
    return withProgress({ ...view, inFlight: { ...view.inFlight, run, turnId: view.inFlight.turnId ?? turnId, suspended: false } })
  }
  return withProgress(ensureInFlight(view, run, payload))
}

/**
 * `chat.turn.pending`：回合挂起（等审批 / 等作答）——回合未终结但宿主 run 会结束。
 * 标记在途块挂起，使其不被 `run.finished` 当作定稿收口，并让渲染器显示等待态。
 * 事件若带图内进度则一并记下，供状态行展示。
 */
export function applyTurnPending(view: any, payload: any): any {
  const inFlight = view.inFlight
  if (inFlight === null) return view
  const turnId = turnIdOf(payload)
  const run = runId(payload)
  const matched =
    turnId !== null ? inFlight.turnId === turnId : inFlight.run === null || run === null || inFlight.run === run
  if (!matched) return view
  const progress = progressOf(payload)
  return {
    ...view,
    inFlight: { ...inFlight, suspended: true, ...(progress !== null ? { progress } : {}) },
  }
}

/**
 * `chat.turn.settled`：回合终态（成功 / 拒绝 / 取消 / 中断）。记录业务结局并据其分支：
 * `cancelled` 标取消；`committed` / `refused` / `interrupted` 进入定稿（快照落地后由持久回合结局呈现）。
 * 事件里确实存在的图内进度 / 生命周期 / 预算收口原因一并记下（只记存在的键）。
 */
export function applyTurnSettled(view: any, payload: any): any {
  const inFlight = view.inFlight
  if (inFlight === null) return view
  const turnId = turnIdOf(payload)
  if (turnId !== null && inFlight.turnId !== null && inFlight.turnId !== turnId) return view
  const outcome = normalizeOutcome(isRec(payload) ? payload.outcome : null)
  const cancelled = outcome !== null && outcome.kind === 'cancelled'
  const progress = progressOf(payload)
  const stopReason = stringFieldOf(payload, 'stop_reason')
  const lifecycle = stringFieldOf(payload, 'lifecycle')
  return {
    ...view,
    inFlight: {
      ...inFlight,
      suspended: false,
      outcome: outcome ?? inFlight.outcome,
      cancelled: cancelled || inFlight.cancelled === true,
      finalizing: cancelled ? false : true,
      ...(progress !== null ? { progress } : {}),
      ...(stopReason !== null ? { stopReason } : {}),
      ...(lifecycle !== null ? { lifecycle } : {}),
    },
  }
}

/**
 * `model.delta`：追加正文与推理分片；缺 started 自愈；已定稿 run 丢弃；
 * reset 清空正文 / 推理段重放（工具段保留）。推理分片先于同帧正文段落位（语义上推理在前）。
 */
export function applyDelta(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  const based = ensureInFlight(view, run, payload)
  const text = deltaText(payload)
  const reasoning = deltaReasoning(payload)
  if (payload.reset === true) {
    const kept = based.inFlight.segments.filter(
      (segment: any) => segment.kind !== 'text' && segment.kind !== 'reasoning',
    )
    const replayed = appendSegment(appendSegment(kept, 'reasoning', reasoning), 'text', text)
    return {
      ...based,
      inFlight: { ...based.inFlight, text, reasoning, segments: replayed },
    }
  }
  const segments = appendSegment(
    appendSegment(based.inFlight.segments, 'reasoning', reasoning),
    'text',
    text,
  )
  return {
    ...based,
    inFlight: {
      ...based.inFlight,
      text: based.inFlight.text + text,
      reasoning: based.inFlight.reasoning + reasoning,
      segments,
    },
  }
}

/** `tool.start`：在途回合的工具卡（有序，按 call_id 去重后置末；segments 同步去重置末）。 */
export function applyToolStart(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  const based = ensureInFlight(view, run, payload)
  const callId = callIdOf(payload)
  if (callId.length === 0) return based
  const tools = based.inFlight.tools.filter((item: any) => item.callId !== callId)
  tools.push({
    callId,
    tool: typeof payload.tool === 'string' ? payload.tool : '',
    render: isRec(payload.render) ? payload.render : null,
    args: payload.args ?? null,
    chunks: '',
    done: false,
    ok: null,
    result: null,
    error: null,
  })
  const segments = based.inFlight.segments.filter(
    (segment: any) => !(segment.kind === 'tool' && segment.callId === callId),
  )
  segments.push({ kind: 'tool', callId })
  return { ...based, inFlight: { ...based.inFlight, tools, segments } }
}

/** `tool.delta`：追加工具输出块（缺 started 自愈，与 `tool.start` 同口径）。 */
export function applyToolDelta(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  const based = ensureInFlight(view, run, payload)
  const callId = callIdOf(payload)
  const chunk = deltaText(payload)
  if (callId.length === 0 || chunk.length === 0) return based
  const tools = based.inFlight.tools.map((item: any) =>
    item.callId === callId ? { ...item, chunks: item.chunks + chunk } : item,
  )
  return { ...based, inFlight: { ...based.inFlight, tools } }
}

/**
 * `tool.end`：标记工具卡终态（ok 供状态图标；结果本体随事件下发，在途卡即时渲染输出）。
 * 结果可自带动态 render 描述符（如 question 的题干 / 选项 / 答案快照），比目录里的静态 render 具体，
 * 就地覆盖在途卡 render——与定稿落盘口径一致（见 loop-policy `commit-parts.ts`），否则在途卡按静态
 * 壳渲染（question 空卡）、刷新读已落盘 part 才有内容。
 */
export function applyToolEnd(view: any, payload: any): any {
  const run = runId(payload)
  if (isFinished(view, run)) return view
  if (view.inFlight === null) return view
  const callId = callIdOf(payload)
  if (callId.length === 0) return view
  const ok = typeof payload.ok === 'boolean' ? payload.ok : null
  const result = isRec(payload) ? (payload.result ?? null) : null
  const error = isRec(payload) ? (payload.error ?? null) : null
  const dynamicRender = isRec(result) && isRec(result.render) ? result.render : null
  const tools = view.inFlight.tools.map((item: any) =>
    item.callId === callId
      ? { ...item, done: true, ok, result, error, ...(dynamicRender !== null ? { render: dynamicRender } : {}) }
      : item,
  )
  return { ...view, inFlight: { ...view.inFlight, tools } }
}

/**
 * `run.finished` 处置（机械信号 + 业务结局收束）：返回 `{view, action}`。
 * action ∈ 'finalize'（committed，等快照原地替换）| 'refused' / 'interrupt'（失败结局）
 *        | 'violation'（status=done 但无业务结局：契约违例，显式标记）| 'cancel'（取消）
 *        | 'suspend'（挂起段 run 结束但回合未完）| 'ignore'（迟到 / 重复 / 无匹配在途回合）。
 * 匹配放宽：任一侧 run id 缺失时视为匹配（自愈回合可能没认领到 run id）。
 */
export function foldRunFinished(view: any, payload: any): { view: any; action: string } {
  const run = runId(payload)
  if (isFinished(view, run)) return { view, action: 'ignore' }
  const inFlight = view.inFlight
  const matched =
    inFlight !== null && (inFlight.run === null || run === null || inFlight.run === run)
  const marked = rememberFinished(view, run)
  if (!matched) return { view: marked, action: 'ignore' }
  const business = inFlight.outcome !== null && inFlight.outcome !== undefined ? inFlight.outcome : null
  // 挂起段（等审批 / 等作答）的宿主 run 结束不代表回合定稿：无业务结局时保留在途块（记入 finishedRuns 丢弃迟到帧），
  // 由续跑 `chat.turn.started` 复用、终局 `chat.turn.settled` 收口。action='suspend' 供调用方提交视图但不重拉。
  if (marked.inFlight.suspended === true && business === null) return { view: marked, action: 'suspend' }
  const display = resolveDisplayOutcome(payload, business)
  if (display.kind === 'committed') {
    return {
      view: { ...marked, inFlight: { ...marked.inFlight, suspended: false, finalizing: true } },
      action: 'finalize',
    }
  }
  if (display.kind === 'cancelled') {
    return {
      view: { ...marked, inFlight: { ...marked.inFlight, suspended: false, cancelled: true, finalizing: false } },
      action: 'cancel',
    }
  }
  if (display.kind === 'refused' || display.kind === 'interrupted') {
    // 失败结局：在途块记下结局并转定稿；快照落地后由持久回合结局块呈现（不落回成功、不静默消失）。
    return {
      view: { ...marked, inFlight: { ...marked.inFlight, suspended: false, finalizing: true, outcome: display } },
      action: display.kind === 'interrupted' ? 'interrupt' : 'refused',
    }
  }
  // 契约违例（status=done 且无业务结局）：无持久回合作依据，保留在途块显式标记，不静默当成功。
  return {
    view: { ...marked, inFlight: { ...marked.inFlight, suspended: false, violation: true, outcome: display } },
    action: 'violation',
  }
}

/**
 * 持久回合结局块：会话记录里已收口且需显式呈现的回合，供渲染失败 / 中断。
 * `committed` 无块；`cancelled` 是用户主动停止，静默（不按错误展示）。
 * 当前在途回合（同 `turn_id`）跳过，避免与在途块重复呈现。
 */
export function outcomeBlocks(view: any): Array<{ turnId: string | null; outcome: BusinessOutcome }> {
  const turns = Array.isArray(view.turns) ? view.turns : []
  const blocks: Array<{ turnId: string | null; outcome: BusinessOutcome }> = []
  for (const turn of turns) {
    if (!isRec(turn) || turn.state !== 'settled') continue
    const outcome = normalizeOutcome(turn.outcome)
    if (outcome === null || outcome.kind === 'committed' || outcome.kind === 'cancelled') continue
    if (
      view.inFlight !== null &&
      view.inFlight.turnId !== null &&
      view.inFlight.turnId === turn.turn_id
    ) {
      continue
    }
    blocks.push({ turnId: typeof turn.turn_id === 'string' ? turn.turn_id : null, outcome })
  }
  return blocks
}

/** 丢弃在途回合：快照已含定稿消息（传 run）或线程切换 / 重连（不传 run）。 */
export function dropInFlight(view: any, run: string | null = null): any {
  if (view.inFlight === null) return view
  if (run !== null && view.inFlight.run !== run) return view
  return { ...view, inFlight: null }
}

/**
 * 是否正在流式（在途、未取消、未挂起、尚无结局）。挂起（等审批 / 等作答）不算流式；
 * 已记下业务结局（含契约违例）即终态，不再转计时与文本光标——失败 / 取消不得继续伪装在跑。
 */
export function isStreaming(view: any): boolean {
  const inFlight = view.inFlight
  if (inFlight === null || inFlight.cancelled === true || inFlight.suspended === true) return false
  return inFlight.outcome === null || inFlight.outcome === undefined
}

/**
 * 设置乐观用户消息（回合内展示的用户气泡）。
 * 住 store 而非组件：组件卸载 / 重挂后同一 store 复用，气泡不随组件销毁。
 */
export function setPendingUser(view: any, def: any): any {
  return { ...view, pendingUser: def }
}

/** 清除乐观用户消息（幂等：已空时原引用返回，避免无谓通知）。 */
export function clearPendingUser(view: any): any {
  if (view.pendingUser === null) return view
  return { ...view, pendingUser: null }
}

/**
 * 快照落地后收口乐观用户消息：权威历史已含同文用户消息时清除，避免与历史重复。
 * 线程切换 / 取消 / 重连由调用方显式清除；重挂触发的快照重拉不得误清仍在途的气泡。
 */
export function reconcilePendingUser(view: any): any {
  if (view.pendingUser === null) return view
  return hasPendingUserMessage(view.messages, view.pendingUser) ? clearPendingUser(view) : view
}

/** React-free store：getSnapshot / subscribe / commit（commit 带 meta 供渲染器选增量路径）。 */
export function createThreadStore(initial: any = emptyView()): {
  getSnapshot(): any
  subscribe(listener: (snapshot: any, meta?: any) => void): () => void
  commit(next: any, meta?: any): void
} {
  let view = initial
  const listeners = new Set<(snapshot: any, meta?: any) => void>()
  return {
    getSnapshot() {
      return view
    },
    subscribe(listener: (snapshot: any, meta?: any) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    commit(next: any, meta: any = {}) {
      if (next === view) return
      view = next
      for (const listener of [...listeners]) listener(view, meta)
    },
  }
}
