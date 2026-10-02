// 能力类 `chat` 的方法表：send（回合启动）/ history（展示历史窗口）/ resume（跨 run 续跑）。
// 回合身份（`turn_id`）由 `send` 铸，经 bag → 解释器 → 步记录 → 收口 → 事件全程携带；续跑续同一回合。
// 本服务只负责 bag 装配、回合开启（`session.turn_open`）、结局提取与事件上报，以及 title 旁路段。
// 入口 term 只传投影切片；服务不读投影、不写链、不自取时钟（now 一律取 env）。

import {
  buildInterpretBag,
  buildTitleMessages,
  bodyOf,
  conversationsOf,
  findConversation,
  firstMessageOf,
  modelConfigOf,
  shouldGenerateTitle,
  slotOf,
  stripCurrentTurn,
  threadKey,
  workspaceKnown,
} from './assemble.ts'
import { resolveTitle } from './title.ts'
import {
  asString,
  errorValue,
  externOnly,
  isErrorValue,
  isRecord,
  mergeDirectives,
} from './plan.ts'
import { causeFromError, causeOf, cancelled, refused } from './contract/index.ts'
import type { TurnOutcome } from './contract/index.ts'
import { BadArgsError, ServiceError } from './types.ts'
import type { TitleWiring, Wiring } from './wiring.ts'
import type { CallEnv, Handler, Json, PortCaller, Rec } from './types.ts'

/** 服务依赖：反向调用通道 + 生效接线（单测可注入假端口）。 */
export interface ChatDeps {
  port: PortCaller
  wiring: Wiring
  /** 回合开始事件出口（`chat.turn.started`）；单测缺省不发。 */
  emit?: (topic: string, payload: Json) => void
}

/** 引用水合端口（`ref-hydrate.hydrate`）：按身份把投影 refs 解析成闭包；任何失败按拆分前语义映射 def_unavailable。 */
export interface RefHydrator {
  hydrate(identity: string, refs: Json): Promise<Rec>
}

/** 构造水合端口：反向调 `ref-hydrate.hydrate`；已是对象 / 非数组短路（不打无谓往返）。 */
export function makeHydrator(port: PortCaller): RefHydrator {
  return {
    hydrate: async (identity, refs) => {
      if (isRecord(refs)) return refs
      if (!Array.isArray(refs)) return {}
      const outcome = await port.call('ref-hydrate', 'hydrate', { identity, refs })
      if (!outcome.ok) throw new ServiceError('def_unavailable', outcome.message)
      return isRecord(outcome.value) ? outcome.value : {}
    },
  }
}

/**
 * 回合开始事件主题：对话回合是**嵌套 eval**（续跑在 `ui-approval.decide` / `question.answer`
 * 顶层 run 内跑）时没有独立宿主 run 生命周期，客户端拿不到「回合已开始」，只能等首个
 * `model.delta`——输入卡 / 工作态在首 token 前空窗。本服务在派发解释前自报一次。
 * 载荷：`{turn_id, run, thread, conversation, source}`；`run` = 顶层 run id（与宿主 `run.finished` 配对、可取消）。
 */
export const TURN_STARTED_TOPIC = 'chat.turn.started'

/**
 * 回合结局事件主题：与开始事件对称，向**所有已连客户端**播报实时业务结局。
 * 命令回执只到发起者（ui-composer），而 ui-chat 只听事件，且审批裁决触发的 resume 发起者不是 composer，
 * 故终态回合必须经本事件广播。载荷：`{turn_id, thread, conversation, outcome, source}`
 * + 摘要里确实存在的 `progress`（图内进度）/ `lifecycle`（解释器生命周期）/ `stop_reason`（预算收口原因）。
 */
export const TURN_SETTLED_TOPIC = 'chat.turn.settled'

/**
 * 回合挂起事件主题：`approval.wait` 返回 pending 时回合**未终结**（工具尚未执行），
 * 但宿主 run 会结束、`chat.turn.settled` 不会发。本事件把「等审批 / 等作答」的中间态显式广播，
 * 客户端据此保留在途回合并显示等待态，而不是把本段当成回合已定稿、恢复时再拉起一块新的在途回合。
 * 载荷：`{turn_id, run, thread, conversation, pending, source}`（`pending` = 挂起种类，如 `approval`）
 * + 摘要里确实存在的 `progress`（图内进度）。
 */
export const TURN_PENDING_TOPIC = 'chat.turn.pending'

function emitTurnStarted(
  deps: ChatDeps,
  env: CallEnv,
  turnId: string,
  thread: string,
  conversationId: string | null,
  source: 'send' | 'resume',
  progress: Json | null = null,
): void {
  const payload: Rec = {
    turn_id: turnId,
    run: env.run,
    thread,
    conversation: conversationId,
    source,
  }
  // 段续跑随 args 带来的图内进度：下一段起点即广播，UI 轮次实时更新（不臆造值）。
  if (progress !== null) payload['progress'] = progress
  deps.emit?.(TURN_STARTED_TOPIC, payload)
}

function emitTurnSettled(
  deps: ChatDeps,
  turnId: string,
  thread: string,
  conversationId: string | null,
  outcome: TurnOutcome,
  source: 'send' | 'resume' | 'cancel',
  extra: Rec | null = null,
): void {
  const payload: Rec = {
    turn_id: turnId,
    thread,
    conversation: conversationId,
    outcome: outcome as unknown as Json,
    source,
  }
  // 进度 / 生命周期 / 预算收口原因只在摘要确实给出时才带（不臆造值）。
  if (extra !== null) {
    for (const key of Object.keys(extra)) {
      if (extra[key] !== undefined) payload[key] = extra[key]
    }
  }
  deps.emit?.(TURN_SETTLED_TOPIC, payload)
}

function emitTurnPending(
  deps: ChatDeps,
  env: CallEnv,
  turnId: string,
  thread: string,
  conversationId: string | null,
  pending: string,
  source: 'send' | 'resume',
  progress: Json | null = null,
): void {
  const payload: Rec = {
    turn_id: turnId,
    run: env.run,
    thread,
    conversation: conversationId,
    pending,
    source,
  }
  if (progress !== null) payload['progress'] = progress
  deps.emit?.(TURN_PENDING_TOPIC, payload)
}

/** 图内进度（只取摘要里确实存在的对象，不臆造）：UI 据此显示当前编排节点。 */
function summaryProgress(summary: Rec): Rec | null {
  const progress = summary['progress']
  return isRecord(progress) ? progress : null
}

/**
 * 回合终态事件的附加字段：图内进度 + 解释器生命周期 + 预算收口原因。
 * 生命周期取摘要 `lifecycle`；收口原因取结局 `stop_reason`（仅预算主动停的 committed 携带）。
 * 缺失即不落键（「只带存在的键，不发明值」）。
 */
function summaryExtras(summary: Rec): Rec {
  const extra: Rec = {}
  const progress = summaryProgress(summary)
  if (progress !== null) extra['progress'] = progress
  if (typeof summary['lifecycle'] === 'string') extra['lifecycle'] = summary['lifecycle']
  const outcome = summary['outcome']
  if (isRecord(outcome) && typeof outcome['stop_reason'] === 'string') {
    extra['stop_reason'] = outcome['stop_reason']
  }
  return extra
}

/** 投影里 refs 会被本服务消费的身份（其余身份只读 body，无需解析引用）。 */
const REF_IDENTITIES = [
  'session',
  'loop-policy',
  'evolution',
  'approval',
  'question',
  'todo',
  'agents',
] as const

/** 把投影切片里各身份的 refs（哈希列表）按需解析成闭包；已是对象则原样。 */
async function hydrateIds(
  ids: Json,
  hydrator: RefHydrator,
  identities: readonly string[] = REF_IDENTITIES,
): Promise<Json> {
  if (!isRecord(ids)) return ids
  const out: Rec = { ...ids }
  for (const identity of identities) {
    const entry = out[identity]
    if (!isRecord(entry)) continue
    out[identity] = { ...entry, refs: await hydrator.hydrate(identity, entry['refs']) }
  }
  return out
}

/** 槽 kind：只有 `chat.message` 跑管道。 */
const CHAT_MESSAGE = 'chat.message'

/** 子代理线程种类：槽以 `thread_kind:'subagent'` 声明时，开一条承载任务 + 父检查点的隔离旁路线程。 */
const SUBAGENT_KIND = 'subagent'

/**
 * 子代理回合规格（从 `chat.message` 槽读取）：任务提示词 + 父检查点 + 父 / 人格 / 目标会话。
 * 仅当槽声明 `thread_kind:'subagent'` 时返回；否则 null（主线程管道不变）。
 * 任务优先取 `task_prompt`，缺省回落槽正文（空任务在 `send` 内以 `empty_slot` 拒绝）。
 */
interface SubagentSpec {
  conversationId: string | null
  taskPrompt: string | null
  parentCheckpoint: Json | null
  parentSummaries: Json[] | null
  parent: Rec | null
  agent: Rec | null
}

function subagentSpecOf(slot: Json): SubagentSpec | null {
  const rec = isRecord(slot) ? slot : null
  if (rec === null || asString(rec['thread_kind']) !== SUBAGENT_KIND) return null
  return {
    conversationId: asString(rec['conversation_id']),
    taskPrompt: asString(rec['task_prompt']) ?? asString(rec['text']) ?? asString(rec['content']),
    parentCheckpoint:
      isRecord(rec['parent_checkpoint']) || typeof rec['parent_checkpoint'] === 'string'
        ? (rec['parent_checkpoint'] as Json)
        : null,
    parentSummaries: Array.isArray(rec['parent_summaries'])
      ? (rec['parent_summaries'] as Json[])
      : null,
    parent: isRecord(rec['parent']) ? (rec['parent'] as Rec) : null,
    agent: isRecord(rec['agent']) ? (rec['agent'] as Rec) : null,
  }
}

/** 运行记录 owner 身份（消息链 / 输入槽 / 待办已出世界，改经 `eff` 问 owner）。 */
const SESSION_PORT = 'session'
const SESSION_READ = 'read'
const SESSION_TURN_OPEN = 'turn_open'
const SESSION_TURN_INSERT = 'turn_insert'
const SESSION_TURN_SETTLE = 'turn_settle'
const SESSION_TURN_CANCEL = 'turn_cancel'
const SESSION_ACK_INBOX = 'ack_inbox'
const INPUT_PORT = 'input'
const INPUT_READ = 'read'
const TODO_PORT = 'todo'
const TODO_INVOKE = 'invoke'
const CONFIG_PORT = 'config'
const CONFIG_READ = 'read'
const MCP_PORT = 'mcp'
const MCP_READ = 'read'
const WORKSPACE_PORT = 'workspace'
const WORKSPACE_READ = 'read'
const SKILL_PORT = 'skill'
const SKILL_READ = 'read'

/** 必需 owner 读取结果：session / config 读失败即 fail-closed，不静默回落空切片。 */
interface OwnerSlices {
  ids: Json
  /** session owner 读回的原始切片（段续跑据此把当前回合消息移出历史窗口）。 */
  session: Rec
  sessionFailed: boolean
  configFailed: boolean
}

/**
 * 从 owner 服务取会话切片、输入槽与当前会话待办，覆盖投影里的同名身份条目。
 * 消息链 / 输入槽 / 待办已出世界（不产 `write` directive），服务读自有持久存储后返回。
 * 必需 owner（session / config）读不到即据实上报，不拿空切片继续（否则把「owner 挂了」误报成别的失败）。
 */
async function withOwnerSlices(
  deps: ChatDeps,
  ids: Json,
  env: CallEnv,
  thread: string,
  turnId: string | null = null,
): Promise<OwnerSlices> {
  const base: Rec = isRecord(ids) ? { ...ids } : {}
  const sessionArgs: Rec = turnId !== null ? { turn_id: turnId } : {}
  const sessionOutcome = await deps.port.call(SESSION_PORT, SESSION_READ, sessionArgs)
  const sessionFailed = !sessionOutcome.ok || isErrorValue(sessionOutcome.value)
  const session =
    !sessionFailed && isRecord(sessionOutcome.value)
      ? sessionOutcome.value
      : { version: 1, current: null, conversations: [] }
  const inputOutcome = await deps.port.call(INPUT_PORT, INPUT_READ, { thread })
  const input = inputOutcome.ok && isRecord(inputOutcome.value) ? inputOutcome.value : { slots: {} }
  base[SESSION_PORT] = {
    body: session,
    refs: isRecord(session['refs']) ? session['refs'] : {},
    data_gen: null,
  }
  base[INPUT_PORT] = { body: input }

  const conversationId = asString(session['current'])
  const todoOutcome =
    conversationId === null
      ? null
      : await deps.port.call(TODO_PORT, TODO_INVOKE, {
          tool: 'todo.read',
          session_id: conversationId,
        })
  const todoResult =
    todoOutcome !== null &&
    todoOutcome.ok &&
    isRecord(todoOutcome.value) &&
    todoOutcome.value['ok'] === true &&
    isRecord(todoOutcome.value['result'])
      ? (todoOutcome.value['result'] as Rec)
      : { items: [] }
  base[TODO_PORT] = { body: todoResult }

  // 用户配置 / 界面配置已出世界：问 config owner（世界切片作基线，服务合并自有存储后回整份视图）。
  // 读失败**不回落世界切片**：那是把「config 服务挂了」误报成「没配模型」的根因，据实上报由上层分码。
  const configOutcome = await deps.port.call(
    CONFIG_PORT,
    CONFIG_READ,
    isRecord(base[CONFIG_PORT]) ? base[CONFIG_PORT] : {},
  )
  const configFailed = !configOutcome.ok || isErrorValue(configOutcome.value)
  if (!configFailed && isRecord(configOutcome.value)) base[CONFIG_PORT] = configOutcome.value

  // MCP 清单（服务器 + 工具）已出世界：问 mcp owner。
  const mcpOutcome = await deps.port.call(MCP_PORT, MCP_READ, {})
  if (mcpOutcome.ok && isRecord(mcpOutcome.value)) base[MCP_PORT] = { body: mcpOutcome.value }

  // 工作区清单已出世界：问 workspace owner（`workspace_root` 由 bag 装配运行时读 owner）。
  const workspaceOutcome = await deps.port.call(WORKSPACE_PORT, WORKSPACE_READ, {})
  if (workspaceOutcome.ok && isRecord(workspaceOutcome.value))
    base[WORKSPACE_PORT] = { body: workspaceOutcome.value }

  // 技能清单已出世界：问 skill owner。
  const skillOutcome = await deps.port.call(SKILL_PORT, SKILL_READ, {})
  if (skillOutcome.ok && isRecord(skillOutcome.value))
    base[SKILL_PORT] = { body: skillOutcome.value }
  return { ids: base, session, sessionFailed, configFailed }
}

/** #33 图解释器入口（编排唯一的 eff）。 */
const LOOP_PORT = 'loop-policy'
const INTERPRET_METHOD = 'interpret'
const CANCEL_METHOD = 'cancel'
/** 队列写口：回合/输入/队列词汇归门面提供方拥有，本服务不再硬连 session。 */
const NOTE_INPUT_METHOD = 'note-input'
const PROMOTE_INPUT_METHOD = 'promote-input'

/** #36 模型 IO 服务：取消链上销毁在途 HTTP 请求。 */
const MODEL_PORT = 'model'
const MODEL_ABORT_METHOD = 'abort'
const MODEL_COMPLETE_METHOD = 'complete'

interface TurnContext {
  ids: Json
  thread: string
  slot: Json
  conversation: Rec | null
  conversationId: string | null
  config: Rec
  sessionBody: Rec
}

/** 从投影切片解析本回合上下文（会话 / 槽 / 连接实例）。 */
function turnContext(ids: Json, env: CallEnv): TurnContext {
  const thread = threadKey(env.thread)
  const sessionBody = bodyOf(ids, 'session') ?? {}
  const conversationId = asString(sessionBody['current'])
  return {
    ids,
    thread,
    slot: slotOf(ids, thread) ?? {},
    conversation: conversationId === null ? null : findConversation(sessionBody, conversationId),
    conversationId,
    config: modelConfigOf(ids) ?? {},
    sessionBody,
  }
}

/** 连接实例可用性：vendor / model / base_url 齐备才允许派发。 */
function configUsable(config: Rec): boolean {
  return asString(config['base_url']) !== null && asString(config['model']) !== null
}

/** 槽写入时的 run id（`slot_ref`）：同槽不开第二回合的幂等键。 */
function slotRefOf(ids: Json, thread: string): string | null {
  const input = bodyOf(ids, 'input')
  if (input === null) return null
  const direct = asString(input['slot_ref'])
  if (direct !== null) return direct
  const refs = isRecord(input['slot_refs']) ? (input['slot_refs'] as Rec) : null
  return refs === null ? null : asString(refs[thread])
}

/** 本回合用户消息记录（交 `turn_open` 与回合头同一次 append 落盘）。 */
function userMessageOf(slot: Json): Rec {
  const slotRec = isRecord(slot) ? slot : {}
  const message: Rec = {
    role: 'user',
    content: asString(slotRec['text']) ?? asString(slotRec['content']) ?? '',
  }
  if (Array.isArray(slotRec['attachments'])) message['attachments'] = slotRec['attachments']
  if (Array.isArray(slotRec['parts'])) message['parts'] = slotRec['parts']
  return message
}

/** 回合身份：同槽（同一 `slot_ref`）恒定，重发 / 重启幂等；游标据此续同一回合。 */
function turnIdFor(slotRef: string): string {
  return `t-${slotRef}`
}

/** 取解释器返回计划末条 `kind:'interpret'` 的 extern 摘要。 */
function interpretSummary(value: Json): Rec | null {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return null
  for (const directive of value['$directives'] as Json[]) {
    if (isRecord(directive) && directive['kind'] === 'extern' && isRecord(directive['payload'])) {
      const payload = directive['payload'] as Rec
      if (payload['kind'] === 'interpret') return payload
    }
  }
  return null
}

/** 计划里是否带自续跑 eval（`chat.resume{turn_id}`，无游标）⇒ 本段是段终态、回合未完，非终态回执。 */
function segmentContinues(value: Json): boolean {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return false
  for (const directive of value['$directives'] as Json[]) {
    if (
      isRecord(directive) &&
      directive['kind'] === 'eval' &&
      directive['command'] === 'chat.resume'
    ) {
      const args = isRecord(directive['args']) ? (directive['args'] as Rec) : null
      if (args !== null && asString(args['turn_id']) !== null && !isRecord(args['cursor']))
        return true
    }
  }
  return false
}

/** 解释器调用结果：成功带计划值，失败带结局码与下游码（下游码只进 `cause`，不改名）。 */
type InterpretOutcome =
  | { ok: true; value: Json }
  | {
      ok: false
      attributableTo: 'transport' | 'graph'
      code: string
      causeCode: string
      message: string | null
      error: Json | null
    }

/** 调 `loop-policy.interpret`；传输失败与结构化失败都保留下游码供结局 `cause` 透传。 */
async function callInterpret(deps: ChatDeps, bag: Rec): Promise<InterpretOutcome> {
  const outcome = await deps.port.call(LOOP_PORT, INTERPRET_METHOD, bag)
  if (!outcome.ok) {
    return {
      ok: false,
      attributableTo: 'transport',
      code: 'loop_unavailable',
      causeCode: outcome.code ?? 'transport_failed',
      message: outcome.message,
      error: null,
    }
  }
  const value = outcome.value
  if (isErrorValue(value)) {
    const error = isRecord(value['error']) ? (value['error'] as Rec) : null
    const causeCode = asString(error?.['code']) ?? 'downstream_refusal'
    return {
      ok: false,
      attributableTo: 'graph',
      code: 'downstream_refusal',
      causeCode,
      message: asString(error?.['message']),
      error,
    }
  }
  return { ok: true, value }
}

/** 传输 / 结构化失败：包成 `refused` 结局，下游码原样进 `cause`。 */
function interpretRefusal(failure: Extract<InterpretOutcome, { ok: false }>): TurnOutcome {
  const from = `${LOOP_PORT}.${INTERPRET_METHOD}`
  const cause =
    failure.error !== null
      ? causeFromError(from, failure.error)
      : causeOf(from, failure.causeCode, failure.message ?? undefined)
  if (failure.attributableTo === 'transport') {
    return refused({
      code: 'loop_unavailable',
      attributableTo: 'transport',
      retryable: true,
      cause,
      message: failure.message ?? undefined,
    })
  }
  return refused({
    code: 'downstream_refusal',
    attributableTo: 'graph',
    retryable: false,
    cause,
    message: failure.message ?? undefined,
  })
}

/**
 * 段边界提升待发输入（best-effort）：把会话内存里的待发输入落为 `step.user`（追加在本段输出之后），
 * 使其进入消息流与下一轮模型上下文。失败不阻断续跑 / 收口。
 */
async function promoteInputs(deps: ChatDeps, turnId: string): Promise<void> {
  try {
    await deps.port.call(LOOP_PORT, PROMOTE_INPUT_METHOD, { turn_id: turnId })
  } catch {
    // 提升失败不阻断续跑 / 收口：待发输入仍在会话内存，下次边界或收口再提升。
  }
}

/** 收口：CAS 落定后向全客户端广播结局；落定失败不广播（回合未终态）。 */
async function settleTurn(
  deps: ChatDeps,
  turnId: string,
  thread: string,
  conversationId: string | null,
  outcome: TurnOutcome,
  source: 'send' | 'resume',
): Promise<boolean> {
  // 收口前先提升待发输入：不丢消息、进入流。
  await promoteInputs(deps, turnId)
  const settled = await deps.port.call(SESSION_PORT, SESSION_TURN_SETTLE, {
    turn_id: turnId,
    outcome,
  })
  const persisted = settled.ok && isRecord(settled.value) && settled.value['ok'] === true
  if (persisted) emitTurnSettled(deps, turnId, thread, conversationId, outcome, source)
  return persisted
}

/** 回合内失败的即时回执：结局随回执交发起者。 */
function refusalReceipt(
  turnId: string,
  thread: string,
  conversationId: string | null,
  outcome: TurnOutcome,
): Json {
  return externOnly({
    ok: false,
    outcome: outcome as unknown as Json,
    turn_id: turnId,
    thread,
    conversation: conversationId,
  })
}

/**
 * 重复回合回执：本槽已有在途回合（重发 / 重试 / 重启）。不重新执行工具，只回执既有回合身份；
 * 既有回合已收口则带出结局。回执标 `duplicate` 供 UI 区分「已在途 / 已收口」与「刚受理」。
 */
function duplicateReceipt(thread: string, conversationId: string | null, opened: Rec): Json {
  const settled = opened['state'] === 'settled'
  const payload: Rec = {
    ok: true,
    duplicate: true,
    status: settled ? 'settled' : 'in_flight',
    turn_id: asString(opened['turn_id']),
    thread,
    conversation: asString(opened['conversation']) ?? conversationId,
  }
  if (isRecord(opened['outcome'])) payload['outcome'] = opened['outcome']
  return externOnly(payload)
}

/** 回合开始前的拒绝：不持久化回合、走命令回执交 composer 渲染引导，输入槽保留供重试。 */
function preTurnRefusal(code: string, message: string): Json {
  return externOnly(errorValue(code, message))
}

/** 会话切片里的未读收件箱（`inbox_unread`）；缺失 / 非数组回空，非对象条目跳过。 */
function inboxUnreadOf(session: Rec): Rec[] {
  const list = session['inbox_unread']
  if (!Array.isArray(list)) return []
  return list.filter((item): item is Rec => isRecord(item))
}

/** 未读条目的最大 seq（无有效 seq 回 null）；ack 只推进到这个水位（收件箱未读恒为连续后缀）。 */
function maxUnreadSeq(items: Rec[]): number | null {
  let max: number | null = null
  for (const item of items) {
    const seq = item['seq']
    if (typeof seq === 'number' && Number.isFinite(seq) && (max === null || seq > max)) max = seq
  }
  return max
}

/**
 * 本回合是否以「拒 / 取消」收口（从解释器计划末条 `interpret` 摘要的 outcome 读）。
 * 这两种终态视为失败 / 中止：未读不 ack，保留供重试 / 续跑重投。
 */
function abortedOrRefused(value: Json): boolean {
  const summary = interpretSummary(value)
  if (summary === null) return false
  const outcome = summary['outcome']
  if (!isRecord(outcome)) return false
  const kind = asString(outcome['kind'])
  return kind === 'refused' || kind === 'cancelled'
}

/**
 * 收件箱已读确认（append-only）：把本回合注入 bag 的未读水位推进到最大 seq。
 *
 * 确认点定在 **interpret 调用成功返回、且回合未以拒 / 取消收口之后**：只有解释器已实际执行
 * （模型确已消费这些消息）且回合没有失败 / 中止才 ack。传输失败 / 结构化失败（`interpreted.ok === false`）
 * 以及解释器产出 `refused` / `cancelled` 终态都不 ack，未读保留供重试 / 续跑重投——失败 / 中止回合不丢消息。
 * 幂等且单调（session 侧以 `max` 守卫，重复 ack 旧 seq 为 no-op）；session ack 失败不改变本回合结局、
 * 不改会话状态，仅水位未推进 ⇒ 下轮重投（**retryable-with-audit**：至少一次投递）。
 */
async function ackInbox(deps: ChatDeps, conversation: string | null, items: Rec[]): Promise<void> {
  if (conversation === null) return
  const seq = maxUnreadSeq(items)
  if (seq === null) return
  await deps.port.call(SESSION_PORT, SESSION_ACK_INBOX, { conversation, seq })
}

/**
 * 内联标题生成：system 提示 + 用户首条消息，非流式单次 `model.complete`；
 * 失败 / 超时 / 空一律回 null，由调用方走确定性兜底（不报错、不阻塞主回合）。
 */
async function completeTitle(
  deps: ChatDeps,
  config: Rec,
  title: TitleWiring,
  firstMessage: string,
): Promise<string | null> {
  try {
    const outcome = await deps.port.call(
      MODEL_PORT,
      MODEL_COMPLETE_METHOD,
      {
        config,
        messages: buildTitleMessages(title.prompt, firstMessage),
        max_tokens: title.max_tokens,
      },
      { timeoutMs: title.timeout_ms },
    )
    if (!outcome.ok || !isRecord(outcome.value)) return null
    return asString(outcome.value['text'])
  } catch {
    return null
  }
}

/**
 * 首条消息标题旁路段（回合开始后异步）：本插件内联调 `model.complete` 生成标题，再 `session.set_title` 写回。
 * 不参与回合结局、不阻塞 interpret；模型失败 / 超时 / 空一律走 `resolveTitle` 的确定性兜底。
 */
async function generateTitle(
  deps: ChatDeps,
  params: {
    conversationId: string
    firstMessage: string
    config: Rec
    titleDefault: string
  },
): Promise<void> {
  const title = deps.wiring.title
  try {
    const modelText = await completeTitle(deps, params.config, title, params.firstMessage)
    const resolved = resolveTitle(modelText, params.firstMessage, title.max_chars, params.titleDefault)
    await deps.port.call(SESSION_PORT, 'set_title', {
      conversation: params.conversationId,
      title: resolved,
    })
  } catch {
    // 标题旁路段失败 / 取消不影响回合：缺省标题保留
  }
}

/**
 * 回合启动：读本线程槽 kind → 空槽 / 非 chat kind 幂等 no-op；
 * 校验必需 owner → `turn_open` 留痕（含建会话）→ 装配 interpret bag 派发 #33，
 * 再把首条消息的 title 旁路段按段序合并。终态回合广播 `chat.turn.settled`。
 */
async function send(
  args: Json,
  env: CallEnv,
  deps: ChatDeps,
  hydrator: RefHydrator,
): Promise<Json> {
  const projected = await hydrateIds(args, hydrator)
  if (!isRecord(projected)) throw new BadArgsError('ids must be an object')
  const wiring = deps.wiring
  const thread = threadKey(env.thread)
  const owners = await withOwnerSlices(deps, projected, env, thread)
  const ids = owners.ids
  const slot = slotOf(ids, thread)
  if (!isRecord(slot) || slot['kind'] !== CHAT_MESSAGE) {
    return wiring.on_empty_slot === 'error'
      ? preTurnRefusal('empty_slot', `no ${CHAT_MESSAGE} in thread ${thread}`)
      : externOnly({ ok: true, noop: true })
  }

  const turn = turnContext(ids, env)
  // 必需档先于 turn_open 校验：session 读失败 ⇒ owner_unavailable；config 读失败 ⇒ owner_unavailable；
  // config 读到但未配模型 ⇒ model_not_configured（沿用既有码，不新造）。
  if (owners.sessionFailed) return preTurnRefusal('owner_unavailable', 'session owner read failed')
  if (owners.configFailed) return preTurnRefusal('owner_unavailable', 'config owner read failed')
  if (!configUsable(turn.config)) {
    return preTurnRefusal('model_not_configured', 'config vendor/model/base_url missing')
  }

  // 子代理回合：槽声明 `thread_kind:'subagent'` 时开一条隔离旁路线程——任务 + 父检查点，
  // 不继承父历史；会话 kind = subagent，不抢占 `current`。任务与父检查点随 `turn_open` 持久化。
  const subagent = subagentSpecOf(turn.slot)
  // 子代理线程不是 `current`：若槽指向一条已存在的旁路会话，另读该会话切片以取它的未读收件箱。
  let scopedInbox: Rec | null = null
  let newConversation: Rec | null = null
  if (subagent !== null) {
    const slotRec = isRecord(turn.slot) ? turn.slot : {}
    const existing =
      subagent.conversationId !== null
        ? findConversation(turn.sessionBody, subagent.conversationId)
        : null
    if (existing !== null) {
      turn.conversationId = subagent.conversationId
      turn.conversation = existing
      const inboxSlice = await deps.port.call(SESSION_PORT, SESSION_READ, {
        conversation: subagent.conversationId,
      })
      if (inboxSlice.ok && isRecord(inboxSlice.value)) scopedInbox = inboxSlice.value
    } else {
      const workspaceId = asString(slotRec['workspace_id'])
      if (workspaceId === null || !workspaceKnown(turn.ids, workspaceId)) {
        return preTurnRefusal('workspace_missing', 'workspace_id required to start a conversation')
      }
      if (subagent.taskPrompt === null) {
        return preTurnRefusal('empty_slot', 'subagent task_prompt is required')
      }
      const conversationId =
        subagent.conversationId ?? `c-${env.now}-${conversationsOf(turn.sessionBody).length}`
      turn.conversationId = conversationId
      turn.conversation = {
        id: conversationId,
        workspace_id: workspaceId,
        kind: SUBAGENT_KIND,
        parent: subagent.parent,
        agent: subagent.agent,
        title: subagent.taskPrompt,
        count: 0,
        head: null,
      }
      newConversation = {
        id: conversationId,
        workspace_id: workspaceId,
        kind: SUBAGENT_KIND,
        parent: subagent.parent,
        agent: subagent.agent,
        title: subagent.taskPrompt,
      }
    }
  } else if (turn.conversationId === null) {
    // 无当前会话：按槽内 `workspace_id` / `conversation_id` 装配一个 main 会话规格，
    // 由 `turn_open` 与回合头同一次 append 建（不再有「回合已开始但会话不存在」的中间态）。
    const slotRec = isRecord(turn.slot) ? turn.slot : {}
    const workspaceId = asString(slotRec['workspace_id'])
    if (workspaceId === null || !workspaceKnown(turn.ids, workspaceId)) {
      return preTurnRefusal('workspace_missing', 'workspace_id required to start a conversation')
    }
    const conversationId =
      asString(slotRec['conversation_id']) ??
      `c-${env.now}-${conversationsOf(turn.sessionBody).length}`
    turn.conversationId = conversationId
    turn.conversation = {
      id: conversationId,
      workspace_id: workspaceId,
      kind: 'main',
      title: wiring.title.title_default,
      count: 0,
      head: null,
    }
    newConversation = { id: conversationId, workspace_id: workspaceId }
  }

  // 首条消息标题：**判定**在 turn_open 之前（取决于建会话前的 count / title），**生成**挪到回合开始之后
  // 异步跑——标题模型调用曾卡在 turn_open 前，害得首轮 `chat.turn.started`（工作态 / 消息流）要等标题返回。
  // 子代理线程不跑标题段（标题取任务提示词，且省一次模型调用）。
  const sessionBody = turn.sessionBody
  const titleDefault = wiring.title.title_default
  const shouldTitle =
    subagent === null &&
    wiring.title.when === 'first_message' &&
    turn.conversationId !== null &&
    shouldGenerateTitle(turn.conversation, titleDefault)
  const titleConversationId = turn.conversationId

  // 转换点 A：调模型之前写回合头，携带用户消息与槽引用（成功后才清槽）。
  const slotRef = slotRefOf(ids, thread) ?? env.run ?? `t${env.now}`
  const turnId = turnIdFor(slotRef)
  const openArgs: Rec = {
    turn_id: turnId,
    user_message: userMessageOf(turn.slot),
    slot_ref: slotRef,
    thread_id: thread,
    thread_kind: asString(turn.conversation?.['kind']) ?? 'main',
  }
  if (newConversation !== null) openArgs['new_conversation'] = newConversation
  if (subagent !== null) {
    if (subagent.taskPrompt !== null) openArgs['task_prompt'] = subagent.taskPrompt
    if (subagent.parentCheckpoint !== null)
      openArgs['parent_checkpoint'] = subagent.parentCheckpoint
    if (subagent.parentSummaries !== null) openArgs['parent_summaries'] = subagent.parentSummaries
  }
  const opened = await deps.port.call(SESSION_PORT, SESSION_TURN_OPEN, openArgs)
  if (!opened.ok) {
    // run 已被取消 / 中止：宿主对已终局 run 的反向调用回 `cancelled`，此处**不得**再走 turn_open，
    // 否则会在宿主 run 已 `run.finished` 后补发 `chat.turn.started`（幽灵回合），把客户端生成态重新点亮。
    if (opened.code === 'cancelled') {
      return refusalReceipt(
        turnId,
        thread,
        turn.conversationId,
        cancelled({ message: 'turn cancelled before open' }),
      )
    }
    return refusalReceipt(
      turnId,
      thread,
      turn.conversationId,
      refused({
        code: 'owner_unavailable',
        attributableTo: 'owner',
        retryable: true,
        cause: causeOf(`${SESSION_PORT}.${SESSION_TURN_OPEN}`, opened.code, opened.message),
      }),
    )
  }
  const openedValue = isRecord(opened.value) ? (opened.value as Rec) : {}
  if (openedValue['ok'] !== true) {
    const reason = asString(openedValue['reason']) ?? 'owner_unavailable'
    // turn_busy 是服务端兜底：槽必须保留（不清），排队的消息不丢。
    const code = reason === 'turn_busy' ? 'turn_busy' : 'owner_unavailable'
    return refusalReceipt(
      turnId,
      thread,
      turn.conversationId,
      refused({
        code,
        attributableTo: 'owner',
        retryable: code === 'turn_busy',
        cause: causeOf(`${SESSION_PORT}.${SESSION_TURN_OPEN}`, reason),
      }),
    )
  }
  // 同一槽已有回合：不重跑解释器（否则工具再执行一遍），回执既有回合；槽同样保留。
  if (asString(openedValue['status']) === 'already_open') {
    return duplicateReceipt(thread, turn.conversationId, openedValue)
  }
  const activeTurnId = asString(openedValue['turn_id']) ?? turnId
  const conversationId = asString(openedValue['conversation']) ?? turn.conversationId

  const bag = buildInterpretBag({
    ids: turn.ids,
    wiring,
    slot: turn.slot,
    conversation: turn.conversation,
    conversationId,
    config: turn.config,
    thread: turn.thread,
    sessionBody,
    threadKind: asString(turn.conversation?.['kind']),
    taskPrompt: subagent?.taskPrompt ?? null,
    parentCheckpoint: subagent?.parentCheckpoint ?? null,
    parentSummaries: subagent?.parentSummaries ?? null,
  })
  bag['turn_id'] = activeTurnId
  const unread = inboxUnreadOf(scopedInbox ?? sessionBody)
  if (unread.length > 0) bag['inbox_unread'] = unread as unknown as Json
  emitTurnStarted(deps, env, activeTurnId, turn.thread, conversationId, 'send')
  // 标题旁路段现挂在这里：回合已开始（工作态 / 消息流不再等标题），标题生成与 interpret 并发，
  // 生成完再 `set_title` 写回。旁路段失败 / 取消只丢标题，不影响回合结局。
  if (shouldTitle && titleConversationId !== null) {
    void generateTitle(deps, {
      conversationId: titleConversationId,
      firstMessage: firstMessageOf(turn.slot),
      config: turn.config,
      titleDefault,
    })
  }
  const interpreted = await callInterpret(deps, bag)
  if (!interpreted.ok) {
    const outcome = interpretRefusal(interpreted)
    await settleTurn(deps, activeTurnId, turn.thread, conversationId, outcome, 'send')
    return refusalReceipt(activeTurnId, turn.thread, conversationId, outcome)
  }
  // interpret 成功且回合未以拒 / 取消收口 = 模型已消费本轮输入：确认（ack）已注入的未读。
  if (!abortedOrRefused(interpreted.value)) await ackInbox(deps, conversationId, unread)

  const merged = mergeDirectives([interpreted.value])
  const summary = interpretSummary(interpreted.value)
  if (summary === null) {
    // 段终态：本段完成、回合未完，计划里的自续跑 eval 由宿主在同一 run 内继续执行，不收口。
    if (segmentContinues(interpreted.value)) return merged
    const outcome = refused({ code: 'no_plan', attributableTo: 'graph', retryable: true })
    await settleTurn(deps, activeTurnId, turn.thread, conversationId, outcome, 'send')
    return refusalReceipt(activeTurnId, turn.thread, conversationId, outcome)
  }
  emitSettledFromSummary(deps, summary, activeTurnId, turn.thread, conversationId, 'send')
  const pendingKind = asString(summary['pending'])
  if (pendingKind !== null) {
    emitTurnPending(
      deps,
      env,
      activeTurnId,
      turn.thread,
      conversationId,
      pendingKind,
      'send',
      summaryProgress(summary),
    )
  }
  return merged
}

/** 终态回合的 `chat.turn.settled`：仅属主 CAS 落定成功（`settled:true`）时广播。 */
function emitSettledFromSummary(
  deps: ChatDeps,
  summary: Rec,
  turnId: string,
  thread: string,
  conversationId: string | null,
  source: 'send' | 'resume',
): void {
  if (summary['settled'] !== true) return
  const outcome = summary['outcome']
  if (!isRecord(outcome)) return
  emitTurnSettled(
    deps,
    turnId,
    thread,
    conversationId,
    outcome as unknown as TurnOutcome,
    source,
    summaryExtras(summary),
  )
}

/** 展示历史：问 `session` 服务取自有存储还原的窗口（不再读投影 refs / 逐跳 hydrator）。 */
async function history(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const outcome = await deps.port.call(SESSION_PORT, 'history', {
    conversation: asString(record['conversation']),
    before: asString(record['before']),
    limit: typeof record['limit'] === 'number' ? record['limit'] : null,
    full: record['full'] === true,
  })
  if (!outcome.ok) return errorValue('session_unavailable', outcome.message)
  if (isErrorValue(outcome.value)) return outcome.value
  return outcome.value
}

/** 回合切片里的某个回合视图（无则 null）。 */
function turnViewOf(session: Rec, turnId: string): Rec | null {
  const turns = Array.isArray(session['turns']) ? (session['turns'] as Json[]) : []
  for (const turn of turns) {
    if (isRecord(turn) && turn['turn_id'] === turnId) return turn
  }
  return null
}

/**
 * 跨 run 续跑（H18）：两种 args。
 * 1) 裁决 / 作答续跑 `{cursor, thread, payload?, ids?}`：`turn_id` 由游标携带，续同一回合、不重开回合头，
 *    解释器据游标还原图位置与挂起调用（原样保留）。
 * 2) 段续跑 `{turn_id, thread?, ids?}`（无 `cursor`，由本服务段尾 eval 自续）：解释器状态由会话步记录重建，
 *    投影切片经宿主 `inject` 并入；历史窗口回到回合起点，同回合进度由重建的 `extra_messages` 回灌。
 */
async function resume(
  args: Json,
  env: CallEnv,
  deps: ChatDeps,
  hydrator: RefHydrator,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('resume args must be an object')
  const cursor = args['cursor']
  const continuation = !isRecord(cursor)
  if (continuation && asString(args['turn_id']) === null)
    throw new BadArgsError('cursor must be an object')
  const turnId = isRecord(cursor)
    ? (asString(cursor['turn_id']) ?? asString(args['turn_id']))
    : asString(args['turn_id'])
  const projected = isRecord(args['ids']) ? await hydrateIds(args['ids'], hydrator) : {}
  const thread = threadKey(asString(args['thread']) ?? env.thread)
  // 段边界：先把待发输入落为 `step.user`，再取会话切片装配——本轮请求即读到（不再晚一轮）。
  if (turnId !== null) await promoteInputs(deps, turnId)
  // 续跑按 `turn_id` 取会话切片：子代理旁路线程不是 `current`，须按回合所属会话定位。
  const owners = await withOwnerSlices(deps, projected, env, thread, turnId)
  const ids = owners.ids
  const payload = isRecord(args['payload']) ? args['payload'] : null

  let sessionBody = bodyOf(ids, 'session') ?? {}
  const turn = turnId === null ? null : turnViewOf(owners.session, turnId)
  const turnConv = turn !== null ? asString(turn['conv']) : null
  let conversationId = turnConv ?? asString(sessionBody['current'])
  let conversation = conversationId === null ? null : findConversation(sessionBody, conversationId)
  const threadKind =
    (turn !== null ? asString(turn['thread_kind']) : null) ??
    (conversation !== null ? asString(conversation['kind']) : null)
  const subagent = threadKind === SUBAGENT_KIND
  const taskPrompt = turn !== null ? asString(turn['task_prompt']) : null
  const parentCheckpoint =
    turn !== null && turn['parent_checkpoint'] !== undefined
      ? (turn['parent_checkpoint'] as Json)
      : null
  const parentSummaries =
    turn !== null && Array.isArray(turn['parent_summaries'])
      ? (turn['parent_summaries'] as Json[])
      : null
  const config = modelConfigOf(ids) ?? {}
  if (owners.sessionFailed) {
    return externOnly(errorValue('owner_unavailable', 'session owner read failed'))
  }
  if (turnId === null) {
    return externOnly(errorValue('invalid_resume', 'resume cursor carries no turn_id'))
  }
  // 段续跑前置闸：回合已非 open（如取消竞态先落定）⇒ 不再派发任何节点，回执既有状态。
  if (continuation) {
    const state = turn === null ? null : asString(turn['state'])
    if (state !== null && state !== 'open') {
      return externOnly({
        ok: true,
        continuation: true,
        turn_id: turnId,
        state,
        outcome: isRecord(turn?.['outcome']) ? turn?.['outcome'] : null,
      })
    }
  }
  if (owners.configFailed || !configUsable(config)) {
    const outcome = refused({
      code: owners.configFailed ? 'owner_unavailable' : 'model_not_configured',
      attributableTo: owners.configFailed ? 'owner' : 'model',
      retryable: owners.configFailed,
    })
    await settleTurn(deps, turnId, thread, conversationId, outcome, 'resume')
    return refusalReceipt(turnId, thread, conversationId, outcome)
  }

  let slot: Json
  let resumeBag: Rec
  if (continuation) {
    if (subagent) {
      // 子代理隔离：历史块本就不组装，任务与父检查点随 bag 传入（不取父消息历史）。
      slot = slotOf(ids, thread) ?? {}
      resumeBag = { continuation: true, turn_id: turnId }
    } else {
      const stripped = stripCurrentTurn(owners.session, conversationId, turnId)
      ids['session'] = {
        ...(isRecord(ids['session']) ? (ids['session'] as Rec) : {}),
        body: stripped.session,
        refs: stripped.session['refs'] ?? {},
      }
      sessionBody = stripped.session
      conversation = stripped.conversation
      conversationId = asString(stripped.conversation?.['id']) ?? conversationId
      slot = stripped.userMessage ?? slotOf(ids, thread) ?? {}
      resumeBag = { continuation: true, turn_id: turnId }
    }
  } else {
    slot = slotOf(ids, thread) ?? {}
    resumeBag = { cursor, thread }
    if (payload !== null) resumeBag['payload'] = payload
  }
  const bag = buildInterpretBag({
    ids,
    wiring: deps.wiring,
    slot,
    conversation,
    conversationId,
    config,
    thread,
    sessionBody,
    threadKind: threadKind ?? undefined,
    taskPrompt,
    parentCheckpoint,
    parentSummaries,
  })
  bag['turn_id'] = turnId
  bag['resume'] = resumeBag
  const unread = inboxUnreadOf(sessionBody)
  if (unread.length > 0) bag['inbox_unread'] = unread as unknown as Json

  // 段续跑：图内进度随 `chat.resume` args 带来（loop-policy 段尾写入），下一段起点即广播给 UI。
  const resumeProgress = isRecord(args['progress']) ? (args['progress'] as Json) : null
  emitTurnStarted(deps, env, turnId, thread, conversationId, 'resume', resumeProgress)
  const interpreted = await callInterpret(deps, bag)
  if (!interpreted.ok) {
    const outcome = interpretRefusal(interpreted)
    await settleTurn(deps, turnId, thread, conversationId, outcome, 'resume')
    return refusalReceipt(turnId, thread, conversationId, outcome)
  }
  // interpret 成功且回合未以拒 / 取消收口 = 模型已消费本轮输入：确认（ack）已注入的未读。
  if (!abortedOrRefused(interpreted.value)) await ackInbox(deps, conversationId, unread)
  const merged = mergeDirectives([interpreted.value])
  const summary = interpretSummary(interpreted.value)
  if (summary === null) {
    // 段终态：续跑 eval 由宿主在同一 run 内继续执行，不收口、不广播。
    if (segmentContinues(interpreted.value)) return merged
    const outcome = refused({ code: 'no_plan', attributableTo: 'graph', retryable: true })
    await settleTurn(deps, turnId, thread, conversationId, outcome, 'resume')
    return refusalReceipt(turnId, thread, conversationId, outcome)
  }
  emitSettledFromSummary(deps, summary, turnId, thread, conversationId, 'resume')
  const pendingKind = asString(summary['pending'])
  if (pendingKind !== null) {
    emitTurnPending(
      deps,
      env,
      turnId,
      thread,
      conversationId,
      pendingKind,
      'resume',
      summaryProgress(summary),
    )
  }
  return merged
}

/** 已收口回合的回执：不回溯、不改写，带出现有结局（`cancel` no-op 与迟到取消共用）。 */
function settledReceipt(turnId: string, reason: string, outcome: Json | null): Rec {
  const payload: Rec = { ok: true, cancelled: false, turn_id: turnId, reason }
  if (isRecord(outcome)) payload['outcome'] = outcome
  return payload
}

/**
 * 取消一个回合（协作式，不杀进程、不回溯已落账）：先落取消意图，再通知两层持有在途工作的一方，最后经
 * CAS 落 `cancelled`。已收口的回合是 no-op（不把成功回合改写成失败）；输入槽不清理，用户可重试。
 */
async function cancel(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const turnId = asString(record['turn_id'])
  if (turnId === null) throw new BadArgsError('turn_id required')
  const thread = threadKey(asString(record['thread']) ?? env.thread)
  const recorded = await deps.port.call(SESSION_PORT, SESSION_TURN_CANCEL, { turn_id: turnId })
  if (!recorded.ok) return errorValue('session_unavailable', recorded.message)
  const value = isRecord(recorded.value) ? recorded.value : {}
  if (value['ok'] !== true) {
    return externOnly(settledReceipt(turnId, asString(value['reason']) ?? 'unknown_turn', null))
  }
  const conversationId = asString(value['conversation'])
  if (value['state'] === 'settled') {
    return externOnly(
      settledReceipt(
        turnId,
        'already_settled',
        isRecord(value['outcome']) ? value['outcome'] : null,
      ),
    )
  }
  // 通知两层持有在途工作的一方：先置标志（停止再派发），再销毁在途 HTTP（停止烧推理窗口与费用）。
  await deps.port.call(LOOP_PORT, CANCEL_METHOD, { turn_id: turnId })
  await deps.port.call(MODEL_PORT, MODEL_ABORT_METHOD, { turn_id: turnId })
  // 取消前提升待发输入：取消也留痕（消息不丢、进入流）。
  await promoteInputs(deps, turnId)
  const outcome = cancelled({ message: 'turn cancelled by user' })
  const settled = await deps.port.call(SESSION_PORT, SESSION_TURN_SETTLE, {
    turn_id: turnId,
    outcome,
  })
  if (settled.ok && isRecord(settled.value) && settled.value['ok'] === true) {
    emitTurnSettled(deps, turnId, thread, conversationId, outcome, 'cancel')
    return externOnly({
      ok: true,
      cancelled: true,
      turn_id: turnId,
      thread,
      conversation: conversationId,
      outcome,
    })
  }
  // CAS 拒绝：真实收口已先落定（迟到取消不改写结局）。
  const raced =
    settled.ok && isRecord(settled.value) && isRecord(settled.value['outcome'])
      ? (settled.value['outcome'] as Json)
      : null
  return externOnly(settledReceipt(turnId, 'already_settled', raced))
}

/** 构造方法表（依赖注入：反向调用通道与接线由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: ChatDeps): Record<string, Handler> {
  const hydrator = makeHydrator(deps.port)
  return {
    send: (args: Json, env: CallEnv): Promise<Json> => send(args, env, deps, hydrator),
    history: (args: Json, env: CallEnv): Promise<Json> => history(args, env, deps),
    resume: (args: Json, env: CallEnv): Promise<Json> => resume(args, env, deps, hydrator),
    cancel: (args: Json, env: CallEnv): Promise<Json> => cancel(args, env, deps),
    insert: (args: Json, env: CallEnv): Promise<Json> => insert(args, env, deps),
  }
}

/**
 * 回合运行中插入一条用户消息：按 `turn_id` 落 `session.turn_insert`（仅 open 回合接受）。
 * 落盘为主历史用户消息（消息流可见），并由同回合步日志投影进下一轮模型上下文——
 * 不起新回合，故不触发 `turn_busy`。
 */
async function insert(args: Json, env: CallEnv, deps: ChatDeps): Promise<Json> {
  void env
  const record = isRecord(args) ? args : {}
  const turnId = asString(record['turn_id'])
  const insertId = asString(record['insert_id'])
  const message = isRecord(record['user_message'])
    ? record['user_message']
    : isRecord(record['message'])
      ? record['message']
      : null
  if (turnId === null || insertId === null || message === null) {
    throw new BadArgsError('turn_id / insert_id / user_message required')
  }
  // 只**记待发**（内存），不落步、不渲染：图在轮次边界据此挂起，挂起后 `resume` 提升为 `step.user`
  // 才落盘进流——即「消息进入流之后才落盘」。
  const outcome = await deps.port.call(LOOP_PORT, NOTE_INPUT_METHOD, {
    turn_id: turnId,
    insert_id: insertId,
    user_message: message,
  })
  if (!outcome.ok) return errorValue('session_unavailable', outcome.message)
  if (isErrorValue(outcome.value)) return outcome.value
  return outcome.value
}
