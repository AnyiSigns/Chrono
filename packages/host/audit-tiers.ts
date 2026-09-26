// 声明式审计分档：从各身份 `schema` def body 顶层的 `audit_tier` 读每能力类的保留预算。
// `schema.audit_tier = { "<能力类>": { max_records, max_bytes } }`；未声明端口走 default 档。
// 声明值超框架上限即截到上限（防插件自报超大预算绕过审计保留纪律）；非法条目按未声明处理。

import type { Def, Json, World } from '../kernel/index.ts'
import { AUDIT_TIER_MAX_BYTES, AUDIT_TIER_MAX_RECORDS } from './audit.ts'
import type { AuditTierBudget } from './audit.ts'
import { PROTOTYPE_KEYS, isRecord } from './common/json.ts'

/** 声明值截到框架上限；非正整数 / 缺失 → undefined（按未声明处理）。 */
function capBudget(value: Json | undefined): AuditTierBudget | undefined {
  if (!isRecord(value)) return undefined
  const maxRecords = value['max_records']
  const maxBytes = value['max_bytes']
  if (typeof maxRecords !== 'number' || !Number.isInteger(maxRecords) || maxRecords <= 0) {
    return undefined
  }
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes <= 0) return undefined
  return {
    maxRecords: Math.min(maxRecords, AUDIT_TIER_MAX_RECORDS),
    maxBytes: Math.min(maxBytes, AUDIT_TIER_MAX_BYTES),
  }
}

/**
 * 按 schema def 对象缓存解析结果：def 值对象不可变、跨世界克隆按引用共享，故用对象键而非世界对象。
 * 内层按能力类名索引；同 schema 多身份共享一份。
 */
const tiersCache = new WeakMap<Def, Map<string, AuditTierBudget>>()

function tiersOfSchema(schemaDef: Def): Map<string, AuditTierBudget> {
  const cached = tiersCache.get(schemaDef)
  if (cached !== undefined) return cached
  const byCap = new Map<string, AuditTierBudget>()
  const body = schemaDef.body
  const raw = isRecord(body) ? body['audit_tier'] : undefined
  if (isRecord(raw)) {
    for (const [cap, value] of Object.entries(raw)) {
      if (cap.length === 0 || PROTOTYPE_KEYS.has(cap)) continue
      const budget = capBudget(value)
      if (budget !== undefined) byCap.set(cap, budget)
    }
  }
  tiersCache.set(schemaDef, byCap)
  return byCap
}

/**
 * 解析某能力类的审计保留预算：扫全部 active 身份的 `schema` 声明，返回首个命中。
 * retired（`active=null`）身份跳过；无声明返回 `undefined`（调用方归 default 档）。
 */
export function resolveAuditTier(world: World, port: string): AuditTierBudget | undefined {
  for (const identity of Object.keys(world.ids)) {
    const record = world.ids[identity]
    if (record.active === null) continue
    const schemaDef = world.defs[record.schema]
    if (schemaDef === undefined) continue
    const found = tiersOfSchema(schemaDef).get(port)
    if (found !== undefined) return found
  }
  return undefined
}
