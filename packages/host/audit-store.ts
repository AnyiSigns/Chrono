// 效果审计旁路侧存：审计记录写 `state/audit/audit.jsonl`（不进世界、不进链、不参与重放）。
// 单文件追加 + 上限压实：条数 / 字节超保留窗口即淘汰最旧；再写满一个保留窗口（条数或字节）即整文件
// 原子重写为保留集，故磁盘至多 ≈ 保留集 + 一个窗口，恒有界。
// 半写安全：每条一次写 + fsync 且以换行收尾；启动 / 追加前容错读，末行撕裂即截到有效前缀。
// 单写者：追加是同步的，宿主单进程串行调用，故无并发交错。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'
import { AUDIT_MAX_BYTES, AUDIT_MAX_RECORDS, AuditIndex } from './audit.ts'
import type { AuditDraft, AuditFilter, AuditReport, AuditRecord } from './audit.ts'
import { writeFileAtomic } from './ledger/atomic.ts'

export interface AuditStoreOptions {
  maxRecords?: number
  maxBytes?: number
  /** 覆盖磁盘压实的字节触发阈值；缺省 = 保留窗口字节（`maxBytes`）。 */
  maxFileBytes?: number
}

interface TolerantRead {
  records: AuditRecord[]
  /** 末行无换行且解析失败（撕裂尾）：调用方应截到 `validBytes`。 */
  truncated: boolean
  /** 有效前缀字节长度（含末条完整行的换行）。 */
  validBytes: number
}

function isRecord(value: unknown): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 机械识别一条侧存记录：seq / at 为数字、by 为字符串、body 为 JSON 对象。 */
function asAuditRecord(value: unknown): AuditRecord | null {
  if (!isRecord(value)) return null
  if (typeof value['seq'] !== 'number' || !Number.isFinite(value['seq'])) return null
  if (typeof value['at'] !== 'number' || !Number.isFinite(value['at'])) return null
  if (typeof value['by'] !== 'string') return null
  if (!isRecord(value['body'])) return null
  return {
    seq: value['seq'],
    at: value['at'],
    by: value['by'],
    body: value['body'] as Json,
  }
}

/**
 * 容错读：逐行解析；带换行的坏行跳过（fail-open，旁路不砖化），
 * 末行无换行且解析失败视为撕裂尾丢弃并回报有效前缀字节数。
 */
function readTolerant(file: string): TolerantRead {
  if (!existsSync(file)) return { records: [], truncated: false, validBytes: 0 }
  const bytes = readFileSync(file)
  const records: AuditRecord[] = []
  let validBytes = 0
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const lineEnd = newline === -1 ? bytes.length : newline + 1
    const text = bytes.subarray(start, newline === -1 ? bytes.length : newline).toString('utf8')
    if (text.length === 0) {
      validBytes = lineEnd
      start = lineEnd
      continue
    }
    try {
      const parsed = asAuditRecord(JSON.parse(text))
      if (parsed === null) throw new Error('bad_audit_record')
      records.push(parsed)
      validBytes = lineEnd
    } catch {
      if (newline === -1) return { records, truncated: true, validBytes }
      // 带换行的坏行：跳过，但推进有效前缀（不反复截断）
      validBytes = lineEnd
    }
    start = lineEnd
  }
  return { records, truncated: false, validBytes }
}

/** 追加前守卫：非空文件末字节必须是换行；否则视为撕裂尾，截到有效前缀（fail-open，不粘行）。 */
function ensureTrailingNewline(file: string): void {
  let size = 0
  try {
    size = statSync(file).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (size === 0) return
  const fd = openSync(file, 'r')
  try {
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    if (tail[0] === 0x0a) return
  } finally {
    closeSync(fd)
  }
  truncateSync(file, readTolerant(file).validBytes)
}

/**
 * 审计旁路侧存：内存索引（有界）+ 单文件持久化。
 * `open` 时由侧存重建索引并截掉撕裂尾；保留窗口外的记录在加载 / 追加时淘汰并随压实从磁盘移除。
 */
export class AuditStore {
  private readonly file: string
  private readonly index: AuditIndex
  private readonly byteTrigger: number
  private readonly recordTrigger: number
  private nextSeq: number
  private sinceCompact = 0
  private recordsSinceCompact = 0

  private constructor(
    file: string,
    index: AuditIndex,
    byteTrigger: number,
    recordTrigger: number,
    nextSeq: number,
  ) {
    this.file = file
    this.index = index
    this.byteTrigger = byteTrigger
    this.recordTrigger = recordTrigger
    this.nextSeq = nextSeq
  }

  /** 打开侧存：缺文件视为空；撕裂尾截到有效前缀；超保留窗口即压实。 */
  static open(file: string, options: AuditStoreOptions = {}): AuditStore {
    const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES
    const maxRecords = options.maxRecords ?? AUDIT_MAX_RECORDS
    const index = new AuditIndex({ maxRecords, maxBytes })
    let nextSeq = 0
    if (existsSync(file)) {
      const read = readTolerant(file)
      if (read.truncated) truncateSync(file, read.validBytes)
      for (const record of read.records) {
        index.add(record)
        if (record.seq >= nextSeq) nextSeq = record.seq + 1
      }
    }
    const store = new AuditStore(
      file,
      index,
      options.maxFileBytes ?? maxBytes,
      maxRecords,
      nextSeq,
    )
    // 载入即淘汰（条数 / 字节超限）或撕裂尾截断：压实一次，令磁盘与保留集一致
    if (index.hadEviction()) store.compact()
    return store
  }

  /** 追加一条审计草稿：分配单调 seq、写侧存并 fsync；写满一个保留窗口即压实。 */
  append(draft: AuditDraft): AuditRecord {
    const record: AuditRecord = { seq: this.nextSeq, at: draft.at, by: draft.by, body: draft.body }
    this.nextSeq += 1
    const line = canonicalJson(record as unknown as Json) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')
    mkdirSync(dirname(this.file), { recursive: true })
    ensureTrailingNewline(this.file)
    const fd = openSync(this.file, 'a')
    try {
      writeSync(fd, line)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.sinceCompact += lineBytes
    this.recordsSinceCompact += 1
    this.index.add(record)
    if (this.sinceCompact >= this.byteTrigger || this.recordsSinceCompact >= this.recordTrigger) {
      this.compact()
    }
    return record
  }

  /** 按过滤条件查询（与入站 `audit` 同形）。 */
  query(filter: AuditFilter): AuditReport {
    return this.index.query(filter)
  }

  /** 保留窗口内的记录（时间正序）。 */
  records(): readonly AuditRecord[] {
    return this.index.records()
  }

  /** 保留窗口内的条数。 */
  size(): number {
    return this.index.size()
  }

  /** 整文件原子重写为保留集：把磁盘压实到保留窗口内。 */
  compact(): void {
    const kept = this.index.records()
    const text =
      kept.length === 0 ? '' : kept.map((r) => canonicalJson(r as unknown as Json)).join('\n') + '\n'
    writeFileAtomic(this.file, text)
    this.sinceCompact = 0
    this.recordsSinceCompact = 0
    this.index.clearEvicted()
  }
}
