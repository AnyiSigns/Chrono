// F8 只读审计面：EffectAudit 记录的形状、有界内存索引与机械过滤（按回合 / 身份 / outcome）。
// 审计不再进世界：记录写 `state/audit/` 下的旁路侧存（`audit-store.ts`），本模块只做内存索引与查询。
// 过滤是机械 AND；未知键 / 非法值一律拒绝（fail-closed，不猜）。
// 保留窗口（条数 / 字节）超限即淘汰最旧；淘汰只影响侧存与热索引，不触及世界状态。

import type { Json } from '../kernel/index.ts'
import { isRecord, jsonByteLength } from './common/json.ts'

/**
 * 审计结局（随审计正文落侧存；审计视图 / 监控按此过滤）：
 * - `ok`：端点有响应且为成功值；
 * - `error`：端点有响应但为错误（`value.error`，term 可据值分支）；
 * - `transport_failed`：没执行（未解析 / 连接 / 帧 / 进程死亡 / 超时）；
 * - `cancelled`：在途被真取消中止（`cancel{run}`；result 记 `{ok:false,error:'cancelled'}`）。
 */
export const AUDIT_OUTCOMES = ['ok', 'error', 'transport_failed', 'cancelled'] as const

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** 审计正文的保留判别键（机械识别审计记录）。 */
export const EFFECT_AUDIT_KIND = 'effect_audit'

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

/** 单档保留窗口缺省（条数）：不分档 / 显式覆盖时使用。 */
export const AUDIT_MAX_RECORDS = 10_000
/** 单档保留窗口缺省（近似字节，按 body 的 JSON 长度计）：与条数上限任一超出即淘汰。 */
export const AUDIT_MAX_BYTES = 8 * 1024 * 1024

/** 声明式分档的单档框架上限：插件自报超上限即截到上限，防绕过审计保留纪律。 */
export const AUDIT_TIER_MAX_RECORDS = 10_000
export const AUDIT_TIER_MAX_BYTES = 8 * 1024 * 1024

/** 一档的保留预算（条数 / 字节）；档内最旧先走。 */
export interface AuditTierBudget {
  maxRecords: number
  maxBytes: number
}

/** 未声明 `audit_tier` 的端口归 default 档。 */
export const AUDIT_TIER_DEFAULT = 'default'

/** 缺省档预算：未声明端口走它。 */
export const AUDIT_DEFAULT_TIER: AuditTierBudget = { maxRecords: 1000, maxBytes: 512 * 1024 }

export interface AuditIndexOptions {
  /** 不分档时的单档全局窗口（测试 / 兼容）；给定时不分档。 */
  maxRecords?: number
  maxBytes?: number
  /**
   * 声明式分档：按端口取当前世界声明（`schema.audit_tier`）的预算；缺省 / 返回 `undefined` → default 档。
   * 每次插入时查，档表随世界变，不在构造时一次性建表。
   */
  tierBudgetOf?: (port: Json | undefined) => AuditTierBudget | undefined
  /** default 档预算；缺省 `AUDIT_DEFAULT_TIER`。 */
  defaultBudget?: AuditTierBudget
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

/** 一档的保留状态：档内队列（seq 升序）+ 逻辑队首淘汰指针 + 已计字节。 */
interface AuditTierState {
  key: string
  maxRecords: number
  maxBytes: number
  log: AuditRecord[]
  /** 逻辑队首（档内保留窗口淘汰指针）：避免每次淘汰都 O(n) 挪移；超阈值时压实一次。 */
  head: number
  bytes: number
}

/**
 * 审计内存索引：run / emitter / outcome 三个次级索引（有过滤时先取候选集，避免稀疏过滤下全表倒扫），
 * 保留窗口**按能力类声明分档**（`schema.audit_tier`；每档各自条数 / 字节预算，档内最旧先走；
 * 未声明端口归 default 档；不分档时退化为单档全局窗口）。
 * 档位在**每次插入时**按当前世界声明解析，档表随世代变，不在构造时一次性建表。
 * 淘汰只丢热索引，侧存由 `AuditStore` 同步压实。
 */
export class AuditIndex {
  /** 不分档时的单档全局窗口；给定时不分档。 */
  private readonly single?: AuditTierState
  private readonly byKey = new Map<string, AuditTierState>()
  private readonly tierBudgetOf?: (port: Json | undefined) => AuditTierBudget | undefined
  private readonly defaultBudget: AuditTierBudget
  private readonly byRun = new Map<string, Set<AuditRecord>>()
  private readonly byEmitter = new Map<string, Set<AuditRecord>>()
  private readonly byOutcome = new Map<string, Set<AuditRecord>>()
  /** 自上次查询后是否发生过淘汰（侧存据此决定是否压实）。 */
  private evicted = false

  constructor(options: AuditIndexOptions = {}) {
    this.defaultBudget = options.defaultBudget ?? AUDIT_DEFAULT_TIER
    if (options.tierBudgetOf === undefined) {
      // 不分档：单档全局窗口（保持既有全局保留口径）
      this.single = makeTierState(
        'all',
        options.maxRecords ?? AUDIT_MAX_RECORDS,
        options.maxBytes ?? AUDIT_MAX_BYTES,
      )
      return
    }
    this.tierBudgetOf = options.tierBudgetOf
  }

  add(record: AuditRecord): void {
    const tier = this.tierOf(record.body)
    tier.log.push(record)
    tier.bytes += jsonByteLength(record.body)
    const body = record.body as { [k: string]: Json }
    indexPush(this.byRun, body['run'], record)
    indexPush(this.byEmitter, body['emitter'], record)
    indexPush(this.byOutcome, body['outcome'], record)
    this.evict(tier)
  }

  /** 保留窗口内的记录（时间正序，浅拷贝数组）。 */
  records(): readonly AuditRecord[] {
    if (this.single !== undefined) return this.single.log.slice(this.single.head)
    const out: AuditRecord[] = []
    for (const tier of this.byKey.values()) {
      for (let i = tier.head; i < tier.log.length; i++) out.push(tier.log[i])
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  /** 保留窗口内的条数（各档之和）。 */
  size(): number {
    if (this.single !== undefined) return this.single.log.length - this.single.head
    let total = 0
    for (const tier of this.byKey.values()) total += tier.log.length - tier.head
    return total
  }

  /** 当前各档预算之和（侧存磁盘压实阈值）。 */
  budgetTotals(): AuditTierBudget {
    if (this.single !== undefined) {
      return { maxRecords: this.single.maxRecords, maxBytes: this.single.maxBytes }
    }
    let maxRecords = this.defaultBudget.maxRecords
    let maxBytes = this.defaultBudget.maxBytes
    for (const tier of this.byKey.values()) {
      maxRecords += tier.maxRecords
      maxBytes += tier.maxBytes
    }
    return { maxRecords, maxBytes }
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

  /**
   * 端口归档：单档时恒回该档；否则按当前世界声明取该能力类的预算（档键 = 能力类名），
   * 未声明归 default 档。档预算随声明变，每次插入按当前声明更新。
   */
  private tierOf(body: Json): AuditTierState {
    if (this.single !== undefined) return this.single
    const port = isRecord(body) ? body['port'] : undefined
    const declared = typeof port === 'string' ? this.tierBudgetOf?.(port) : undefined
    const key = declared !== undefined && typeof port === 'string' ? port : AUDIT_TIER_DEFAULT
    const budget = declared ?? this.defaultBudget
    const existing = this.byKey.get(key)
    if (existing === undefined) {
      const created = makeTierState(key, budget.maxRecords, budget.maxBytes)
      this.byKey.set(key, created)
      return created
    }
    existing.maxRecords = budget.maxRecords
    existing.maxBytes = budget.maxBytes
    return existing
  }

  /** 档内淘汰：条数 / 字节任一超出即从最旧起逐条移除（O(1) 队首指针，超阈值压实一次）。 */
  private evict(tier: AuditTierState): void {
    while (tier.log.length - tier.head > tier.maxRecords || tier.bytes > tier.maxBytes) {
      const record = tier.log[tier.head]
      if (record === undefined) break
      tier.head += 1
      tier.bytes -= jsonByteLength(record.body)
      this.evicted = true
      indexRemove(this.byRun, record.body as { [k: string]: Json }, 'run', record)
      indexRemove(this.byEmitter, record.body as { [k: string]: Json }, 'emitter', record)
      indexRemove(this.byOutcome, record.body as { [k: string]: Json }, 'outcome', record)
    }
    // 压实：已淘汰前缀不再需要，裁掉防数组无界（仅当占比过半，摊薄 O(n)）
    if (tier.head > 1024 && tier.head > tier.log.length / 2) {
      tier.log.splice(0, tier.head)
      tier.head = 0
    }
  }

  private candidates(filter: AuditFilter): readonly AuditRecord[] {
    if (filter.run !== undefined) return [...(this.byRun.get(filter.run) ?? [])]
    if (filter.emitter !== undefined) return [...(this.byEmitter.get(filter.emitter) ?? [])]
    if (filter.outcome !== undefined) return [...(this.byOutcome.get(filter.outcome) ?? [])]
    return this.records()
  }
}

function makeTierState(key: string, maxRecords: number, maxBytes: number): AuditTierState {
  return { key, maxRecords, maxBytes, log: [], head: 0, bytes: 0 }
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
