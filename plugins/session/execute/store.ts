// 会话运行记录的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：消息链 / 会话元数据 / 回合事件日志都不进世界。
// 引擎 = 小索引 + 每会话一份日志：
//   - `index.jsonl`：会话轨（conv / current / del / restore / turn / inbox.seen）+ 跨会话开着的回合摘要
//     与「回合 → 会话」路由；启动只重放索引即得全量会话清单与 `open_turns`。
//   - `conversations/<convId>/log.jsonl`：该会话的消息（`msg`，含其 `<convId>#inbox` 条目）与回合事件
//     日志（`turn.open` / `step.*` / `checkpoint` / `turn.settle` / `cancel`）。按会话惰性加载：
//     打开某会话才读它的日志，`turnsFor` 只与本会话相关，启动不读任何会话日志。
// 每会话日志超阈值（条数 / 字节）时写一条快照记录替代被覆盖的前缀，快照保留读契约所需的装配
// （消息列表 + 回合条目含步记录、取消意图与迟到收口），`history` / `read` / 上下文回灌所见不变。
// 旧单文件 `session.jsonl` 由幂等迁移转换（保留不删，仅不再被读）。
// 每条记录一次 open + 整段写入（换行收尾）；fsync 按累计字节批量做，只在回合收口 / 关键轨记录同步落盘。
// 追加失败先有限次重试；仍失败由调用方 fail-closed。派生物（水位 / 计数）落 ③
// `CHRONO_PLUGIN_STATE/index.json`，删掉可由 ④ 重放重建。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { STEP_RECORD_TYPES, cancelled, interrupted } from './contract/index.ts'
import { displayMessagesByTurn } from './project.ts'

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
  /** 每会话日志压实阈值（条数）：达到即写快照替代被覆盖前缀。 */
  compactRecords?: number
  /** 每会话日志压实阈值（字节）：与条数任一达到即压实。 */
  compactBytes?: number
}

/** 追加失败的重试节奏（首次立即，其后退避）；覆盖服务短暂重启的退避窗口。 */
export const APPEND_RETRY_DELAYS_MS = [0, 200, 800, 2000]

/** 现有终态种类：只有这三种一旦落定就不再被覆盖（`interrupted` 允许迟到真实收口覆盖）。 */
const TERMINAL_OUTCOME_KINDS = new Set(['committed', 'refused', 'cancelled'])

/** 索引文件名（会话轨：清单 / 当前选择 / 软删 / 收件箱水位 / 开着的回合摘要）。 */
const INDEX_FILE = 'index.jsonl'
/** 每会话日志目录名。 */
const CONVERSATIONS_DIR = 'conversations'
/** 每会话日志文件名。 */
const CONVERSATION_LOG_FILE = 'log.jsonl'
/** 旧单文件布局；迁移后保留不删，仅不再被读。 */
const LEGACY_FILE = 'session.jsonl'
/** 迁移完成标记：存在即不再迁移（幂等）。 */
const MIGRATION_MARKER = 'migrated'
/** 收件箱记录以 `${convId}#inbox` 为消息键，其目录取基会话 id。 */
const INBOX_SUFFIX = '#inbox'

/** 默认压实阈值：条数 / 字节任一达到即压实。 */
const DEFAULT_COMPACT_RECORDS = 1024
const DEFAULT_COMPACT_BYTES = 512 * 1024

/** Windows 保留设备名（含扩展名形式按主干判定）：禁止作为单段目录名。 */
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])
/** JS 原型键：即使目录名无害也拒绝，避免把会话 id 当对象键时的原型污染面。 */
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
/** Windows / 控制字符非法面：`< > : " / \ | ? *` 与 C0 控制字符、DEL。 */
const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/

/**
 * 会话 id 是否可安全用作单段目录名：拒绝空、`.` / `..`、路径分隔符、盘符 / Windows 非法字符、
 * 控制字符、结尾点 / 空格、保留设备名与 JS 原型键。写路径前据它 fail-closed，绝不路径穿越。
 */
export function isSafeConversationId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false
  if (id === '.' || id === '..') return false
  if (ILLEGAL_PATH_CHARS.test(id)) return false
  if (id.endsWith('.') || id.endsWith(' ')) return false
  if (PROTOTYPE_KEYS.has(id)) return false
  const stem = id.toLowerCase().split('.')[0]
  if (RESERVED_DEVICE_NAMES.has(stem)) return false
  return true
}

/** 消息键 → 目录基会话 id：`${convId}#inbox` 的条目归其所属会话目录。 */
function baseConversationId(conv: string): string {
  return conv.endsWith(INBOX_SUFFIX) ? conv.slice(0, -INBOX_SUFFIX.length) : conv
}

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

/** 批量 fsync 的累计字节阈值：达到即同步一次；关键轨 / 半写风险窗口另显式同步。 */
const FSYNC_BYTES = 256 * 1024
/** 每数据文件自上次 fsync 起的累计字节（单写者：每路径一个写口）。 */
const pendingFsyncBytes = new Map<string, number>()

/**
 * 关键轨 / 半写风险窗口的记录同步落盘：会话轨（`t` 记录）、回合头、步意图、回合收口。
 * 步意图先于有副作用的工具派发，丢了会在续跑时重发；会话轨是 `commit` 的唯一真源。
 */
function needsSync(record: Rec): boolean {
  if (typeof record['t'] === 'string') return true
  const type = record['type']
  return type === 'turn.open' || type === 'turn.settle' || type === 'step.intent'
}

/** 写满整段：`writeSync` 可能短写，逐段续写直到写完；零进展（返回 <= 0）即抛，与宿主同口径。 */
function writeAllSync(fd: number, line: string): void {
  const buffer = Buffer.from(line, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error('short_write')
    offset += written
  }
}

/** 追加一条 JSON 记录；路径缺失时静默（纯内存降级，仅测试无 ④ 注入时发生）。 */
function appendRecord(path: string | null, record: Rec): void {
  if (path === null) return
  const line = `${JSON.stringify(record)}\n`
  const bytes = Buffer.byteLength(line, 'utf8')
  const fd = openSync(path, 'a')
  try {
    writeAllSync(fd, line)
    const pending = (pendingFsyncBytes.get(path) ?? 0) + bytes
    if (needsSync(record) || pending >= FSYNC_BYTES) {
      fsyncSync(fd)
      pendingFsyncBytes.delete(path)
    } else {
      pendingFsyncBytes.set(path, pending)
    }
  } finally {
    closeSync(fd)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 有容错重放：逐行解析，带换行的坏行跳过（fail-open）。
 * 末段无换行且解析失败视为半写撕裂尾：截到有效前缀（含末条完整行的换行），
 * 令后续追加不会与新记录粘连；缺文件视为空。迁移读旧文件时禁截断（不得改动旧真源）。
 */
function replay(path: string, truncate = true): Rec[] {
  if (!existsSync(path)) return []
  const bytes = readFileSync(path)
  const out: Rec[] = []
  let validBytes = 0
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const lineEnd = newline === -1 ? bytes.length : newline + 1
    const line = bytes.subarray(start, newline === -1 ? bytes.length : newline).toString('utf8')
    if (line.length === 0) {
      validBytes = lineEnd
      start = lineEnd
      continue
    }
    try {
      const parsed = JSON.parse(line)
      if (isRecord(parsed)) out.push(parsed)
      validBytes = lineEnd
    } catch {
      // 半写撕裂的末行（无换行）丢弃并截断；中间坏行跳过、推进有效前缀。
      if (newline === -1) break
      validBytes = lineEnd
    }
    start = lineEnd
  }
  if (truncate && validBytes < bytes.length) truncateSync(path, validBytes)
  return out
}

/** 原子整份重写：写临时文件再替换目标（Windows 替换失败时先删目标再改名）。 */
function writeFileAtomicSync(path: string, content: string): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, content, 'utf8')
  try {
    renameSync(temp, path)
    return
  } catch {
    // 目标存在时 Windows 改名失败：删目标后重试（单写者，窗口极小）。
  }
  try {
    unlinkSync(path)
  } catch {
    // 目标本就不存在：直接重试改名。
  }
  try {
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // 清理临时文件失败不改变原错误。
    }
    throw err
  }
}

/** 回合条目 → 可持久化快照形状（`Set` 拆成数组）。 */
function serializeTurn(entry: TurnEntry): Rec {
  return {
    turn_id: entry.turn_id,
    conv: entry.conv,
    slot_ref: entry.slot_ref,
    user_message: entry.user_message,
    at: entry.at,
    state: entry.state,
    outcome: entry.outcome,
    steps: entry.steps as unknown as Json,
    step_keys: [...entry.stepKeys] as unknown as Json,
    late: entry.late as unknown as Json,
    cancel_requested: entry.cancel_requested,
    thread_kind: entry.thread_kind,
    task_prompt: entry.task_prompt,
    parent_checkpoint: entry.parent_checkpoint,
    parent_summaries: entry.parent_summaries,
  }
}

/**
 * 会话存储。写口只有本身份：每个变更方法一次追加（边跑边追加），不攒到回合收口。
 * 读口从内存态返回；会话轨（索引）启动即重放，会话日志按需惰性加载；③ 只是派生物（水位）。
 */
export class SessionStore {
  private readonly dataDir: string | null
  private readonly indexFile: string | null
  private readonly stateFile: string | null
  private readonly appendFn: (path: string | null, record: Rec) => void
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly compactRecords: number
  private readonly compactBytes: number
  private current: string | null = null
  private conversations: Rec[] = []
  private messages = new Map<string, Rec[]>()
  /** 每条会话消息 id → 在消息列表中的下标：重放去重与回合消息 upsert 都 O(1)（免 O(n²) 扫描）。 */
  private messagePositions = new Map<string, Map<string, number>>()
  private turns = new Map<string, TurnMark>()
  /** 已加载会话目录集合：只有它们（及正在加载的）才在内存里。 */
  private loadedConvs = new Set<string>()
  /** 每目录自上次压实起的记录条数 / 字节数（只对已加载会话维护）。 */
  private logRecords = new Map<string, number>()
  private logBytes = new Map<string, number>()
  /** 已创建过的会话目录：免每次追加都 mkdir。 */
  private dirsMade = new Set<string>()
  /** 回合 → 会话路由（索引 open/close 摘要维护；O(#回合) 但只存字符串，不背步记录）。 */
  private turnConv = new Map<string, string>()
  /** 已加载会话的回合条目（按发生序）。 */
  private turnLogByConv = new Map<string, TurnEntry[]>()
  /** 回合 id → 条目（只含已加载会话），供按 id 取用。 */
  private turnLogById = new Map<string, TurnEntry>()
  private openTurns = new Set<string>()
  private turnBySlot = new Map<string, string>()
  private reservedOpens = new Map<string, ReservedOpen>()
  private reservedSeqs = new Set<string>()
  private records = 0

  private constructor(
    dataDir: string | null,
    stateFile: string | null,
    options?: SessionStoreOptions,
  ) {
    this.dataDir = dataDir
    this.stateFile = stateFile
    this.appendFn = options?.append ?? appendRecord
    this.sleepFn = options?.sleep ?? defaultSleep
    this.compactRecords = options?.compactRecords ?? DEFAULT_COMPACT_RECORDS
    this.compactBytes = options?.compactBytes ?? DEFAULT_COMPACT_BYTES
    this.indexFile = dataDir !== null ? join(dataDir, INDEX_FILE) : null
    if (dataDir !== null) {
      const legacyFile = join(dataDir, LEGACY_FILE)
      const markerFile = join(dataDir, MIGRATION_MARKER)
      if (!existsSync(markerFile) && existsSync(legacyFile)) {
        migrateLegacy(legacyFile, dataDir)
      }
      if (this.indexFile !== null && existsSync(this.indexFile)) {
        for (const record of replay(this.indexFile)) this.apply(record)
      }
    }
    // 启动收口：宿主重启必然连带全部服务重启，故启动时仍开着的回合已死，判为 interrupted。
    this.settleOpenTurns()
    this.writeDerived()
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`，③ 取 `CHRONO_PLUGIN_STATE`。 */
  static open(env: NodeJS.ProcessEnv = process.env, options?: SessionStoreOptions): SessionStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    const stateDir = env['CHRONO_PLUGIN_STATE']
    let base: string | null = null
    let stateFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      base = dataDir
    }
    if (typeof stateDir === 'string' && stateDir.length > 0) {
      mkdirSync(stateDir, { recursive: true })
      stateFile = join(stateDir, 'index.json')
    }
    return new SessionStore(base, stateFile, options)
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

  // ── 路径与惰性加载 ────────────────────────────────────────────────────────

  /** 会话目录基 id；不安全（可能路径穿越）即抛，写路径一律 fail-closed。 */
  private requireBase(conv: string): string {
    const base = baseConversationId(conv)
    if (!isSafeConversationId(base)) throw new Error(`unsafe_conversation_id: ${conv}`)
    return base
  }

  /** 会话日志路径（按需建目录）。 */
  private conversationLogPath(base: string): string {
    if (this.dataDir === null) throw new Error('no_data_dir')
    const dir = join(this.dataDir, CONVERSATIONS_DIR, base)
    if (!this.dirsMade.has(dir)) {
      mkdirSync(dir, { recursive: true })
      this.dirsMade.add(dir)
    }
    return join(dir, CONVERSATION_LOG_FILE)
  }

  /** 按会话惰性加载：首次访问才读该会话日志；不安全 id 不触盘（拒绝穿越）。 */
  private ensureLoaded(conv: string | null): void {
    if (conv === null || this.dataDir === null || this.indexFile === null) return
    const base = baseConversationId(conv)
    if (this.loadedConvs.has(base)) return
    if (!isSafeConversationId(base)) return
    this.loadedConvs.add(base)
    const path = join(this.dataDir, CONVERSATIONS_DIR, base, CONVERSATION_LOG_FILE)
    if (!existsSync(path)) return
    const records = replay(path)
    for (const record of records) this.apply(record)
    this.logRecords.set(base, records.length)
    try {
      this.logBytes.set(base, statSync(path).size)
    } catch {
      this.logBytes.set(base, 0)
    }
  }

  /** 已加载会话 id（测试 / 诊断用）：启动后应为空，直到访问某会话。 */
  loadedConversationIds(): string[] {
    return [...this.loadedConvs]
  }

  // ── 应用记录（重放 / 运行期共用同一路径） ─────────────────────────────────

  /** 应用一条记录（重放 / 运行期共用同一路径，保证行为一致）。 */
  private apply(record: Rec): void {
    if (record['t'] === 'snapshot') {
      this.applySnapshot(record)
      return
    }
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
        if (typeof conv !== 'string' || !isRecord(msg)) return
        this.applyMessage(conv, msg)
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
        const turn = this.turnLogById.get(turnId)
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
      case 'open_turn': {
        const turnId = asStr(record['turn_id'])
        const conv = asStr(record['conv'])
        if (turnId !== null && conv !== null) {
          this.openTurns.add(turnId)
          this.turnConv.set(turnId, conv)
        }
        return
      }
      case 'close_turn': {
        const turnId = asStr(record['turn_id'])
        if (turnId !== null) this.openTurns.delete(turnId)
        return
      }
      default:
        return
    }
  }

  /** 一条会话消息：按 `(conv, id)` 幂等（重放 / 快照共用）。 */
  private applyMessage(conv: string, msg: Rec): void {
    if (typeof msg['id'] !== 'string') return
    const positions = this.positionsOf(conv)
    if (positions.has(msg['id'])) return
    const list = this.messages.get(conv) ?? []
    positions.set(msg['id'], list.length)
    list.push(msg)
    this.messages.set(conv, list)
  }

  /** 快照记录：装配结果整体替换被覆盖前缀（消息 + 回合条目含步记录）。 */
  private applySnapshot(record: Rec): void {
    const conv = asStr(record['conv'])
    if (conv === null) return
    this.loadedConvs.add(conv)
    const groups = record['messages']
    if (Array.isArray(groups)) {
      for (const raw of groups) {
        if (!isRecord(raw)) continue
        const key = asStr(raw['conv'])
        const list = raw['messages']
        if (key === null || !Array.isArray(list)) continue
        for (const msg of list) if (isRecord(msg)) this.applyMessage(key, msg)
      }
    }
    const turns = record['turns']
    if (Array.isArray(turns)) {
      for (const raw of turns) if (isRecord(raw)) this.applySnapshotTurn(raw)
    }
  }

  private applySnapshotTurn(raw: Rec): void {
    const turnId = asStr(raw['turn_id'])
    const conv = asStr(raw['conv'])
    if (turnId === null || conv === null) return
    if (this.turnLogById.has(turnId)) return
    const stepKeys = Array.isArray(raw['step_keys'])
      ? raw['step_keys'].filter((value): value is string => typeof value === 'string')
      : []
    const steps = Array.isArray(raw['steps']) ? (raw['steps'] as Json[]).filter(isRecord) : []
    const late = Array.isArray(raw['late']) ? (raw['late'] as Json[]).filter(isRecord) : []
    const entry: TurnEntry = {
      turn_id: turnId,
      conv,
      slot_ref: asStr(raw['slot_ref']) ?? '',
      user_message: isRecord(raw['user_message']) ? (raw['user_message'] as Rec) : {},
      at: asStr(raw['at']) ?? '',
      state: raw['state'] === 'settled' ? 'settled' : 'open',
      outcome: isRecord(raw['outcome']) ? (raw['outcome'] as Rec) : null,
      steps,
      stepKeys: new Set(stepKeys),
      late,
      cancel_requested: raw['cancel_requested'] === true,
      thread_kind: asStr(raw['thread_kind']),
      task_prompt: asStr(raw['task_prompt']),
      parent_checkpoint:
        isRecord(raw['parent_checkpoint']) || typeof raw['parent_checkpoint'] === 'string'
          ? (raw['parent_checkpoint'] as Json)
          : null,
      parent_summaries: Array.isArray(raw['parent_summaries']) ? (raw['parent_summaries'] as Json) : null,
    }
    this.installTurn(entry)
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

  /** 安装一条回合条目（内存桶 + id 路由 + 槽索引 + 开态集合）。 */
  private installTurn(entry: TurnEntry): void {
    this.turnLogById.set(entry.turn_id, entry)
    const list = this.turnLogByConv.get(entry.conv) ?? []
    list.push(entry)
    this.turnLogByConv.set(entry.conv, list)
    this.turnBySlot.set(entry.slot_ref, entry.turn_id)
    this.turnConv.set(entry.turn_id, entry.conv)
    if (entry.state === 'open') this.openTurns.add(entry.turn_id)
    else this.openTurns.delete(entry.turn_id)
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
    if (this.turnLogById.has(turnId)) return
    const userMessage = isRecord(record['user_message']) ? (record['user_message'] as Rec) : {}
    const at = asStr(record['at']) ?? ''
    this.installTurn({
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
    this.appendTurnMessage(conv, 'user', turnId, userMessage, at)
  }

  private applyNonTerminalStep(record: Rec): void {
    const turnId = asStr(record['turn_id'])
    if (turnId === null) return
    const entry = this.turnLogById.get(turnId)
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
    const entry = this.turnLogById.get(turnId)
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

  /** 会话消息 id → 下标索引（按需建）；重放去重与回合消息 upsert 都据它 O(1)。 */
  private positionsOf(conv: string): Map<string, number> {
    let positions = this.messagePositions.get(conv)
    if (positions === undefined) {
      positions = new Map()
      this.messagePositions.set(conv, positions)
    }
    return positions
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
    const positions = this.positionsOf(conv)
    const index = positions.get(id)
    const extra: Rec = {}
    if (Array.isArray(source['parts'])) extra['parts'] = source['parts']
    if (Array.isArray(source['attachments'])) extra['attachments'] = source['attachments']
    if (isRecord(source['meta'])) extra['meta'] = source['meta']
    const content = asStr(source['content']) ?? asStr(source['text']) ?? ''
    if (index !== undefined) {
      const prev = list[index]['prev']
      list[index] = { id, role, content, at, prev, ...extra }
      this.messages.set(conv, list)
      return
    }
    const prev = list.length > 0 ? { def: list[list.length - 1]['id'] } : null
    positions.set(id, list.length)
    list.push({ id, role, content, at, prev, ...extra })
    this.messages.set(conv, list)
  }

  // ── 追加与压实 ────────────────────────────────────────────────────────────

  /** 追加一条索引记录（同步；写不进即抛，调用方 fail-closed）。 */
  private commit(record: Rec): void {
    if (this.indexFile !== null) this.appendFn(this.indexFile, record)
    this.records += 1
    this.apply(record)
    this.writeDerived()
  }

  /** 追加一条索引记录（有限次重试）；写不进回 false。 */
  private async commitIndexWithRetry(record: Rec): Promise<boolean> {
    for (let attempt = 0; attempt < APPEND_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await this.sleepFn(APPEND_RETRY_DELAYS_MS[attempt])
      try {
        this.commit(record)
        return true
      } catch {
        // 追加失败：退避后重试；耗尽由调用方判断。
      }
    }
    return false
  }

  /** 追加一条会话日志记录（同步；写不进即抛）。 */
  private appendConversation(conv: string, record: Rec): void {
    const base = this.requireBase(conv)
    const path = this.conversationLogPath(base)
    this.appendFn(path, record)
    this.records += 1
    this.apply(record)
    this.noteLogWrite(base, record)
    this.writeDerived()
    this.maybeCompact(base)
  }

  /**
   * 追加一条会话日志记录（有限次重试）；写不进回 false（回合不开始 / 该步未发生）。
   * `applyRecord` 为假时调用方已自行落内存（收口 CAS 已改终态，不能重复应用而误记迟到）。
   */
  private async appendConversationWithRetry(conv: string, record: Rec, applyRecord = true): Promise<boolean> {
    const base = this.requireBase(conv)
    const path = this.conversationLogPath(base)
    for (let attempt = 0; attempt < APPEND_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await this.sleepFn(APPEND_RETRY_DELAYS_MS[attempt])
      try {
        this.appendFn(path, record)
        this.records += 1
        if (applyRecord) this.apply(record)
        this.noteLogWrite(base, record)
        this.writeDerived()
        this.maybeCompact(base)
        return true
      } catch {
        // 追加失败：退避后重试；耗尽由调用方判断。
      }
    }
    return false
  }

  /** 记录每目录追加的条数 / 字节（供压实阈值判定）。 */
  private noteLogWrite(base: string, record: Rec): void {
    this.logRecords.set(base, (this.logRecords.get(base) ?? 0) + 1)
    this.logBytes.set(base, (this.logBytes.get(base) ?? 0) + Buffer.byteLength(JSON.stringify(record), 'utf8') + 1)
  }

  /** 达到阈值即把该会话日志压成一条快照（覆盖全部已装配记录）。 */
  private maybeCompact(base: string): void {
    if (this.dataDir === null) return
    const records = this.logRecords.get(base) ?? 0
    const bytes = this.logBytes.get(base) ?? 0
    if (records < this.compactRecords && bytes < this.compactBytes) return
    this.compact(base)
  }

  /** 装配一条会话快照：消息（本会话 + 收件箱）与回合条目（含步记录 / 取消意图 / 迟到收口）。 */
  private buildSnapshot(base: string): Rec {
    const groups: Rec[] = []
    for (const key of [base, `${base}${INBOX_SUFFIX}`]) {
      const list = this.messages.get(key)
      if (list !== undefined) groups.push({ conv: key, messages: list as unknown as Json })
    }
    const turns = (this.turnLogByConv.get(base) ?? []).map((entry) => serializeTurn(entry))
    return { t: 'snapshot', v: 1, conv: base, messages: groups as unknown as Json, turns: turns as unknown as Json }
  }

  /** 写快照替换该会话日志（单写者，原子整份重写）。 */
  private compact(base: string): void {
    if (this.dataDir === null) return
    const line = `${JSON.stringify(this.buildSnapshot(base))}\n`
    const path = this.conversationLogPath(base)
    writeFileAtomicSync(path, line)
    pendingFsyncBytes.delete(path)
    this.logRecords.set(base, 1)
    this.logBytes.set(base, Buffer.byteLength(line, 'utf8'))
  }

  // ── 启动收口与回合路由 ────────────────────────────────────────────────────

  /**
   * 启动收口：索引里仍开着的回合置 `interrupted{retryable:true}`；已落取消意图的置 `cancelled`。
   * 只加载这些开回合所属的会话日志（O(open 回合)）；日志里已收口的回合仅补索引关项。
   */
  private settleOpenTurns(): void {
    for (const turnId of [...this.openTurns]) {
      const entry = this.turnEntryOf(turnId)
      if (entry === undefined || entry.state !== 'open') {
        this.persistClose(turnId)
        continue
      }
      const outcome = entry.cancel_requested ? cancelled() : interrupted()
      const record: Rec = { type: 'turn.settle', turn_id: turnId, outcome: outcome as unknown as Rec }
      if (!this.persistSyncConversation(entry.conv, record)) continue
      this.persistClose(turnId)
    }
  }

  /** 同步追加一条会话日志记录（启动收口 / 迁移用）；失败保留内存终态，下次启动再收口。 */
  private persistSyncConversation(conv: string | null, record: Rec): boolean {
    try {
      if (conv === null || this.dataDir === null) {
        this.records += 1
        this.apply(record)
        this.writeDerived()
        return true
      }
      this.appendConversation(conv, record)
      return true
    } catch {
      return false
    }
  }

  /** 补写索引关项（尽力）；写不进则下次启动按日志里已有终态自愈。 */
  private persistClose(turnId: string): void {
    try {
      this.commit({ t: 'close_turn', turn_id: turnId })
    } catch {
      // 关项失败不影响内存；重启时按会话日志里的已收口状态补写，不重复追加 settle。
    }
  }

  /** 按 turn_id 取回合条目；未加载会话按索引路由惰性加载。 */
  private turnEntryOf(turnId: string): TurnEntry | undefined {
    const direct = this.turnLogById.get(turnId)
    if (direct !== undefined) return direct
    const conv = this.turnConv.get(turnId)
    if (conv === undefined) return undefined
    this.ensureLoaded(conv)
    return this.turnLogById.get(turnId)
  }

  // ── 写口（会话轨，`commit` 用） ─────────────────────────────────────────────

  /** 追加一条消息（同 conv 同 id 幂等）；返回是否新增。不安全 conv id 直接抛（不触盘）。 */
  appendMessage(run: string | null, conv: string, msg: Rec): boolean {
    this.ensureLoaded(conv)
    if (this.positionsOf(conv).has(msg['id'])) return false
    this.appendConversation(conv, { t: 'msg', run, conv, msg })
    return true
  }

  /** 新增 / 替换会话条目；写入时补上派生的 `head` / `count`（未加载会话也能从索引回答清单）。 */
  upsertConversation(run: string | null, entry: Rec): void {
    this.commit({ t: 'conv', run, entry: this.entryWithHead(entry) })
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
    if (turnId === null || slotRef === null || conv === null) {
      return { status: 'failed', turn_id: turnId ?? '', conv: null }
    }
    if (!isSafeConversationId(baseConversationId(conv))) {
      return { status: 'failed', turn_id: turnId, conv }
    }
    const embedded = isRecord(record['new_conversation']) ? record['new_conversation'] : null
    if (embedded !== null && !isSafeConversationId(asStr(embedded['id']) ?? '')) {
      return { status: 'failed', turn_id: turnId, conv }
    }
    this.ensureLoaded(conv)
    const byId = this.turnLogById.get(turnId)
    if (byId !== undefined) return this.existingTurn(byId)
    const bySlotId = this.turnBySlot.get(slotRef)
    if (bySlotId !== undefined) {
      const bySlot = this.turnLogById.get(bySlotId)
      if (bySlot !== undefined) return this.existingTurn(bySlot)
    }
    const reservedById = this.reservedOpens.get(turnId)
    if (reservedById !== undefined) {
      return { status: 'already_open', turn_id: turnId, conv: reservedById.conv || conv, state: 'open', outcome: null }
    }
    const reserved = this.reservedForSlot(slotRef)
    if (reserved !== null) {
      return { status: 'already_open', turn_id: reserved.turn_id, conv: reserved.conv || conv, state: 'open', outcome: null }
    }
    const busyTurnId = this.busyTurnFor(conv, turnId, slotRef)
    if (busyTurnId !== null) {
      return { status: 'turn_busy', turn_id: turnId, conv, busy_turn_id: busyTurnId }
    }
    this.reservedOpens.set(turnId, { turn_id: turnId, slot_ref: slotRef, conv })
    const persisted = await this.appendConversationWithRetry(conv, record)
    if (!persisted) {
      this.reservedOpens.delete(turnId)
      return { status: 'failed', turn_id: turnId, conv: null }
    }
    // 会话由回合头带出时，索引补一条会话条目与当前选择（启动即可从索引回答清单，不必读会话日志）。
    if (embedded !== null && asStr(embedded['id']) !== null) {
      this.commit({ t: 'conv', run: null, entry: this.entryWithHead(embedded) })
      if (asStr(embedded['kind']) !== 'subagent') this.commit({ t: 'current', run: null, id: embedded['id'] as string })
    }
    this.commit({ t: 'open_turn', turn_id: turnId, conv })
    const entry = this.turnLogById.get(turnId)
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

  /** 本会话是否有另一个开态回合（已加载或已预留）：命中即回其 `turn_id`。 */
  private busyTurnFor(conv: string, turnId: string, slotRef: string): string | null {
    for (const entry of this.turnLogByConv.get(conv) ?? []) {
      if (entry.turn_id === turnId || entry.state !== 'open' || entry.slot_ref === slotRef) continue
      return entry.turn_id
    }
    for (const open of this.reservedOpens.values()) {
      if (open.turn_id === turnId) continue
      if (open.conv !== conv || open.slot_ref === slotRef) continue
      return open.turn_id
    }
    return null
  }

  /**
   * 追加一条步记录（intent / result / checkpoint）：按 `(turn_id, type, seq)` 去重。
   * 追加失败不落内存（该步视为未发生）；调用方据此收口。
   */
  async appendStep(record: Rec): Promise<'appended' | 'exists' | 'not_found' | 'not_open' | 'failed'> {
    const turnId = asStr(record['turn_id'])
    if (turnId === null) return 'not_found'
    const entry = this.turnEntryOf(turnId)
    if (entry === undefined) return 'not_found'
    if (entry.state !== 'open') return 'not_open'
    const key = stepKeyOf(record, turnId)
    if (key !== null) {
      if (entry.stepKeys.has(key.local)) return 'exists'
      if (this.reservedSeqs.has(key.reserved)) return 'exists'
      this.reservedSeqs.add(key.reserved)
    }
    const persisted = await this.appendConversationWithRetry(entry.conv, record)
    if (!persisted) {
      if (key !== null) this.reservedSeqs.delete(key.reserved)
      return 'failed'
    }
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
    const entry = this.turnEntryOf(turnId)
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
    const persisted = await this.appendConversationWithRetry(entry.conv, record)
    if (!persisted) return { status: 'failed', seq: null }
    return { status: 'inserted', seq }
  }

  /** 回合所属会话 id（无该回合回 null）。 */
  conversationOfTurn(turnId: string): string | null {
    const entry = this.turnLogById.get(turnId)
    if (entry !== undefined) return entry.conv
    return this.turnConv.get(turnId) ?? null
  }

  /**
   * CAS 收口：开态 / interrupted 允许落定，终态拒绝并记迟到。同步判定胜者，再尽力追加。
   * 追加失败不回滚内存终态（停止后续调用；重启时按 open 收口为 interrupted）。
   */
  async settle(
    turnId: string,
    outcome: Rec,
  ): Promise<{ status: 'settled' | 'late' | 'unknown'; persisted: boolean }> {
    const entry = this.turnEntryOf(turnId)
    if (entry === undefined) return { status: 'unknown', persisted: false }
    const record: Rec = { type: 'turn.settle', turn_id: turnId, outcome }
    if (entry.state === 'settled' && isTerminalOutcome(entry.outcome)) {
      entry.late.push(outcome)
      const persisted = await this.appendConversationWithRetry(entry.conv, record, false)
      return { status: 'late', persisted }
    }
    entry.state = 'settled'
    entry.outcome = outcome
    this.openTurns.delete(turnId)
    const persisted = await this.appendConversationWithRetry(entry.conv, record, false)
    if (persisted) this.persistClose(turnId)
    return { status: 'settled', persisted }
  }

  /**
   * 记录取消意图（不落终态；终态仍由 `settle` 的 CAS 落定）。
   * 结局已定 / 回合未知时不追加；意图已存在时幂等返回，不重复追加。追加失败回 failed，调用方按尽力上报。
   */
  async cancelTurn(
    turnId: string,
  ): Promise<{ status: 'recorded' | 'settled' | 'unknown' | 'failed'; outcome: Rec | null; conv: string | null }> {
    const entry = this.turnEntryOf(turnId)
    if (entry === undefined) return { status: 'unknown', outcome: null, conv: null }
    if (entry.state === 'settled') return { status: 'settled', outcome: entry.outcome, conv: entry.conv }
    if (entry.cancel_requested) return { status: 'recorded', outcome: null, conv: entry.conv }
    const record: Rec = { t: 'cancel', conv: entry.conv, turn_id: turnId }
    const persisted = await this.appendConversationWithRetry(entry.conv, record)
    if (!persisted) return { status: 'failed', outcome: null, conv: entry.conv }
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
    const persisted = await this.commitIndexWithRetry(record)
    if (!persisted) return 'failed'
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
    const initial = this.pick(convId)
    const id = initial !== null ? (initial['id'] as string) : null
    if (id !== null) this.ensureLoaded(id)
    const conversation = id !== null ? this.pick(id) : null
    const refs: Rec = {}
    if (id !== null) {
      for (const msg of this.messages.get(id) ?? []) {
        refs[msg['id'] as string] = msg
      }
    }
    return {
      ...this.body(),
      head: conversation !== null ? headId(conversation) : null,
      refs,
      turns: id !== null ? this.turnsFor(id) : [],
      inbox_unread: id !== null ? this.unreadInbox(id) : [],
      data_gen: null,
    }
  }

  /**
   * 未读收件箱投影：`${conv}#inbox` 里 `seq > last_seen` 的条目，按 `seq` 升序（确定性）。
   * 只读：不回写、不推进水位（推进由 `ackInbox` 另行追加记录）。
   */
  unreadInbox(convId: string): Rec[] {
    this.ensureLoaded(convId)
    const conversation = this.conversations.find((item) => item['id'] === convId)
    if (conversation === undefined) return []
    const inbox = isRecord(conversation['inbox']) ? (conversation['inbox'] as Rec) : {}
    const lastSeen = numberField(inbox, 'last_seen') ?? 0
    const out: Rec[] = []
    for (const msg of this.messages.get(`${convId}${INBOX_SUFFIX}`) ?? []) {
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
   * 展示面只回窗口内的数据：`refs` 与 `turns` 随窗口收敛，`turns` 不带步记录（步记录由 `read` / `turn` 全量给）。
   * `full` 为导出面显式全量：`refs` 收全量、`turns` 带步记录（展示面默认不背全量）。
   */
  history(convId: string | null, before: string | null, limit: number | null, full = false): Rec {
    const initial = this.pick(convId)
    const id = initial !== null ? (initial['id'] as string) : null
    if (id !== null) this.ensureLoaded(id)
    const conversationId = id
    const entries = conversationId === null ? [] : this.turnEntriesFor(conversationId)
    const turns = entries.map((entry) => this.turnView(entry))
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
    // refs 默认只随窗口走（与 messages 同窗）；导出面取全量沿 `prev` 还原整条链。
    const walk = new Set(window.map((entry) => entry.hash))
    const refs: Rec = {}
    for (const msg of conversationId === null ? [] : this.messages.get(conversationId) ?? []) {
      const id = msg['id']
      if (typeof id === 'string' && (full || walk.has(id))) refs[id] = msg
    }
    const selectedIds = new Set(selected.map((group) => group.turnId))
    const windowTurns = full
      ? turns
      : entries.filter((entry) => selectedIds.has(entry.turn_id)).map((entry) => this.turnView(entry, false))
    return {
      conversation: conversationId,
      before,
      limit,
      messages: window,
      next_before: start > 0 ? oldest : null,
      turns: windowTurns,
      body: this.body(),
      refs,
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
      const entry = this.turnLogById.get(turnId)
      const conv = entry?.conv ?? this.turnConv.get(turnId)
      if (conv !== undefined) out.push({ turn_id: turnId, conv })
    }
    return out
  }

  /** 一条回合的对外视图（含步记录与被拒的迟到收口）；未加载会话按索引路由惰性加载。 */
  turn(turnId: string): Rec | null {
    const entry = this.turnEntryOf(turnId)
    return entry === undefined ? null : this.turnView(entry)
  }

  /** 某一会话的全部回合视图（按发生序）。 */
  turnsFor(convId: string): Rec[] {
    return this.turnEntriesFor(convId).map((entry) => this.turnView(entry))
  }

  /** 某一会话的回合条目（按发生序）；只遍历本会话桶，O(本会话回合)。 */
  private turnEntriesFor(convId: string): TurnEntry[] {
    this.ensureLoaded(convId)
    return this.turnLogByConv.get(convId) ?? []
  }

  /**
   * 回合对外视图。`includeSteps` 为真给出引擎切片（`read` / `turn`）需要的 `slot_ref` 与 `steps`；
   * 为假给出展示面（`history` 默认）只带的 UI 消费字段，不再背步记录。
   */
  private turnView(entry: TurnEntry, includeSteps = true): Rec {
    const view: Rec = {
      turn_id: entry.turn_id,
      conv: entry.conv,
      at: entry.at,
      state: entry.state,
      outcome: entry.outcome,
      cancel_requested: entry.cancel_requested,
      late_settles: entry.late,
      user_message: entry.user_message,
      ...(entry.thread_kind !== null ? { thread_kind: entry.thread_kind } : {}),
      ...(entry.task_prompt !== null ? { task_prompt: entry.task_prompt } : {}),
      ...(entry.parent_checkpoint !== null ? { parent_checkpoint: entry.parent_checkpoint } : {}),
      ...(entry.parent_summaries !== null ? { parent_summaries: entry.parent_summaries } : {}),
    }
    if (includeSteps) {
      view['slot_ref'] = entry.slot_ref
      view['steps'] = entry.steps
    }
    return view
  }

  conversation(convId: string | null): Rec | null {
    return this.pick(convId)
  }

  messagesOf(convId: string): Rec[] {
    this.ensureLoaded(convId)
    return this.messages.get(convId) ?? []
  }

  currentId(): string | null {
    return this.current
  }

  /**
   * 会话条目补派生字段：已加载会话从消息列表现算；未加载会话用落盘时写入的
   * `head` / `count`（索引已带），保证启动清单不必读会话日志。
   */
  private entryWithHead(entry: Rec): Rec {
    const id = entry['id']
    if (typeof id !== 'string') return entry
    const list = this.messages.get(id)
    if (list !== undefined || this.loadedConvs.has(id)) {
      const messages = list ?? []
      const last = messages.length > 0 ? messages[messages.length - 1] : null
      return {
        ...entry,
        head: last !== null ? { def: last['id'] } : null,
        count: messages.length,
        updated_at: last !== null ? (last['at'] ?? null) : null,
      }
    }
    return {
      ...entry,
      head: entry['head'] ?? null,
      count: typeof entry['count'] === 'number' ? entry['count'] : 0,
      updated_at: entry['updated_at'] ?? null,
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

  // ── 迁移序列化（旧布局 → 新布局） ──────────────────────────────────────────

  /** 从内存态导出索引记录：会话条目（补派生字段）/ 当前选择 / 半份提交标记 / 回合路由。 */
  private serializeIndex(): Rec[] {
    const out: Rec[] = []
    for (const entry of this.conversations) out.push({ t: 'conv', run: null, entry: this.entryWithHead(entry) })
    if (this.current !== null) out.push({ t: 'current', run: null, id: this.current })
    for (const mark of this.turns.values()) {
      out.push({ t: 'turn', run: mark.run, conv: mark.conv, state: mark.state })
    }
    for (const [turnId, conv] of this.turnConv) out.push({ t: 'open_turn', turn_id: turnId, conv })
    for (const turnId of this.turnConv.keys()) {
      if (!this.openTurns.has(turnId)) out.push({ t: 'close_turn', turn_id: turnId })
    }
    return out
  }

  /** 内存态涉及的会话目录基 id（消息键与回合所属会话的并集）。 */
  private conversationBases(): Set<string> {
    const bases = new Set<string>()
    for (const key of this.messages.keys()) bases.add(baseConversationId(key))
    for (const conv of this.turnLogByConv.keys()) bases.add(baseConversationId(conv))
    return bases
  }

  /** 把内存态写进新布局：索引 + 每会话一份快照日志。 */
  private writeLayout(indexFile: string, conversationsDir: string): void {
    const indexLines = this.serializeIndex().map((record) => JSON.stringify(record)).join('\n')
    mkdirSync(conversationsDir, { recursive: true })
    writeFileAtomicSync(indexFile, indexLines.length > 0 ? `${indexLines}\n` : '')
    for (const base of this.conversationBases()) {
      if (!isSafeConversationId(base)) continue
      const dir = join(conversationsDir, base)
      mkdirSync(dir, { recursive: true })
      writeFileAtomicSync(join(dir, CONVERSATION_LOG_FILE), `${JSON.stringify(this.buildSnapshot(base))}\n`)
    }
  }
}

/**
 * 幂等迁移：把旧单文件 `session.jsonl` 重放成内存态后写新布局（索引 + 每会话快照日志 + 完成标记）。
 * 旧文件保留不删；有完成标记即跳过；失败时标记未落，下次启动重做（不破坏旧文件）。
 */
function migrateLegacy(legacyFile: string, dataDir: string): void {
  const records = replay(legacyFile, false)
  const staging = new SessionStore(null, null)
  for (const record of records) staging.apply(record)
  // 迁移即启动：把旧文件里仍开着的回合收口为 interrupted / cancelled（与正常启动一致）。
  staging.settleOpenTurns()
  const indexFile = join(dataDir, INDEX_FILE)
  const conversationsDir = join(dataDir, CONVERSATIONS_DIR)
  rmSync(indexFile, { force: true })
  rmSync(conversationsDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  staging.writeLayout(indexFile, conversationsDir)
  writeFileSync(join(dataDir, MIGRATION_MARKER), 'migrated\n', 'utf8')
}

export function headId(conversation: Rec | null): string | null {
  if (conversation === null) return null
  const list = conversation['head']
  if (!isRecord(list)) return null
  const def = list['def']
  return typeof def === 'string' ? def : null
}
