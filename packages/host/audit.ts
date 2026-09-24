// F8 只读审计面：EffectAudit 记录的形状、有界内存索引与机械过滤（按回合 / 身份 / outcome）。
// 审计不再进世界：记录写 `state/audit/` 下的旁路侧存（`audit-store.ts`），本模块只做内存索引与查询。
// 过滤是机械 AND；未知键 / 非法值一律拒绝（fail-closed，不猜）。
// 保留窗口（条数 / 字节）超限即淘汰最旧；淘汰只影响侧存与热索引，不触及世界状态。

import type { Json } from '../kernel/index.ts'
import { AUDIT_OUTCOMES } from './effect/execute.ts'

/** 一条审计记录：侧存持久化与只读面返回的最小形状（`seq` 为侧存单调序）。 */
export interface AuditRecord {
  seq: number
  at: number
  by: string
  /** 审计正文（`{kind:'effect_audit', request, result, port, method, outcome, run, emitter}`）。 */
  body: Json
}

/** 待落侧存的审计草稿：`seq` 由侧存在追加时分配（写入路径不预知侧存序号）。 */
export interface AuditDraft {
  at: number
  by: string
  body: Json
}

/** 过滤条件：三者皆可选、AND；`limit` 缺省 100、上限 1000（按 seq 降序取最新）。 */
export interface AuditFilter {
  run?: string
  emitter?: string
  outcome?: string
  limit?: number
}

export interface AuditReport {
  records: AuditRecord[]
  truncated: boolean
}

/** 只读审计查询面：宿主保留能力类与入站 `audit` 只依赖它，不关心索引 / 侧存实现。 */
export interface AuditQuery {
  query(filter: AuditFilter): AuditReport
}

export const AUDIT_DEFAULT_LIMIT = 100
export const AUDIT_MAX_LIMIT = 1000

/** 审计侧存保留窗口（条数）：超出即淘汰最旧记录（连同磁盘段）。 */
export const AUDIT_MAX_RECORDS = 10_000
/** 审计侧存保留窗口（近似字节，按 body 的 JSON 长度计）：与条数上限任一超出即淘汰。 */
export const AUDIT_MAX_BYTES = 8 * 1024 * 1024

export interface AuditIndexOptions {
  maxRecords?: number
  maxBytes?: number
}

/** 记录体量近似：body 的规范 JSON 字符数（审计体量小，够用且无额外依赖）。 */
function bodyBytes(body: Json): number {
  try {
    return JSON.stringify(body).length
  } catch {
    return 0
  }
}

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析过滤条件；非法（非对象 / 未知键 / 类型不符 / outcome 不在词表 / limit 越界）返回 null。 */
export function parseAuditFilter(value: Json | undefined): AuditFilter | null {
  if (value === undefined || value === null) return {}
  const record = isRecord(value) ? value : null
  if (record === null) return null
  const filter: AuditFilter = {}
  for (const [key, raw] of Object.entries(record)) {
    if (key === 'limit') {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > AUDIT_MAX_LIMIT) {
        return null
      }
      filter.limit = raw
      continue
    }
    if (key === 'run' || key === 'emitter') {
      if (typeof raw !== 'string' || raw.length === 0) return null
      filter[key] = raw
      continue
    }
    if (key === 'outcome') {
      if (typeof raw !== 'string' || !(AUDIT_OUTCOMES as readonly string[]).includes(raw)) {
        return null
      }
      filter.outcome = raw
      continue
    }
    return null
  }
  return filter
}

/**
 * 审计内存索引：全量 log（无过滤查询）+ run / emitter / outcome 三个次级索引
 * （有过滤时先取候选集，避免在稀疏过滤下全表倒扫）。
 * 有界化：超过保留窗口（条数 / 字节）即淘汰最旧记录；淘汰只丢热索引，侧存由 `AuditStore` 同步压实。
 */
export class AuditIndex {
  private readonly log: AuditRecord[] = []
  private readonly byRun = new Map<string, Set<AuditRecord>>()
  private readonly byEmitter = new Map<string, Set<AuditRecord>>()
  private readonly byOutcome = new Map<string, Set<AuditRecord>>()
  private readonly maxRecords: number
  private readonly maxBytes: number
  private bytes = 0
  /** 逻辑队首（保留窗口淘汰指针）：避免每次淘汰都 O(n) 挪移；超阈值时压实一次。 */
  private head = 0
  /** 自上次查询后是否发生过淘汰（侧存据此决定是否压实）。 */
  private evicted = false

  constructor(options: AuditIndexOptions = {}) {
    this.maxRecords = options.maxRecords ?? AUDIT_MAX_RECORDS
    this.maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES
  }

  add(record: AuditRecord): void {
    this.log.push(record)
    const body = record.body as { [k: string]: Json }
    indexPush(this.byRun, body['run'], record)
    indexPush(this.byEmitter, body['emitter'], record)
    indexPush(this.byOutcome, body['outcome'], record)
    this.bytes += bodyBytes(record.body)
    this.evict()
  }

  /** 保留窗口内的记录（时间正序，浅拷贝数组）。 */
  records(): readonly AuditRecord[] {
    return this.log.slice(this.head)
  }

  /** 保留窗口内的条数。 */
  size(): number {
    return this.log.length - this.head
  }

  /** 取上次 `clearEvicted` 以来是否发生过淘汰。 */
  hadEviction(): boolean {
    return this.evicted
  }

  /** 侧存压实后调用：清空淘汰标记。 */
  clearEvicted(): void {
    this.evicted = false
  }

  /** 按过滤条件取最新 N 条（seq 降序）；`truncated` = 还有更多匹配未返回。 */
  query(filter: AuditFilter): AuditReport {
    const limit = filter.limit ?? AUDIT_DEFAULT_LIMIT
    const candidates = this.candidates(filter)
    const records: AuditRecord[] = []
    let truncated = false
    for (let i = candidates.length - 1; i >= 0; i--) {
      const record = candidates[i]
      const body = record.body as { [k: string]: Json }
      if (filter.run !== undefined && body['run'] !== filter.run) continue
      if (filter.emitter !== undefined && body['emitter'] !== filter.emitter) continue
      if (filter.outcome !== undefined && body['outcome'] !== filter.outcome) continue
      if (records.length === limit) {
        truncated = true
        break
      }
      records.push(record)
    }
    return { records, truncated }
  }

  /** 保留窗口淘汰：条数 / 字节任一超出即从最旧起逐条移除（O(1) 队首指针，超阈值压实一次）。 */
  private evict(): void {
    while (this.log.length - this.head > this.maxRecords || this.bytes > this.maxBytes) {
      const record = this.log[this.head]
      if (record === undefined) break
      this.head += 1
      this.bytes -= bodyBytes(record.body)
      this.evicted = true
      indexRemove(this.byRun, record.body as { [k: string]: Json }, 'run', record)
      indexRemove(this.byEmitter, record.body as { [k: string]: Json }, 'emitter', record)
      indexRemove(this.byOutcome, record.body as { [k: string]: Json }, 'outcome', record)
    }
    // 压实：已淘汰前缀不再需要，裁掉防数组无界（仅当占比过半，摊薄 O(n)）
    if (this.head > 1024 && this.head > this.log.length / 2) {
      this.log.splice(0, this.head)
      this.head = 0
    }
  }

  private candidates(filter: AuditFilter): readonly AuditRecord[] {
    if (filter.run !== undefined) return [...(this.byRun.get(filter.run) ?? [])]
    if (filter.emitter !== undefined) return [...(this.byEmitter.get(filter.emitter) ?? [])]
    if (filter.outcome !== undefined) return [...(this.byOutcome.get(filter.outcome) ?? [])]
    return this.log.slice(this.head)
  }
}

function indexPush(
  map: Map<string, Set<AuditRecord>>,
  key: Json | undefined,
  record: AuditRecord,
): void {
  if (typeof key !== 'string' || key.length === 0) return
  const set = map.get(key)
  if (set === undefined) map.set(key, new Set([record]))
  else set.add(record)
}

function indexRemove(
  map: Map<string, Set<AuditRecord>>,
  body: { [k: string]: Json },
  key: string,
  record: AuditRecord,
): void {
  const raw = body[key]
  if (typeof raw !== 'string' || raw.length === 0) return
  map.get(raw)?.delete(record)
}
