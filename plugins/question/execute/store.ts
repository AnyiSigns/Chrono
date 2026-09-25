// 提问队列与作答回执的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：队列项 / 游标不再进世界。
// 引擎 = 单文件追加日志 `question.jsonl`（每条逻辑写一次 append + fsync，换行收尾）；启动重放即得全量队列。
// 每条记录盖回合 id（`run`）：同回合同 op_key 重复入队幂等收敛；回合 open→closed 标记使半份状态可辨。
// 派生物（记录水位 / 计数）落 ③ `CHRONO_PLUGIN_STATE/index.json`，删掉可由 ④ 重放重建。

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

export const MAIN_THREAD = '_main'

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function appendRecord(path: string | null, record: Rec): void {
  if (path === null) return
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
  const fd = openSync(path, 'a')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function replay(path: string): Rec[] {
  if (!existsSync(path)) return []
  const out: Rec[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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

/** 队列项 id：`q-<run>-<seq>`，seq 取入队前的累计计数（确定性、非随机）。 */
export function questionId(run: string, seq: number): string {
  return `q-${run}-${seq}`
}

/**
 * 提问队列存储。写口只有本身份：每次逻辑写一条 `write` 记录（边跑边追加），不攒到回合收口。
 * 内存态由 ④ 重放得到；③ 只是派生物（水位 / 计数），缺失 / 删除不影响正确性。
 */
export class QuestionStore {
  private readonly dataFile: string | null
  private readonly stateFile: string | null
  private items = new Map<string, Rec>()
  private order: string[] = []
  private total = 0
  private turns = new Map<string, 'open' | 'closed'>()
  private records = 0

  private constructor(dataFile: string | null, stateFile: string | null) {
    this.dataFile = dataFile
    this.stateFile = stateFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
    this.writeDerived()
  }

  static open(env: NodeJS.ProcessEnv = process.env): QuestionStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    const stateDir = env['CHRONO_PLUGIN_STATE']
    let dataFile: string | null = null
    let stateFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'question.jsonl')
    }
    if (typeof stateDir === 'string' && stateDir.length > 0) {
      mkdirSync(stateDir, { recursive: true })
      stateFile = join(stateDir, 'index.json')
    }
    return new QuestionStore(dataFile, stateFile)
  }

  private writeDerived(): void {
    if (this.stateFile === null) return
    try {
      writeFileSync(
        this.stateFile,
        `${JSON.stringify({ records: this.records, count: this.total, items: this.items.size })}\n`,
        'utf8',
      )
    } catch {
      // ③ 写失败不影响真源。
    }
  }

  private apply(record: Rec): void {
    const type = record['t']
    if (type === 'turn') {
      const run = record['run']
      if (typeof run !== 'string') return
      this.turns.set(run, record['state'] === 'closed' ? 'closed' : 'open')
      return
    }
    if (type !== 'write') return
    const ops = record['ops']
    if (!Array.isArray(ops)) return
    for (const op of ops) {
      if (!isRecord(op)) continue
      if (op['op'] === 'item') {
        const item = op['item']
        if (!isRecord(item) || typeof item['id'] !== 'string') continue
        const id = item['id'] as string
        if (!this.items.has(id)) this.order.push(id)
        this.items.set(id, item)
        continue
      }
      if (op['op'] === 'count') {
        const value = op['value']
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) this.total = value
      }
    }
  }

  private commit(record: Rec): void {
    this.records += 1
    this.apply(record)
    appendRecord(this.dataFile, record)
    this.writeDerived()
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
    for (const [run, state] of this.turns) if (state === 'open') out.push(run)
    return out
  }

  findByOpKey(opKey: string | null): Rec | null {
    if (opKey === null) return null
    for (const item of this.items.values()) if (item['op_key'] === opKey) return item
    return null
  }

  appendItem(run: string | null, item: Rec): void {
    const ops: Json[] = [{ op: 'item', item }]
    if (!this.items.has(item['id'] as string)) {
      this.total += 1
      ops.push({ op: 'count', value: this.total })
    }
    this.commit({ t: 'write', run, ops })
  }

  updateItem(run: string | null, item: Rec): void {
    this.commit({ t: 'write', run, ops: [{ op: 'item', item }] })
  }

  updateItems(run: string | null, items: Rec[]): void {
    if (items.length === 0) return
    this.commit({ t: 'write', run, ops: items.map((item) => ({ op: 'item', item })) })
  }

  itemsInOrder(): Rec[] {
    const out: Rec[] = []
    for (const id of this.order) {
      const item = this.items.get(id)
      if (item !== undefined) out.push(item)
    }
    return out
  }

  get(id: string): Rec | null {
    return this.items.get(id) ?? null
  }

  count(): number {
    return this.total
  }

  size(): number {
    return this.items.size
  }
}
