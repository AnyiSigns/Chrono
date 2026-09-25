// F8 只读审计面：EffectAudit 记录的形状、有界内存索引与机械过滤（按回合 / 身份 / outcome）。
// 审计不再进世界：记录写 `state/audit/` 下的旁路侧存（`audit-store.ts`），本模块只做内存索引与查询。
// 过滤是机械 AND；未知键 / 非法值一律拒绝（fail-closed，不猜）。
// 保留窗口（条数 / 字节）超限即淘汰最旧；淘汰只影响侧存与热索引，不触及世界状态。

import type { Json } from '../kernel/index.ts'
import { AUDIT_OUTCOMES } from './effect/execute.ts'
import { HOST_CAPABILITY } from './host-methods.ts'

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

/**
 * 审计保留档：一档一组条数 / 字节预算，档内最旧先走。
 * 分档的动机是**隔离高频数据端口**——单一高频端口会把全局窗口冲干净，挤掉模型 / 工具调用的审计。
 */
export interface AuditTier {
  /** 档名（诊断 / 测试用）。 */
  name: string
  /** 端口命中即归此档（按序取首个命中；皆不中归末档 default）。 */
  matches: (port: Json | undefined) => boolean
  maxRecords: number
  maxBytes: number
}

export const AUDIT_TIER_HOST = 'host'
export const AUDIT_TIER_MODEL = 'model'
export const AUDIT_TIER_TOOL = 'tool'
export const AUDIT_TIER_DATA = 'data'
export const AUDIT_TIER_DEFAULT = 'default'

/** 端口是否属于某能力类族：精确名、`<base>.<method>` 或 `<base>-<name>` 前缀。 */
function isPortFamily(port: Json | undefined, base: string): boolean {
  return (
    port === base ||
    (typeof port === 'string' && (port.startsWith(`${base}.`) || port.startsWith(`${base}-`)))
  )
}

/**
 * 缺省分档表：高频数据端口（存储服务，`storage-*`）独立占档，不与模型 / 工具 / `host` 争窗口；
 * 其余端口归 default 档。总预算 ≈ 8000 条 / 5.5 MiB，与单档窗口同量级，但各档互不挤占。
 */
export const AUDIT_TIERS: readonly AuditTier[] = [
  {
    name: AUDIT_TIER_HOST,
    matches: (port) => port === HOST_CAPABILITY,
    maxRecords: 500,
    maxBytes: 512 * 1024,
  },
  {
    name: AUDIT_TIER_MODEL,
    matches: (port) => isPortFamily(port, 'model'),
    maxRecords: 1500,
    maxBytes: 1024 * 1024,
  },
  {
    name: AUDIT_TIER_TOOL,
    matches: (port) => isPortFamily(port, 'tool'),
    maxRecords: 2000,
    maxBytes: 1536 * 1024,
  },
  {
    name: AUDIT_TIER_DATA,
    matches: (port) => isPortFamily(port, 'storage'),
    maxRecords: 3000,
    maxBytes: 2 * 1024 * 1024,
  },
  { name: AUDIT_TIER_DEFAULT, matches: () => true, maxRecords: 1000, maxBytes: 512 * 1024 },
]

export interface AuditIndexOptions {
  maxRecords?: number
  maxBytes?: number
  /** 按端口分档的保留预算；给定时覆盖 `maxRecords` / `maxBytes`（缺省用 `AUDIT_TIERS`）。 */
  tiers?: readonly AuditTier[]
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

/** 一档的保留状态：档内队列（seq 升序）+ 逻辑队首淘汰指针 + 已计字节。 */
interface AuditTierState {
  name: string
  matches: (port: Json | undefined) => boolean
  maxRecords: number
  maxBytes: number
  log: AuditRecord[]
  /** 逻辑队首（档内保留窗口淘汰指针）：避免每次淘汰都 O(n) 挪移；超阈值时压实一次。 */
  head: number
  bytes: number
}

/**
 * 审计内存索引：run / emitter / outcome 三个次级索引（有过滤时先取候选集，避免稀疏过滤下全表倒扫），
 * 保留窗口**按端口分档**（每档各自条数 / 字节预算，档内最旧先走；不分档时退化为单档全局窗口）。
 * 淘汰只丢热索引，侧存由 `AuditStore` 同步压实。
 */
export class AuditIndex {
  private readonly tiers: AuditTierState[]
  private readonly byRun = new Map<string, Set<AuditRecord>>()
  private readonly byEmitter = new Map<string, Set<AuditRecord>>()
  private readonly byOutcome = new Map<string, Set<AuditRecord>>()
  /** 自上次查询后是否发生过淘汰（侧存据此决定是否压实）。 */
  private evicted = false

  constructor(options: AuditIndexOptions = {}) {
    if (options.tiers !== undefined) {
      this.tiers = options.tiers.map((tier) => makeTier(tier))
    } else {
      // 不分档：单档全局窗口，档匹配恒真（保持既有全局保留口径）
      this.tiers = [
        makeTier({
          name: 'all',
          matches: () => true,
          maxRecords: options.maxRecords ?? AUDIT_MAX_RECORDS,
          maxBytes: options.maxBytes ?? AUDIT_MAX_BYTES,
        }),
      ]
    }
  }

  add(record: AuditRecord): void {
    const tier = this.tierOf(record.body)
    tier.log.push(record)
    tier.bytes += bodyBytes(record.body)
    const body = record.body as { [k: string]: Json }
    indexPush(this.byRun, body['run'], record)
    indexPush(this.byEmitter, body['emitter'], record)
    indexPush(this.byOutcome, body['outcome'], record)
    this.evict(tier)
  }

  /** 保留窗口内的记录（时间正序，浅拷贝数组）。 */
  records(): readonly AuditRecord[] {
    if (this.tiers.length === 1) return this.tiers[0].log.slice(this.tiers[0].head)
    const out: AuditRecord[] = []
    for (const tier of this.tiers) {
      for (let i = tier.head; i < tier.log.length; i++) out.push(tier.log[i])
    }
    out.sort((a, b) => a.seq - b.seq)
    return out
  }

  /** 保留窗口内的条数（各档之和）。 */
  size(): number {
    let total = 0
    for (const tier of this.tiers) total += tier.log.length - tier.head
    return total
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

  /** 端口归档：按序取首个命中；皆不中归末档（缺省表末档恒真）。 */
  private tierOf(body: Json): AuditTierState {
    const port = isRecord(body) ? body['port'] : undefined
    for (const tier of this.tiers) {
      if (tier.matches(port)) return tier
    }
    return this.tiers[this.tiers.length - 1]
  }

  /** 档内淘汰：条数 / 字节任一超出即从最旧起逐条移除（O(1) 队首指针，超阈值压实一次）。 */
  private evict(tier: AuditTierState): void {
    while (tier.log.length - tier.head > tier.maxRecords || tier.bytes > tier.maxBytes) {
      const record = tier.log[tier.head]
      if (record === undefined) break
      tier.head += 1
      tier.bytes -= bodyBytes(record.body)
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

function makeTier(tier: AuditTier): AuditTierState {
  return {
    name: tier.name,
    matches: tier.matches,
    maxRecords: tier.maxRecords,
    maxBytes: tier.maxBytes,
    log: [],
    head: 0,
    bytes: 0,
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
