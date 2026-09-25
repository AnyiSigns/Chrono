// 短期记忆 L1 / L2 的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：摘要不再进世界。
// 引擎 = 单文件追加日志 `short-memory.jsonl`（每条一次 append + fsync，换行收尾）；启动重放即得全量状态。
// 记录：`{t:'l1'|'l2', run, id, record|null}`（record=null 即删除）、`{t:'turn', run, state}`。
// 边跑边追加：写先置回合 open 标记、再落记录并置 closed；中途崩留下的 open 标记即中断残留，可辨。
// 同键重复写同值幂等；存量不搬，存储从空开始。

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Json, Rec } from './types.ts'

export interface TurnMark {
  run: string
  state: 'open' | 'closed'
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
 * 短期记忆存储：写口只有本身份；每个变更一次 append（边跑边追加），不攒到回合收口。
 * 读口从内存态返回；内存态由 ④ 重放得到。
 */
export class ShortMemoryStore {
  private readonly dataFile: string | null
  private sessions = new Map<string, Rec>()
  private workspaces = new Map<string, Rec>()
  private turns = new Map<string, TurnMark>()

  private constructor(dataFile: string | null) {
    this.dataFile = dataFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`；未注入则纯内存（仅测试）。 */
  static open(env: NodeJS.ProcessEnv = process.env): ShortMemoryStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    let dataFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'short-memory.jsonl')
    }
    return new ShortMemoryStore(dataFile)
  }

  private apply(record: Rec): void {
    const type = record['t']
    if (type === 'l1' || type === 'l2') {
      const id = record['id']
      if (typeof id !== 'string') return
      const target = type === 'l1' ? this.sessions : this.workspaces
      const value = record['record']
      if (value === null || value === undefined) target.delete(id)
      else if (isRecord(value)) target.set(id, value)
      return
    }
    if (type === 'turn') {
      const run = record['run']
      if (typeof run !== 'string') return
      this.turns.set(run, { run, state: record['state'] === 'closed' ? 'closed' : 'open' })
    }
  }

  private commit(record: Rec): void {
    this.apply(record)
    appendRecord(this.dataFile, record)
  }

  /** 整份 body（L1 sessions + L2 workspaces）。 */
  body(): Rec {
    const sessions: Rec = {}
    for (const [id, record] of this.sessions) sessions[id] = record
    const workspaces: Rec = {}
    for (const [id, record] of this.workspaces) workspaces[id] = record
    return { version: 1, sessions, workspaces }
  }

  sessionOf(id: string): Rec | null {
    return this.sessions.get(id) ?? null
  }

  workspaceOf(id: string): Rec | null {
    return this.workspaces.get(id) ?? null
  }

  /** 置 / 删一条 L1（record=null 即删除）；同键同值幂等。 */
  setL1(run: string | null, id: string, record: Rec | null): void {
    const existing = this.sessions.get(id) ?? null
    if (JSON.stringify(existing) === JSON.stringify(record)) return
    this.commit({ t: 'l1', run, id, record })
  }

  /** 置 / 删一条 L2（record=null 即删除）；同键同值幂等。 */
  setL2(run: string | null, id: string, record: Rec | null): void {
    const existing = this.workspaces.get(id) ?? null
    if (JSON.stringify(existing) === JSON.stringify(record)) return
    this.commit({ t: 'l2', run, id, record })
  }

  turnOpen(run: string | null): void {
    if (run === null) return
    this.commit({ t: 'turn', run, state: 'open' })
  }

  turnClose(run: string | null): void {
    if (run === null) return
    this.commit({ t: 'turn', run, state: 'closed' })
  }

  /** 未闭合回合（中断残留）的回合 id 列表。 */
  pendingTurns(): string[] {
    const out: string[] = []
    for (const mark of this.turns.values()) if (mark.state === 'open') out.push(mark.run)
    return out.sort()
  }
}

export type { Json }
