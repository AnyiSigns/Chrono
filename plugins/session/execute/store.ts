// 会话运行记录的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：消息链 / 会话元数据不再进世界。
// 引擎 = 单文件追加日志 `session.jsonl`（每条一次 append + fsync，换行收尾）；启动重放即得全量状态。
// 每条记录盖回合 id（`run`）与消息 id：同回合 / 同消息重复写幂等收敛；回合 open→closed 标记使半份状态可辨。
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

/** 内存态（由 ④ 重放得到）；对外只读。 */
export interface SessionState {
  current: string | null
  conversations: Rec[]
  messages: Map<string, Rec[]>
  turns: Map<string, TurnMark>
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 追加一条 JSON 记录并 fsync；目录缺失时静默（纯内存降级，仅测试无 ④ 注入时发生）。 */
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
  private current: string | null = null
  private conversations: Rec[] = []
  private messages = new Map<string, Rec[]>()
  private turns = new Map<string, TurnMark>()
  private records = 0

  private constructor(dataFile: string | null, stateFile: string | null) {
    this.dataFile = dataFile
    this.stateFile = stateFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
    this.writeDerived()
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`，③ 取 `CHRONO_PLUGIN_STATE`。 */
  static open(env: NodeJS.ProcessEnv = process.env): SessionStore {
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
    return new SessionStore(dataFile, stateFile)
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
        if (!isRecord(entry) || typeof entry['id'] !== 'string') return
        const id = entry['id'] as string
        const index = this.conversations.findIndex((item) => item['id'] === id)
        if (index >= 0) this.conversations[index] = entry
        else this.conversations.push(entry)
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
      default:
        return
    }
  }

  private commit(record: Rec): void {
    this.records += 1
    this.apply(record)
    appendRecord(this.dataFile, record)
    this.writeDerived()
  }

  // ── 写口 ────────────────────────────────────────────────────────────────

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

  // ── 读口 ────────────────────────────────────────────────────────────────

  body(): Rec {
    return {
      version: 1,
      current: this.current,
      conversations: this.conversations.map((entry) => this.entryWithHead(entry)),
    }
  }

  /** 会话切片：body + 顶层 head（链头消息 id）+ refs（消息 id → body）+ data_gen=null。 */
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
      data_gen: null,
    }
  }

  /** 展示历史：新 → 旧窗口；`before` 命中的那条不含（从它更旧处起）。 */
  history(convId: string | null, before: string | null, limit: number | null): Rec {
    const conversation = this.pick(convId)
    const refs: Rec = {}
    const chain: Rec[] = []
    if (conversation !== null) {
      const list = this.messages.get(conversation['id'] as string) ?? []
      for (const msg of list) refs[msg['id'] as string] = msg
      for (let i = list.length - 1; i >= 0; i--) chain.push({ hash: list[i]['id'] as string, def: list[i] })
    }
    let start = 0
    if (before !== null) {
      const index = chain.findIndex((entry) => entry['hash'] === before || isRecord(entry['def']) && entry['def']['id'] === before)
      start = index >= 0 ? index + 1 : 0
    }
    const window = limit !== null ? chain.slice(start, start + limit) : chain.slice(start)
    return {
      conversation: conversation !== null ? (conversation['id'] as string) : null,
      before,
      limit,
      messages: window,
      next_before: null,
      body: this.body(),
      refs,
    }
  }

  /** 未闭合回合（中断残留）的回合 id 列表，供调用方辨识半份状态。 */
  pendingTurns(): string[] {
    const out: string[] = []
    for (const mark of this.turns.values()) if (mark.state === 'open') out.push(mark.run)
    return out
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
    }
  }

  private pick(convId: string | null): Rec | null {
    const list = this.conversations
    if (convId !== null) {
      const found = list.find((item) => item['id'] === convId)
      if (found !== undefined) return this.entryWithHead(found)
    }
    if (this.current !== null) {
      const found = list.find((item) => item['id'] === this.current)
      if (found !== undefined) return this.entryWithHead(found)
    }
    return list.length > 0 ? this.entryWithHead(list[0]) : null
  }
}

export function headId(conversation: Rec | null): string | null {
  if (conversation === null) return null
  const list = conversation['head']
  if (!isRecord(list)) return null
  const def = list['def']
  return typeof def === 'string' ? def : null
}
