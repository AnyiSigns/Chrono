// 效果审计旁路侧存：审计记录写 `state/audit/audit.jsonl`（不进世界、不进链、不参与重放）。
// 单文件追加 + 上限压实：保留窗口**按端口分档**（每档各自条数 / 字节预算，档内最旧先走；见 `audit.ts`），
// 再写满各档预算之和（条数或字节）即整文件原子重写为保留集，故磁盘至多 ≈ 保留集 + 一个总窗口，恒有界。
// 半写安全：每条一次写且以换行收尾；追加的 fsync 按累计字节批量做（审计是旁路，不必每条同步落盘），
// 压实时整文件原子重写（自带 fsync）。启动 / 追加前容错读，末行撕裂即截到有效前缀。
// 单写者：追加是同步的，宿主单进程串行调用，故无并发交错。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, truncateSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'
import { AuditIndex } from './audit.ts'
import type { AuditDraft, AuditFilter, AuditReport, AuditRecord, AuditTierBudget } from './audit.ts'
import { writeAllSync, writeFileAtomic } from './common/fs-atomic.ts'
import { isRecord } from './common/json.ts'
import { endsWithNewline, readJsonlFile } from './common/jsonl.ts'

/** 批量 fsync 的累计字节阈值：达到即同步一次；压实（原子重写）另自带 fsync。 */
const AUDIT_FSYNC_BYTES = 256 * 1024

export interface AuditStoreOptions {
  /** 不分档时的单档条数窗口；给定即退化为单档全局窗口（测试 / 兼容用）。 */
  maxRecords?: number
  /** 不分档时的单档字节窗口。 */
  maxBytes?: number
  /** 声明式分档：按端口取当前世界声明的预算；缺省时按单档全局窗口（`maxRecords` / `maxBytes`）。 */
  tierBudgetOf?: (port: Json | undefined) => AuditTierBudget | undefined
}

interface TolerantRead {
  records: AuditRecord[]
  /** 末行无换行且解析失败（撕裂尾）：调用方应截到 `validBytes`。 */
  truncated: boolean
  /** 有效前缀字节长度（含末条完整行的换行）。 */
  validBytes: number
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
  const read = readJsonlFile(file, {
    parse: (line) => {
      const parsed = asAuditRecord(JSON.parse(line))
      if (parsed === null) throw new Error('bad_audit_record')
      return parsed
    },
    strict: false,
  })
  return { records: read.items, truncated: read.truncated, validBytes: read.validBytes }
}

/** 追加前守卫：非空文件末字节必须是换行；否则视为撕裂尾，截到有效前缀（fail-open，不粘行）。 */
function ensureTrailingNewline(file: string): void {
  if (endsWithNewline(file)) return
  truncateSync(file, readTolerant(file).validBytes)
}

/**
 * 审计旁路侧存：内存索引（有界）+ 单文件持久化。
 * `open` 时由侧存重建索引并截掉撕裂尾；保留窗口外的记录在加载 / 追加时淘汰并随压实从磁盘移除。
 */
export class AuditStore {
  private readonly file: string
  private readonly index: AuditIndex
  private nextSeq: number
  private sinceCompact = 0
  private sinceFsync = 0
  private recordsSinceCompact = 0

  private constructor(file: string, index: AuditIndex, nextSeq: number) {
    this.file = file
    this.index = index
    this.nextSeq = nextSeq
  }

  /** 打开侧存：缺文件视为空；撕裂尾截到有效前缀；超保留窗口即压实。 */
  static open(file: string, options: AuditStoreOptions = {}): AuditStore {
    // 未给声明式分档解析器 ⇒ 单档全局窗口（测试 / 兼容）；否则按端口声明分档。
    const index =
      options.tierBudgetOf === undefined
        ? new AuditIndex({ maxRecords: options.maxRecords, maxBytes: options.maxBytes })
        : new AuditIndex({ tierBudgetOf: options.tierBudgetOf })
    let nextSeq = 0
    if (existsSync(file)) {
      const read = readTolerant(file)
      if (read.truncated) truncateSync(file, read.validBytes)
      for (const record of read.records) {
        index.add(record)
        if (record.seq >= nextSeq) nextSeq = record.seq + 1
      }
    }
    const store = new AuditStore(file, index, nextSeq)
    // 载入即淘汰（条数 / 字节超限）或撕裂尾截断：压实一次，令磁盘与保留集一致
    if (index.hadEviction()) store.compact()
    return store
  }

  /** 追加一条审计草稿：分配单调 seq、写侧存；累计到阈值才 fsync；写满一个保留窗口即压实。 */
  append(draft: AuditDraft): AuditRecord {
    const record: AuditRecord = { seq: this.nextSeq, at: draft.at, by: draft.by, body: draft.body }
    this.nextSeq += 1
    const line = canonicalJson(record as unknown as Json) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')
    mkdirSync(dirname(this.file), { recursive: true })
    ensureTrailingNewline(this.file)
    this.sinceFsync += lineBytes
    const fd = openSync(this.file, 'a')
    try {
      writeAllSync(fd, line)
      if (this.sinceFsync >= AUDIT_FSYNC_BYTES) {
        fsyncSync(fd)
        this.sinceFsync = 0
      }
    } finally {
      closeSync(fd)
    }
    this.sinceCompact += lineBytes
    this.recordsSinceCompact += 1
    this.index.add(record)
    const totals = this.index.budgetTotals()
    if (this.sinceCompact >= totals.maxBytes || this.recordsSinceCompact >= totals.maxRecords) {
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
      kept.length === 0
        ? ''
        : kept.map((r) => canonicalJson(r as unknown as Json)).join('\n') + '\n'
    writeFileAtomic(this.file, text)
    this.sinceCompact = 0
    this.sinceFsync = 0
    this.recordsSinceCompact = 0
    this.index.clearEvicted()
  }
}
