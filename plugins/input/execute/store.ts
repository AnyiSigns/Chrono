// 输入槽的自有持久存储（④ `CHRONO_PLUGIN_DATA`）：per-thread 槽不再进世界。
// 引擎 = 单文件追加日志 `slots.jsonl`（每条一次 open + 写入；fsync 按累计字节批量做）；启动重放即得全量槽位。
// 每条记录盖回合 id（`run`）：同回合同线程重复写幂等收敛（同值不重写）。
// 派生物（水位）落 ③ `CHRONO_PLUGIN_STATE/index.json`，删掉可由 ④ 重放重建。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Rec = { [key: string]: Json }

/** 缺省线程键（per-thread 键控：无 thread 时回落）。 */
export const MAIN_THREAD = '_main'

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 批量 fsync 的累计字节阈值：达到即同步一次（槽是低频小记录，靠批量摊薄 fsync）。 */
const FSYNC_BYTES = 256 * 1024
/** 每数据文件自上次 fsync 起的累计字节（单写者：每路径一个写口）。 */
const pendingFsyncBytes = new Map<string, number>()

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
    if (pending >= FSYNC_BYTES) {
      fsyncSync(fd)
      pendingFsyncBytes.delete(path)
    } else {
      pendingFsyncBytes.set(path, pending)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * 容错重放：逐行解析，带换行的坏行跳过（fail-open）。
 * 末段无换行且解析失败视为半写撕裂尾：截到有效前缀，令后续追加不会与新记录粘连；缺文件视为空。
 */
function replay(path: string): Rec[] {
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
  if (validBytes < bytes.length) truncateSync(path, validBytes)
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
  private runs = new Map<string, string | null>()
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
    // 槽写入时的 run id 随槽留存：回合开始以其作 `slot_ref` 幂等键（同槽不开第二个回合）。
    const run = record['run']
    this.runs.set(thread, typeof run === 'string' ? run : null)
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

  /** 某线程槽写入时的 run id（`slot_ref`）；无该线程键回 null。 */
  slotRef(thread: string): string | null {
    return this.runs.get(thread) ?? null
  }

  /** 全部线程的槽引用映射（body 形状之外的读口附加项）。 */
  slotRefs(): Rec {
    const out: Rec = {}
    for (const [thread, run] of this.runs) out[thread] = run
    return out
  }
}
