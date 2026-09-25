// 长期记忆条目的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：条目与 body 不再进世界。
// 引擎 = 单文件追加日志 `memory.jsonl`（每条一次 append + fsync，换行收尾）；启动重放即得全量状态。
// 记录：`{t:'entry', run, entry}`（按 id 覆盖，幂等）、`{t:'body', run, body}`、`{t:'turn', run, state}`。
// 向量索引（③）由本存储的 body / 条目重算，删掉可重建；本文件只存不可重算的条目与 body。

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { countOf, isDeleted, linkedEntries, tailHashOf } from './store.ts'
import type { Json, Rec } from './types.ts'

export interface TurnMark {
  run: string
  state: 'open' | 'closed'
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyBody(anchor: { id: string; dim: number }): Rec {
  return { tail: null, count: 0, deleted: {}, pinned: {}, model: { id: anchor.id, dim: anchor.dim } }
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
 * 长期记忆存储：写口只有本身份；每个变更一次 append（边跑边追加），不攒到回合收口。
 * 读口从内存态返回；内存态由 ④ 重放得到。
 */
export class MemoryStore {
  private readonly dataFile: string | null
  private bodyValue: Rec
  private entries = new Map<string, Rec>()
  private turns = new Map<string, TurnMark>()
  private readonly anchor: { id: string; dim: number }

  private constructor(dataFile: string | null, anchor: { id: string; dim: number }) {
    this.dataFile = dataFile
    this.anchor = anchor
    this.bodyValue = emptyBody(anchor)
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
  }

  /** 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`；未注入则纯内存（仅测试）。 */
  static open(anchor: { id: string; dim: number }, env: NodeJS.ProcessEnv = process.env): MemoryStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    let dataFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'memory.jsonl')
    }
    return new MemoryStore(dataFile, anchor)
  }

  private apply(record: Rec): void {
    const type = record['t']
    if (type === 'entry') {
      const entry = record['entry']
      if (isRecord(entry) && typeof entry['id'] === 'string') this.entries.set(entry['id'] as string, entry)
      return
    }
    if (type === 'body') {
      const body = record['body']
      if (isRecord(body)) this.bodyValue = body
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

  /** 整份 body（链尾 + 计数 + deleted / pinned + 模型锚）。 */
  body(): Rec {
    return this.bodyValue
  }

  /** 全部条目（含已逻辑删除）按 id 索引，供链式遍历与 read。 */
  refs(): Rec {
    const out: Rec = {}
    for (const [id, entry] of this.entries) out[id] = entry
    return out
  }

  /** 存活条目（沿链从新到旧，跳过 `body.deleted`）。 */
  liveEntries(): Rec[] {
    const out: Rec[] = []
    for (const { entry } of linkedEntries(this.bodyValue, this.refs())) {
      if (!isDeleted(this.bodyValue, entry)) out.push(entry)
    }
    return out
  }

  entryOf(id: string): Rec | null {
    return this.entries.get(id) ?? null
  }

  /** 追加 / 覆盖一条条目（同 id 同内容幂等；同 id 新内容覆盖）。 */
  appendEntry(run: string | null, entry: Rec): void {
    const id = entry['id']
    if (typeof id !== 'string') return
    const existing = this.entries.get(id)
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) return
    this.commit({ t: 'entry', run, entry })
  }

  /** 覆盖 body（链尾 / 计数 / deleted / pinned / 模型锚）。 */
  setBody(run: string | null, body: Rec): void {
    if (JSON.stringify(this.bodyValue) === JSON.stringify(body)) return
    this.commit({ t: 'body', run, body })
  }

  /** 链尾 id；无链尾回 null。 */
  tailId(): string | null {
    return tailHashOf(this.bodyValue)
  }

  /** 条目总数（含逻辑删除，用于索引落后判据）。 */
  count(): number {
    return countOf(this.bodyValue)
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

  /** 模型锚（schema 派生）。 */
  anchorOf(): { id: string; dim: number } {
    return { ...this.anchor }
  }
}

/** 模型锚缺省；供测试与 main 复用。 */
export function defaultAnchor(): { id: string; dim: number } {
  return { id: 'granite-97m', dim: 384 }
}

export type { Json }
