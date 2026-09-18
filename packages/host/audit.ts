// F8 只读审计面：EffectAudit 记录的形状解析、内存索引与机械过滤（按回合 / 身份 / outcome）。
// 只读：不写链、不推进；索引在启动时由「基础世界索引 + journal 尾段」重建，运行期随审计落链增量补齐。
// 过滤是机械 AND；未知键 / 非法值一律拒绝（fail-closed，不猜）。

import type { Entry, Hash, Json } from '../kernel/index.ts'
import { AUDIT_OUTCOMES, EFFECT_AUDIT_KIND } from './effect/execute.ts'

/** 一条审计记录：entry 元信息 + 审计 def 键 + 审计 def body（`{kind:'effect_audit', ...}`）。 */
export interface AuditRecord {
  seq: number
  at: number
  by: string
  /** 审计 def 键（= `H(Def)`；写侧已带，用于从 `world.defs` 寻址 body，不重算哈希）。 */
  hash: Hash
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

export const AUDIT_DEFAULT_LIMIT = 100
export const AUDIT_MAX_LIMIT = 1000

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 机械识别审计 entry（`op:'put'` 且 def body 带保留判别键 `kind:'effect_audit'`）；其余返回 null。 */
export function auditRecordOf(entry: Entry): AuditRecord | null {
  if (entry.op !== 'put') return null
  const def = isRecord(entry.args) ? entry.args : null
  const body = def === null ? undefined : def['body']
  if (!isRecord(body as Json)) return null
  if ((body as { [k: string]: Json })['kind'] !== EFFECT_AUDIT_KIND) return null
  return {
    seq: entry.seq,
    at: entry.at,
    by: entry.by,
    hash: entry.argsHash,
    body: body as Json,
  }
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
 */
export class AuditIndex {
  private readonly log: AuditRecord[] = []
  private readonly byRun = new Map<string, AuditRecord[]>()
  private readonly byEmitter = new Map<string, AuditRecord[]>()
  private readonly byOutcome = new Map<string, AuditRecord[]>()

  add(record: AuditRecord): void {
    this.log.push(record)
    const body = record.body as { [k: string]: Json }
    indexPush(this.byRun, body['run'], record)
    indexPush(this.byEmitter, body['emitter'], record)
    indexPush(this.byOutcome, body['outcome'], record)
  }

  /** 压缩用：紧凑引用（body 由基础世界 `defs[hash]` 取回）。 */
  refs(): { seq: number; at: number; by: string; hash: Hash }[] {
    return this.log.map((record) => ({
      seq: record.seq,
      at: record.at,
      by: record.by,
      hash: record.hash,
    }))
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

  private candidates(filter: AuditFilter): readonly AuditRecord[] {
    if (filter.run !== undefined) return this.byRun.get(filter.run) ?? []
    if (filter.emitter !== undefined) return this.byEmitter.get(filter.emitter) ?? []
    if (filter.outcome !== undefined) return this.byOutcome.get(filter.outcome) ?? []
    return this.log
  }
}

function indexPush(
  map: Map<string, AuditRecord[]>,
  key: Json | undefined,
  record: AuditRecord,
): void {
  if (typeof key !== 'string' || key.length === 0) return
  const list = map.get(key)
  if (list === undefined) map.set(key, [record])
  else list.push(record)
}
