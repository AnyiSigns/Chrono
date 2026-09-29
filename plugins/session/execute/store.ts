// 会话运行记录的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：消息链 / 会话元数据 / 回合事件日志都不进世界。
// 引擎 = 单文件追加日志 `session.jsonl`（每条一次 append + fsync，换行收尾）；启动重放即得全量状态。
//
// 同一追加机制承载两类记录：
//   - 会话轨（`t` = 'msg' | 'conv' | 'current' | 'del' | 'restore' | 'turn'）：会话尾一次写，供 `commit` 用；
//   - 回合事件日志：契约形状的 step record（`type` = 'turn.open' | 'step.intent' | 'step.result' |
//     'checkpoint' | 'turn.settle'），边跑边追加。`turn.open` 在调模型之前写、`step.intent` 在派发有副作用
//     的工具之前写、`turn.settle` 只在开态经 CAS 生效（迟到收口记为 late，不静默丢）。
//
// 回合日志按 `turn_id` 键：消息 id 也按 `turn_id` 拼，续跑同一回合复用同一条用户 / 助手消息，不新开。
// 追加失败先有限次重试；仍失败由调用方 fail-closed——`turn_open` / `step_append` 不落内存（视为未发生），
// `turn_settle` 仍置内存终态以停止后续调用（半份状态由启动收口为 interrupted）。
// 派生物（水位 / 计数）落 ③ `CHRONO_PLUGIN_STATE/index.json`，删掉可由 ④ 重放重建。

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { STEP_RECORD_TYPES, cancelled, interrupted } from './contract/index.ts'
import { displayMessagesByTurn, displayTimeline } from './project.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Rec = { [key: string]: Json }

export interface TurnMark {
  run: string
  conv: string | null
  state: 'open' | 'closed'
}

/** 会话体（消息链外的元数据）；`head.def` = 链头消息 id。 */
export interface ConversationEntry extends Rec {
  id: string
  head: { def: string } | null
  count: number
}

/** 回合事件日志的一条回合：开态 / 终态、步记录、被 CAS 拒绝的迟到收口、取消意图。 */
export interface TurnEntry {
  turn_id: string
  conv: string
  slot_ref: string
  user_message: Rec
  at: string
  state: 'open' | 'settled'
  outcome: Rec | null
  steps: Rec[]
  stepKeys: Set<string>
  late: Rec[]
  /** 取消意图已落盘：重启时仍开着的回合据此收口为 cancelled，而不是仅仅 interrupted。 */
  cancel_requested: boolean
  /** 线程种类（`turn.open` 记录；子代理续跑据此恢复隔离口径）。 */
  thread_kind: string | null
  /** 子代理任务提示词（`turn.open` 记录；续跑不丢失任务）。 */
  task_prompt: string | null
  /** 子代理父检查点（结构化 summary 或裸摘要；`turn.open` 记录）。 */
  parent_checkpoint: Json | null
  /** 子代理父摘要回退（`turn.open` 记录）。 */
  parent_summaries: Json | null
}

/** 在途开回合的预留（已判定可开、尚未落盘）：供同会话互斥判定，避免并发插入两个开态回合。 */
interface ReservedOpen {
  turn_id: string
  slot_ref: string
  conv: string
}

/**
 * `openTurn` 的三态结果（另加落盘失败）：
 * `created` 新开；`already_open` 同一 `turn_id` / `slot_ref` 已有回合（`state` 区分在途与已收口）；
 * `turn_busy` 本会话已有另一个开态回合（不同槽 / 不同回合）；`failed` 追加失败（回合不开始）。
 */
export type OpenTurnResult =
  | { status: 'created'; turn_id: string; conv: string | null }
  | { status: 'already_open'; turn_id: string; conv: string | null; state: 'open' | 'settled'; outcome: Rec | null }
  | { status: 'turn_busy'; turn_id: string; conv: string | null; busy_turn_id: string }
  | { status: 'failed'; turn_id: string; conv: string | null }

/** 内存态（由 ④ 重放得到）；对外只读。 */
export interface SessionState {
  current: string | null
  conversations: Rec[]
  messages: Map<string, Rec[]>
  turns: Map<string, TurnMark>
}

/** 追加行为注入：测试可注入故障 / 快进睡眠；生产用默认实现。 */
export interface SessionStoreOptions {
  append?: (path: string | null, record: Rec) => void
  sleep?: (ms: number) => Promise<void>
}

/** 追加失败的重试节奏（首次立即，其后退避）；覆盖服务短暂重启的退避窗口。 */
export const APPEND_RETRY_DELAYS_MS = [0, 200, 800, 2000]

/** 现有终态种类：只有这三种一旦落定就不再被覆盖（`interrupted` 允许迟到真实收口覆盖）。 */
const TERMINAL_OUTCOME_KINDS = new Set(['committed', 'refused', 'cancelled'])

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(record: Rec, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 收件箱水位单调：`last_seen` 只增不减（重放旧 `conv` 记录也不倒退）。 */
function monotonicInbox(next: Rec, prev: Rec): Rec {
  const prevInbox = isRecord(prev['inbox']) ? prev['inbox'] : null
  const nextInbox = isRecord(next['inbox']) ? next['inbox'] : null
  if (prevInbox === null || nextInbox === null) return next
  const prevSeen = numberField(prevInbox, 'last_seen') ?? 0
  const nextSeen = numberField(nextInbox, 'last_seen') ?? 0
  if (nextSeen >= prevSeen) return next
  return { ...next, inbox: { ...nextInbox, last_seen: prevSeen } }
}

function isTerminalOutcome(outcome: Rec | null): boolean {
  if (outcome === null) return false
  const kind = outcome['kind']
  return typeof kind === 'string' && TERMINAL_OUTCOME_KINDS.has(kind)
}

/**
 * 步记录去重键：`(turn_id, type, seq)`。契约夹具里同一步的 intent / result / checkpoint 共用 seq，
 * 故仅有 `(turn_id, seq)` 会互相误伤；type 参与键才既去重又可共存。
 */
function stepKeyOf(record: Rec, turnId: string): { local: string; reserved: string } | null {
  const type = asStr(record['type'])
  const seq = record['seq']
  if (type === null || typeof seq !== 'number') return null
  const local = `${type}:${seq}`
  return { local, reserved: `${turnId}:${local}` }
}

/** 软删会话：`deleted_at` 非 null。 */
function isDeleted(entry: Rec): boolean {
  return entry['deleted_at'] !== null && entry['deleted_at'] !== undefined
}

/** 追加一条 JSON 记录并 fsync；路径缺失时静默（纯内存降级，仅测试无 ④ 注入时发生）。 */
function appendRecord(path: string | null, record: Rec): void {
  if (path === null) return
  const line = `${JSON.stringify(record)}\n`
  appendFileSync(path, line, 'utf8')
  const fd = openSync(path, 'a')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function replay(path: string): Rec[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const out: Rec[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      // 半写撕裂的末行 / 坏行跳过（fail-open）：已确认前缀照常可用。
    }
  }
  return out
}

/**
 * 会话存储。写口只有本身份：每个变更方法一次 append（边跑边追加），不攒到回合收口。
 * 读口从内存态返回；内存态由 ④ 重放得到，③ 只是派生物（水位），缺失 / 删除不影响正确性。
 */
export class SessionStore {
  private readonly dataFile: string | null
  private readonly stateFile: string | null
  private readonly appendFn: (path: string | null, record: Rec) => void
  private readonly sleepFn: (ms: number) => Promise<void>
  private current: string | null = null
  private conversations: Rec[] = []
  private messages = new Map<string, Rec[]>()
  private turns = new Map<string, TurnMark>()
  private turnLog = new Map<string, TurnEntry>()
  private openTurns = new Set<string>()
  private turnBySlot = new Map<string, string>()
  private reservedOpens = new Map<string, ReservedOpen>()
  private reservedSeqs = new Set<string>()
  private records = 0

  private constructor(
    dataFile: string | null,
    stateFile: string | null,
    options?: SessionStoreOptions,
  ) {
    this.dataFile = dataFile
    this.stateFile = stateFile
    this.appendFn = options?.append ?? appendRecord
    this.sleepFn = options?.sleep ?? defaultSleep
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
    // 启动收口：宿主重启必然连带全部服务重启，故启动时仍开着的回合已死，判为 interrupted。
    this.settleOpenTurns()
    this.writeDerived()
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`，③ 取 `CHRONO_PLUGIN_STATE`。 */
  static open(env: NodeJS.ProcessEnv = process.env, options?: SessionStoreOptions): SessionStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    const stateDir = env['CHRONO_PLUGIN_STATE']
    let dataFile: string | null = null
    let stateFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'session.jsonl')
    }
    if (typeof stateDir === 'string' && stateDir.length > 0) {
      mkdirSync(stateDir, { recursive: true })
      stateFile = join(stateDir, 'index.json')
    }
    return new SessionStore(dataFile, stateFile, options)
  }

  /** ③ 派生物：水位 + 计数；删了可从 ④ 重放重建（不承载真源）。 */
  private writeDerived(): void {
    if (this.stateFile === null) return
    try {
      writeFileSync(
        this.stateFile,
        `${JSON.stringify({ records: this.records, conversations: this.conversations.length })}\n`,
        'utf8',
      )
    } catch {
      // ③ 写失败不影响真源；下次启动重放照常。
    }
  }

  /** 应用一条记录（重放 / 运行期共用同一路径，保证行为一致）。 */
  private apply(record: Rec): void {
    const stepType = record['type']
    if (typeof stepType === 'string' && (STEP_RECORD_TYPES as readonly string[]).includes(stepType)) {
      this.applyStepRecord(record)
      return
    }
    const type = record['t']
    const run = typeof record['run'] === 'string' ? (record['run'] as string) : null
    switch (type) {
      case 'msg': {
        const conv = record['conv']
        const msg = record['msg']
        if (typeof conv !== 'string' || !isRecord(msg) || typeof msg['id'] !== 'string') return
        const list = this.messages.get(conv) ?? []
        if (list.some((item) => item['id'] === msg['id'])) return
        list.push(msg)
        this.messages.set(conv, list)
        return
      }
      case 'conv': {
        const entry = record['entry']
        if (!isRecord(entry)) return
        this.applyConversation(entry)
        return
      }
      case 'current': {
        const id = record['id']
        if (typeof id === 'string' || id === null) this.current = id
        return
      }
      case 'del':
      case 'restore': {
        const conv = record['conv']
        if (typeof conv !== 'string') return
        const index = this.conversations.findIndex((item) => item['id'] === conv)
        if (index < 0) return
        const entry = { ...this.conversations[index] }
        entry['deleted_at'] = type === 'del' ? (record['at'] ?? null) : null
        this.conversations[index] = entry
        return
      }
      case 'turn': {
        if (run === null) return
        const state = record['state'] === 'closed' ? 'closed' : 'open'
        const conv = typeof record['conv'] === 'string' ? (record['conv'] as string) : null
        this.turns.set(run, { run, conv, state })
        return
      }
      case 'cancel': {
        const turnId = asStr(record['turn_id'])
        if (turnId === null) return
        const turn = this.turnLog.get(turnId)
        if (turn !== undefined) turn.cancel_requested = true
        return
      }
      case 'inbox.seen': {
        const conv = record['conv']
        const lastSeen = record['last_seen']
        if (typeof conv !== 'string' || typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) return
        const index = this.conversations.findIndex((item) => item['id'] === conv)
        if (index < 0) return
        const entry = { ...this.conversations[index] }
        const inbox = isRecord(entry['inbox']) ? { ...(entry['inbox'] as Rec) } : {}
        inbox['last_seen'] = Math.max(numberField(inbox, 'last_seen') ?? 0, lastSeen)
        entry['inbox'] = inbox
        this.conversations[index] = entry
        return
      }
      default:
        return
    }
  }

  /** 回合日志记录分发（契约 `type` 判别）。 */
  private applyStepRecord(record: Rec): void {
    const type = record['type']
    if (type === 'turn.open') {
      this.applyTurnOpen(record)
      return
    }
    if (type === 'turn.settle') {
      this.applySettle(record)
      return
    }
    this.applyNonTerminalStep(record)
  }

  private applyConversation(entry: Rec): void {
    if (typeof entry['id'] !== 'string') return
    const id = entry['id']
    const index = this.conversations.findIndex((item) => item['id'] === id)
    if (index >= 0) this.conversations[index] = monotonicInbox(entry, this.conversations[index])
    else this.conversations.push(entry)
  }

  private applyTurnOpen(record: Rec): void {
    const turnId = asStr(record['turn_id'])
    const conv = asStr(record['conv'])
    const slotRef = asStr(record['slot_ref'])
    if (turnId === null || conv === null || slotRef === null) return
    this.reservedOpens.delete(turnId)
    const embedded = record['new_conversation']
    if (isRecord(embedded) && asStr(embedded['id']) !== null) {
      this.applyConversation(embedded)
      // 子代理会话不抢占 `current`（它是旁路线程，不是当前对话）。
      if (asStr(embedded['kind']) !== 'subagent') this.current = embedded['id'] as string
    }
    if (this.turnLog.has(turnId)) {
      return
    }
    const userMessage = isRecord(record['user_message']) ? record['user_message'] : {}
    const at = asStr(record['at']) ?? ''
    this.turnLog.set(turnId, {
      turn_id: turnId,
      conv,
      slot_ref: slotRef,
      user_message: userMessage,
      at,
      state: 'open',
      outcome: null,
      steps: [],
      stepKeys: new Set(),
      late: [],
      cancel_requested: false,
      thread_kind: asStr(record['thread_kind']),
      task_prompt: asStr(record['task_prompt']),
      parent_checkpoint: isRecord(record['parent_checkpoint']) || typeof record['parent_checkpoint'] === 'string'
        ? (record['parent_checkpoint'] as Json)
        : null,
      parent_summaries: Array.isArray(record['parent_summaries']) ? (record['parent_summaries'] as Json) : null,
    })
    this.turnBySlot.set(slotRef, turnId)
    this.openTurns.add(turnId)
    this.appendTurnMessage(conv, 'user', turnId, userMessage, at)
  }

  private applyNonTerminalStep(record: Rec): void {
    const turnId = asStr(record['turn_id'])
    if (turnId === null) return
    const entry = this.turnLog.get(turnId)
    if (entry === undefined || entry.state !== 'open') return
    const key = stepKeyOf(record, turnId)
    if (key !== null) {
      if (entry.stepKeys.has(key.local)) return
      entry.stepKeys.add(key.local)
      this.reservedSeqs.delete(key.reserved)
    }
    entry.steps.push(record)
    if (record['type'] === 'step.result' && isRecord(record['assistant'])) {
      const assistant = record['assistant']
      this.appendTurnMessage(entry.conv, 'assistant', turnId, assistant, asStr(assistant['at']) ?? entry.at)
    }
  }

  /** CAS：终态（committed / refused / cancelled）不再被覆盖；迟到的真实收口覆盖 interrupted。 */
  private applySettle(record: Rec): void {
    const turnId = asStr(record['turn_id'])
    if (turnId === null) return
    const entry = this.turnLog.get(turnId)
    if (entry === undefined) return
    const outcome = isRecord(record['outcome']) ? record['outcome'] : null
    if (outcome === null) return
    if (entry.state === 'settled' && isTerminalOutcome(entry.outcome)) {
      entry.late.push(outcome)
      return
    }
    entry.state = 'settled'
    entry.outcome = outcome
    this.openTurns.delete(turnId)
  }

  /** 按 `turn_id` 拼消息 id：续跑同一回合复用同一条用户 / 助手消息（存在则更新，不新开）。 */
  private appendTurnMessage(
    conv: string,
    role: 'user' | 'assistant',
    turnId: string,
    source: Rec,
    at: string,
  ): void {
    const id = `msg-${conv}-${turnId}-${role}`
    const list = this.messages.get(conv) ?? []
    const index = list.findIndex((item) => item['id'] === id)
    const extra: Rec = {}
    if (Array.isArray(source['parts'])) extra['parts'] = source['parts']
    if (Array.isArray(source['attachments'])) extra['attachments'] = source['attachments']
    if (isRecord(source['meta'])) extra['meta'] = source['meta']
    const content = asStr(source['content']) ?? asStr(source['text']) ?? ''
    if (index >= 0) {
      const prev = list[index]['prev']
      list[index] = { id, role, content, at, prev, ...extra }
      this.messages.set(conv, list)
      return
    }
    const prev = list.length > 0 ? { def: list[list.length - 1]['id'] } : null
    list.push({ id, role, content, at, prev, ...extra })
    this.messages.set(conv, list)
  }

  /** 启动收口：仍开着的回合置 `interrupted{retryable:true}`；已落取消意图的置 `cancelled`。尽力追加 settle 记录。 */
  private settleOpenTurns(): void {
    for (const turnId of [...this.openTurns]) {
      const entry = this.turnLog.get(turnId)
      const outcome = entry?.cancel_requested === true ? cancelled() : interrupted()
      const record: Rec = { type: 'turn.settle', turn_id: turnId, outcome: outcome as unknown as Rec }
      this.persistSync(record)
      this.apply(record)
    }
  }

  /** 同步一次追加（启动收口用；失败不回滚内存终态，重启时会再次收口）。 */
  private persistSync(record: Rec): boolean {
    try {
      this.appendFn(this.dataFile, record)
      this.records += 1
      this.writeDerived()
      return true
    } catch {
      return false
    }
  }

  /** 有限次重试追加；耗尽回 false（调用方 fail-closed）。 */
  private async appendWithRetry(record: Rec): Promise<boolean> {
    for (let attempt = 0; attempt < APPEND_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await this.sleepFn(APPEND_RETRY_DELAYS_MS[attempt])
      try {
        this.appendFn(this.dataFile, record)
        this.records += 1
        this.writeDerived()
        return true
      } catch {
        // 追加失败：退避后重试；耗尽由调用方判断。
      }
    }
    return false
  }

  private commit(record: Rec): void {
    this.appendFn(this.dataFile, record)
    this.records += 1
    this.apply(record)
    this.writeDerived()
  }

  // ── 写口（会话轨，`commit` 用） ─────────────────────────────────────────────

  /** 追加一条消息（同 conv 同 id 幂等）；返回是否新增。 */
  appendMessage(run: string | null, conv: string, msg: Rec): boolean {
    const list = this.messages.get(conv) ?? []
    if (list.some((item) => item['id'] === msg['id'])) return false
    this.commit({ t: 'msg', run, conv, msg })
    return true
  }

  /** 新增 / 替换会话条目。 */
  upsertConversation(run: string | null, entry: Rec): void {
    this.commit({ t: 'conv', run, entry })
  }

  setCurrent(run: string | null, id: string | null): void {
    this.commit({ t: 'current', run, id })
  }

  softDelete(run: string | null, conv: string, at: string): void {
    this.commit({ t: 'del', run, conv, at })
  }

  restore(run: string | null, conv: string): void {
    this.commit({ t: 'restore', run, conv })
  }

  /** 回合开始标记（半份状态可辨：存在 open 且无 closed 即中断残留）。 */
  turnOpen(run: string | null, conv: string | null): void {
    if (run === null) return
    this.commit({ t: 'turn', run, conv, state: 'open' })
  }

  turnClose(run: string | null): void {
    if (run === null) return
    const mark = this.turns.get(run)
    this.commit({ t: 'turn', run, conv: mark?.conv ?? null, state: 'closed' })
  }

  // ── 写口（回合事件日志） ────────────────────────────────────────────────────

  /**
   * 开一个回合：同一 `turn_id` 或同一 `slot_ref` 已有回合即幂等返回既有回合（不追加第二条）；
   * 本会话已有另一个开态回合（不同槽 / 不同回合）则回 `turn_busy`（服务端互斥兜底）。
   * `already_open` 覆盖在途与已收口两种既有回合：重发 / 重启都不新开、不重跑工具。
   * 追加失败不落内存（回合不开始，无模型 / 工具调用）。
   */
  async openTurn(record: Rec): Promise<OpenTurnResult> {
    const turnId = asStr(record['turn_id'])
    const slotRef = asStr(record['slot_ref'])
    const conv = asStr(record['conv'])
    if (turnId === null || slotRef === null) return { status: 'failed', turn_id: turnId ?? '', conv: null }
    const byId = this.turnLog.get(turnId)
    if (byId !== undefined) return this.existingTurn(byId)
    const bySlotId = this.turnBySlot.get(slotRef)
    if (bySlotId !== undefined) {
      const bySlot = this.turnLog.get(bySlotId)
      if (bySlot !== undefined) return this.existingTurn(bySlot)
    }
    const reservedById = this.reservedOpens.get(turnId)
    if (reservedById !== undefined) {
      return { status: 'already_open', turn_id: turnId, conv: reservedById.conv, state: 'open', outcome: null }
    }
    const reserved = this.reservedForSlot(slotRef)
    if (reserved !== null) {
      return { status: 'already_open', turn_id: reserved.turn_id, conv: reserved.conv, state: 'open', outcome: null }
    }
    const busyTurnId = this.busyTurnFor(conv, turnId, slotRef)
    if (busyTurnId !== null) {
      return { status: 'turn_busy', turn_id: turnId, conv, busy_turn_id: busyTurnId }
    }
    this.reservedOpens.set(turnId, { turn_id: turnId, slot_ref: slotRef, conv: conv ?? '' })
    const persisted = await this.appendWithRetry(record)
    if (!persisted) {
      this.reservedOpens.delete(turnId)
      return { status: 'failed', turn_id: turnId, conv: null }
    }
    this.apply(record)
    const entry = this.turnLog.get(turnId)
    return { status: 'created', turn_id: turnId, conv: entry?.conv ?? conv }
  }

  /** 既有回合 → `already_open`；已收口者带出结局供调用方回执，不重跑。 */
  private existingTurn(entry: TurnEntry): OpenTurnResult {
    return {
      status: 'already_open',
      turn_id: entry.turn_id,
      conv: entry.conv,
      state: entry.state,
      outcome: entry.state === 'settled' ? entry.outcome : null,
    }
  }

  /** 在途预留里命中同槽的回合（尚未落盘，顾不到 `turnLog`）。 */
  private reservedForSlot(slotRef: string): ReservedOpen | null {
    for (const open of this.reservedOpens.values()) {
      if (open.slot_ref === slotRef) return open
    }
    return null
  }

  /** 本会话是否有另一个开态回合（已落盘或已预留）：命中即回其 `turn_id`。 */
  private busyTurnFor(conv: string | null, turnId: string, slotRef: string): string | null {
    if (conv === null) return null
    for (const id of this.openTurns) {
      if (id === turnId) continue
      const entry = this.turnLog.get(id)
      if (entry === undefined) continue
      if (entry.conv !== conv || entry.slot_ref === slotRef) continue
      return id
    }
    for (const open of this.reservedOpens.values()) {
      if (open.turn_id === turnId) continue
      if (open.conv !== conv || open.slot_ref === slotRef) continue
      return open.turn_id
    }
    return null
  }

  /**
   * 追加一条步记录（intent / result / checkpoint）：按 `(turn_id, seq)` 去重。
   * 追加失败不落内存（该步视为未发生）；调用方据此收口。
   */
  async appendStep(record: Rec): Promise<'appended' | 'exists' | 'not_found' | 'not_open' | 'failed'> {
    const turnId = asStr(record['turn_id'])
    if (turnId === null) return 'not_found'
    const entry = this.turnLog.get(turnId)
    if (entry === undefined) return 'not_found'
    if (entry.state !== 'open') return 'not_open'
    const key = stepKeyOf(record, turnId)
    if (key !== null) {
      if (entry.stepKeys.has(key.local)) return 'exists'
      if (this.reservedSeqs.has(key.reserved)) return 'exists'
      this.reservedSeqs.add(key.reserved)
    }
    const persisted = await this.appendWithRetry(record)
    if (!persisted) {
      if (key !== null) this.reservedSeqs.delete(key.reserved)
      return 'failed'
    }
    this.apply(record)
    return 'appended'
  }

  /**
   * 回合运行中插入一条用户消息（`step.user`）：仅 open 态接受，按 `insert_id` 幂等。
   * 步号取当前最大步号 + 1（`restoreFromSteps` 据此推进后续 seq，不与模型步撞车）；
   * 本回合的消息投影据此在原位落一条用户消息——既进下一轮模型上下文，又进消息流。
   */
  async insertUserMessage(
    turnId: string,
    insertId: string,
    message: Rec,
  ): Promise<{ status: 'inserted' | 'exists' | 'not_found' | 'not_open' | 'failed'; seq: number | null }> {
    const entry = this.turnLog.get(turnId)
    if (entry === undefined) return { status: 'not_found', seq: null }
    if (entry.state !== 'open') return { status: 'not_open', seq: null }
    if (entry.steps.some((step) => step['type'] === 'step.user' && step['insert_id'] === insertId)) {
      return { status: 'exists', seq: null }
    }
    let maxSeq = 0
    for (const step of entry.steps) {
      const seq = numberField(step, 'seq')
      if (seq !== null && seq > maxSeq) maxSeq = seq
    }
    const seq = maxSeq + 1
    const record: Rec = { type: 'step.user', turn_id: turnId, seq, insert_id: insertId, user_message: message }
    const persisted = await this.appendWithRetry(record)
    if (!persisted) return { status: 'failed', seq: null }
    this.apply(record)
    return { status: 'inserted', seq }
  }

  /** 回合所属会话 id（无该回合回 null）。 */
  conversationOfTurn(turnId: string): string | null {
    return this.turnLog.get(turnId)?.conv ?? null
  }

  /**
   * CAS 收口：开态 / interrupted 允许落定，终态拒绝并记迟到。同步判定胜者，再尽力追加。
   * 追加失败不回滚内存终态（停止后续调用；重启时按 open 收口为 interrupted）。
   */
  async settle(
    turnId: string,
    outcome: Rec,
  ): Promise<{ status: 'settled' | 'late' | 'unknown'; persisted: boolean }> {
    const entry = this.turnLog.get(turnId)
    if (entry === undefined) return { status: 'unknown', persisted: false }
    const record: Rec = { type: 'turn.settle', turn_id: turnId, outcome }
    if (entry.state === 'settled' && isTerminalOutcome(entry.outcome)) {
      entry.late.push(outcome)
      const persisted = await this.appendWithRetry(record)
      return { status: 'late', persisted }
    }
    entry.state = 'settled'
    entry.outcome = outcome
    this.openTurns.delete(turnId)
    const persisted = await this.appendWithRetry(record)
    return { status: 'settled', persisted }
  }

  /**
   * 记录取消意图（不落终态；终态仍由 `settle` 的 CAS 落定）。
   * 结局已定 / 回合未知时不追加；意图已存在时幂等返回，不重复追加。追加失败回 failed，调用方按尽力上报。
   */
  async cancelTurn(
    turnId: string,
  ): Promise<{ status: 'recorded' | 'settled' | 'unknown' | 'failed'; outcome: Rec | null; conv: string | null }> {
    const entry = this.turnLog.get(turnId)
    if (entry === undefined) return { status: 'unknown', outcome: null, conv: null }
    if (entry.state === 'settled') return { status: 'settled', outcome: entry.outcome, conv: entry.conv }
    if (entry.cancel_requested) return { status: 'recorded', outcome: null, conv: entry.conv }
    const record: Rec = { t: 'cancel', turn_id: turnId }
    const persisted = await this.appendWithRetry(record)
    if (!persisted) return { status: 'failed', outcome: null, conv: entry.conv }
    this.apply(record)
    return { status: 'recorded', outcome: null, conv: entry.conv }
  }

  /**
   * 收件箱已读水位单调推进：追加 `inbox.seen` 记录，`last_seen = max(current, seq)`。
   * `seq <= current` 幂等 no-op（不追加记录）；会话未知回 `not_found`；追加失败回 `failed`（不落内存）。
   * 只增不减：即使重放乱序 / 旧 `conv` 记录回写，`applyConversation` / `apply` 都以 max 守卫。
   */
  async ackInbox(
    run: string | null,
    conv: string,
    seq: number,
  ): Promise<'applied' | 'unchanged' | 'not_found' | 'failed'> {
    const index = this.conversations.findIndex((item) => item['id'] === conv)
    if (index < 0) return 'not_found'
    const current = numberField(
      isRecord(this.conversations[index]['inbox']) ? (this.conversations[index]['inbox'] as Rec) : {},
      'last_seen',
    ) ?? 0
    if (seq <= current) return 'unchanged'
    const record: Rec = { t: 'inbox.seen', run, conv, last_seen: Math.max(current, seq) }
    const persisted = await this.appendWithRetry(record)
    if (!persisted) return 'failed'
    this.apply(record)
    return 'applied'
  }

  // ── 读口 ────────────────────────────────────────────────────────────────

  body(): Rec {
    return {
      version: 1,
      current: this.current,
      conversations: this.conversations.map((entry) => this.entryWithHead(entry)),
    }
  }

  /** 会话切片：body + 顶层 head（链头消息 id）+ refs（消息 id → body）+ 本会话回合 + data_gen=null。 */
  slice(convId: string | null): Rec {
    const body = this.body()
    const conversation = this.pick(convId)
    const refs: Rec = {}
    if (conversation !== null) {
      for (const msg of this.messages.get(conversation['id'] as string) ?? []) {
        refs[msg['id'] as string] = msg
      }
    }
    return {
      ...body,
      head: conversation !== null ? headId(conversation) : null,
      refs,
      turns: conversation !== null ? this.turnsFor(conversation['id'] as string) : [],
      inbox_unread: conversation !== null ? this.unreadInbox(conversation['id'] as string) : [],
      data_gen: null,
    }
  }

  /**
   * 未读收件箱投影：`${conv}#inbox` 里 `seq > last_seen` 的条目，按 `seq` 升序（确定性）。
   * 只读：不回写、不推进水位（推进由 `ackInbox` 另行追加记录）。
   */
  unreadInbox(convId: string): Rec[] {
    const conversation = this.conversations.find((item) => item['id'] === convId)
    if (conversation === undefined) return []
    const inbox = isRecord(conversation['inbox']) ? (conversation['inbox'] as Rec) : {}
    const lastSeen = numberField(inbox, 'last_seen') ?? 0
    const out: Rec[] = []
    for (const msg of this.messages.get(`${convId}#inbox`) ?? []) {
      const seq = msg['seq']
      if (typeof seq !== 'number' || seq <= lastSeen) continue
      out.push({ seq, from: msg['from'] ?? null, kind: msg['kind'] ?? null, body: msg['body'] ?? null, at: msg['at'] ?? null })
    }
    out.sort((left, right) => (left['seq'] as number) - (right['seq'] as number))
    return out
  }

  /**
   * 展示历史：由展示投影（回合日志）重建，按回合窗分页。
   * `before` 定位既有消息所属回合（该回合不含），`limit` 为回合数；`messages` 新 → 旧。
   */
  history(convId: string | null, before: string | null, limit: number | null): Rec {
    const conversation = this.pick(convId)
    const refs: Rec = {}
    const conversationId = conversation !== null ? (conversation['id'] as string) : null
    if (conversationId !== null) {
      for (const msg of this.messages.get(conversationId) ?? []) refs[msg['id'] as string] = msg
    }
    const turns = conversationId === null ? [] : this.turnsFor(conversationId)
    const groups = conversationId === null ? [] : displayMessagesByTurn(conversationId, turns)
    let end = groups.length
    if (before !== null) {
      const index = groups.findIndex((group) =>
        group.messages.some((entry) => entry.hash === before || (isRecord(entry.def) && entry.def['id'] === before)),
      )
      if (index >= 0) end = index
    }
    const start = limit !== null ? Math.max(0, end - limit) : 0
    const selected = groups.slice(start, end)
    const window: Rec[] = []
    for (const group of selected) window.push(...group.messages)
    window.reverse()
    const oldest = selected.length > 0 && selected[0] !== undefined && selected[0].messages.length > 0
      ? selected[0].messages[0]?.hash ?? null
      : null
    return {
      conversation: conversationId,
      before,
      limit,
      messages: window,
      next_before: start > 0 ? oldest : null,
      turns,
      body: this.body(),
      refs,
      display: displayTimeline(turns) as unknown as Json,
    }
  }

  /** 未闭合回合（旧轨 `turn` 标记，半份提交残留）的回合 id 列表。 */
  pendingTurns(): string[] {
    const out: string[] = []
    for (const mark of this.turns.values()) if (mark.state === 'open') out.push(mark.run)
    return out
  }

  /** 回合日志里仍开着的回合 id（O(open 回合)；启动收口后为空）。 */
  openTurnIds(): string[] {
    return [...this.openTurns]
  }

  /** 仍开着的回合摘要（跨会话，供角标读）。 */
  openTurnSummaries(): Rec[] {
    const out: Rec[] = []
    for (const turnId of this.openTurns) {
      const entry = this.turnLog.get(turnId)
      if (entry !== undefined) out.push({ turn_id: entry.turn_id, conv: entry.conv })
    }
    return out
  }

  /** 一条回合的对外视图（含步记录与被拒的迟到收口）。 */
  turn(turnId: string): Rec | null {
    const entry = this.turnLog.get(turnId)
    return entry === undefined ? null : this.turnView(entry)
  }

  /** 某一会话的全部回合视图（按发生序）。 */
  turnsFor(convId: string): Rec[] {
    const out: Rec[] = []
    for (const entry of this.turnLog.values()) {
      if (entry.conv === convId) out.push(this.turnView(entry))
    }
    return out
  }

  private turnView(entry: TurnEntry): Rec {
    return {
      turn_id: entry.turn_id,
      conv: entry.conv,
      slot_ref: entry.slot_ref,
      at: entry.at,
      state: entry.state,
      outcome: entry.outcome,
      cancel_requested: entry.cancel_requested,
      late_settles: entry.late,
      user_message: entry.user_message,
      steps: entry.steps,
      ...(entry.thread_kind !== null ? { thread_kind: entry.thread_kind } : {}),
      ...(entry.task_prompt !== null ? { task_prompt: entry.task_prompt } : {}),
      ...(entry.parent_checkpoint !== null ? { parent_checkpoint: entry.parent_checkpoint } : {}),
      ...(entry.parent_summaries !== null ? { parent_summaries: entry.parent_summaries } : {}),
    }
  }

  conversation(convId: string | null): Rec | null {
    return this.pick(convId)
  }

  messagesOf(convId: string): Rec[] {
    return this.messages.get(convId) ?? []
  }

  currentId(): string | null {
    return this.current
  }

  private entryWithHead(entry: Rec): Rec {
    const list = this.messages.get(entry['id'] as string) ?? []
    const last = list.length > 0 ? list[list.length - 1] : null
    return {
      ...entry,
      head: last !== null ? { def: last['id'] } : null,
      count: list.length,
      updated_at: last !== null ? (last['at'] ?? null) : null,
    }
  }

  /**
   * 选会话：显式 id 命中即取（含软删，供显式历史 / 校验）；否则取 `current`（仅未软删）。
   * 无 `current` / `current` 指向已删 → null（回空态），**不再回落列表首条**——否则「删到无当前
   * 会话」会把首条（甚至已删）会话当成当前渲染。
   */
  private pick(convId: string | null): Rec | null {
    const list = this.conversations
    if (convId !== null) {
      const found = list.find((item) => item['id'] === convId)
      if (found !== undefined) return this.entryWithHead(found)
    }
    if (this.current !== null) {
      const found = list.find((item) => item['id'] === this.current)
      if (found !== undefined && !isDeleted(found)) return this.entryWithHead(found)
    }
    return null
  }
}

export function headId(conversation: Rec | null): string | null {
  if (conversation === null) return null
  const list = conversation['head']
  if (!isRecord(list)) return null
  const def = list['def']
  return typeof def === 'string' ? def : null
}
