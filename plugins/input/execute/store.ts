// 输入槽的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：per-thread 槽不再进世界。
// 引擎 = 单文件追加日志 `slots.jsonl`（每条一次 append + fsync）；启动重放即得全量槽位。
// 每条记录盖回合 id（`run`）：同回合同线程重复写幂等收敛（同值不重写）。
// 派生物（水位）落 ③ `CHRONO_PLUGIN_STATE/index.json`，删掉可由 ④ 重放重建。

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

/** 缺省线程键（per-thread 键控：无 thread 时回落）。 */
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
      // 半写撕裂的末行 / 坏行跳过（fail-open）。
    }
  }
  return out
}

/**
 * 输入槽存储。写口只有本身份：`set` 一次 append（边跑边追加），不攒到回合收口。
 * 内存态由 ④ 重放得到；③ 只是派生物（水位），缺失 / 删除不影响正确性。
 */
export class InputStore {
  private readonly dataFile: string | null
  private readonly stateFile: string | null
  private slots = new Map<string, Json>()
  private records = 0

  private constructor(dataFile: string | null, stateFile: string | null) {
    this.dataFile = dataFile
    this.stateFile = stateFile
    if (dataFile !== null) {
      for (const record of replay(dataFile)) this.apply(record)
    }
    this.writeDerived()
  }

  static open(env: NodeJS.ProcessEnv = process.env): InputStore {
    const dataDir = env['CHRONO_PLUGIN_DATA']
    const stateDir = env['CHRONO_PLUGIN_STATE']
    let dataFile: string | null = null
    let stateFile: string | null = null
    if (typeof dataDir === 'string' && dataDir.length > 0) {
      mkdirSync(dataDir, { recursive: true })
      dataFile = join(dataDir, 'slots.jsonl')
    }
    if (typeof stateDir === 'string' && stateDir.length > 0) {
      mkdirSync(stateDir, { recursive: true })
      stateFile = join(stateDir, 'index.json')
    }
    return new InputStore(dataFile, stateFile)
  }

  private writeDerived(): void {
    if (this.stateFile === null) return
    try {
      writeFileSync(this.stateFile, `${JSON.stringify({ records: this.records, threads: this.slots.size })}\n`, 'utf8')
    } catch {
      // ③ 写失败不影响真源。
    }
  }

  private apply(record: Rec): void {
    if (record['t'] !== 'slot') return
    const thread = record['thread']
    if (typeof thread !== 'string') return
    this.slots.set(thread, (record['slot'] ?? null) as Json)
  }

  /** 写一个线程键（同值不重写：幂等短路）。 */
  set(run: string | null, thread: string, slot: Json): boolean {
    if (this.slots.has(thread) && JSON.stringify(this.slots.get(thread)) === JSON.stringify(slot)) return false
    this.records += 1
    this.apply({ t: 'slot', run, thread, slot })
    appendRecord(this.dataFile, { t: 'slot', run, thread, slot })
    this.writeDerived()
    return true
  }

  get(thread: string): Json {
    return this.slots.get(thread) ?? { kind: 'idle' }
  }

  /** 整份槽体（body 形状）：`{slots:{<thread>:<slot>}}`。 */
  body(): Rec {
    const slots: Rec = {}
    for (const [thread, slot] of this.slots) slots[thread] = slot
    return { slots }
  }
}
