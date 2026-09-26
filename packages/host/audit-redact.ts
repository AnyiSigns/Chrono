// 声明式审计脱敏：从被调身份 `schema` def body 顶层的 `audit_redact` 读方法级白名单键。
// `schema.audit_redact = { "<能力类>.<方法>": ["name", "kind"] }`；精确 `<port>.<method>` 优先，其次裸 `<method>`
// （与 `method_timeouts` 同先例）。命中声明的方法：审计 result 只落白名单键 + 派生 has；未声明落完整结果。
// 声明住在被调身份自己的 schema 里，调用方无从伪造（比按 port 名特判更强）。

import type { Def, Json, World } from '../kernel/index.ts'
import { PROTOTYPE_KEYS, isRecord } from './common/json.ts'

/** 一条脱敏声明：`key` 是原始键（`<能力类>.<方法>` 或裸方法名），`keys` 是白名单键。 */
interface RedactEntry {
  key: string
  keys: string[]
}

/** 按 schema def 对象缓存：def 值对象不可变、跨世界克隆按引用共享，故用对象键而非世界对象。 */
const redactCache = new WeakMap<Def, RedactEntry[]>()

function entriesOfSchema(schemaDef: Def): RedactEntry[] {
  const cached = redactCache.get(schemaDef)
  if (cached !== undefined) return cached
  const entries: RedactEntry[] = []
  const body = schemaDef.body
  const raw = isRecord(body) ? body['audit_redact'] : undefined
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key.length === 0 || PROTOTYPE_KEYS.has(key)) continue
      if (!Array.isArray(value)) continue
      const keys: string[] = []
      let valid = true
      for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || PROTOTYPE_KEYS.has(item)) {
          valid = false
          break
        }
        keys.push(item)
      }
      if (valid) entries.push({ key, keys })
    }
  }
  redactCache.set(schemaDef, entries)
  return entries
}

/**
 * 解析某次调用的审计脱敏白名单：`<port>.<method>` 精确匹配优先，其次裸 `<method>`；
 * 被调身份无声明 / 声明非法返回 `undefined`（审计落完整结果）。
 */
export function resolveAuditRedact(
  world: World,
  identity: string,
  port: string,
  method: string,
): readonly string[] | undefined {
  const record = world.ids[identity]
  if (record === undefined || record.active === null) return undefined
  const schemaDef = world.defs[record.schema]
  if (schemaDef === undefined) return undefined
  const entries = entriesOfSchema(schemaDef)
  const exact = `${port}.${method}`
  let fallback: readonly string[] | undefined
  for (const entry of entries) {
    if (entry.key === exact) return entry.keys
    if (entry.key === method) fallback = entry.keys
  }
  return fallback
}
