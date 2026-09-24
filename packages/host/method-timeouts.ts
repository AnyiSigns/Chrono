// 方法级调用超时：从世界读各身份 `schema` def body 顶层的 `method_timeouts` 声明，
// 按 (身份, 能力类, 方法) 解析单次调用的等待上限——优先级「方法级 > 进程级 > 常量」。
// 声明非法只记 invalid（由宿主落运维日志）、按无覆盖处理，不阻断其余身份 / 方法。

import type { Def, Json, World } from '../kernel/index.ts'
import { MAX_CALL_TIMEOUT_MS } from './service-link.ts'

/**
 * 一条方法级超时声明：`key` 是声明的原始键——`<能力类>.<方法>` 或裸方法名。
 * 能力类名本身可含点（如 `toy.slow`），故解析期不切分键，解析时按原键机械匹配。
 */
export interface MethodTimeoutEntry {
  identity: string
  key: string
  timeoutMs: number
}

export interface MethodTimeoutRead {
  entries: MethodTimeoutEntry[]
  invalid: { identity: string; reason: string }[]
}

/** JS 原型键：作为声明键出现即拒（否则赋值 / 读取会命中原型成员）。 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析一个身份的 `method_timeouts` 声明；非法条目只记 invalid，不影响同身份其它条目。 */
function parseMethodTimeouts(
  identity: string,
  raw: Json,
  invalid: MethodTimeoutRead['invalid'],
): MethodTimeoutEntry[] {
  if (!isRecord(raw)) {
    invalid.push({ identity, reason: 'bad_method_timeouts' })
    return []
  }
  const entries: MethodTimeoutEntry[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || UNSAFE_KEYS.has(key)) {
      invalid.push({ identity, reason: 'bad_timeout_key' })
      continue
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      invalid.push({ identity, reason: 'bad_timeout_ms' })
      continue
    }
    // 超过计时器硬上限的值会让 `setTimeout` 溢出成立即触发，按非法声明处理（无覆盖）
    if (value > MAX_CALL_TIMEOUT_MS) {
      invalid.push({ identity, reason: 'bad_timeout_ms' })
      continue
    }
    entries.push({ identity, key, timeoutMs: value })
  }
  return entries
}

/**
 * 从世界读全部方法级超时声明（按身份 id 排序，确定性）：`schema` def body 的顶层 `method_timeouts`。
 * retired（`active=null`）身份跳过；声明非法只记 invalid，不影响其余身份 / 方法。
 */
export function readMethodTimeouts(world: World): MethodTimeoutRead {
  const entries: MethodTimeoutEntry[] = []
  const invalid: MethodTimeoutRead['invalid'] = []
  for (const identity of Object.keys(world.ids).sort()) {
    const record = world.ids[identity]
    if (record.active === null) continue
    const body = world.defs[record.schema]?.body
    if (!isRecord(body)) continue
    const raw = body['method_timeouts']
    if (raw === undefined) continue
    entries.push(...parseMethodTimeouts(identity, raw, invalid))
  }
  return { entries, invalid }
}

/**
 * 按 schema def 对象缓存各身份的声明条目：def 值对象不可变、跨世界克隆（含审计落账的 defs 层克隆）
 * 按引用共享，故用对象键而非世界对象——审计克隆不再击穿缓存。内层按身份 id 区分（同 schema 多身份）。
 * 退役（active=null）身份不缓存（其可用性随 active 变），每次按当前世界机械判定。
 */
const entriesCache = new WeakMap<Def, Map<string, MethodTimeoutEntry[] | null>>()

function entriesOfIdentity(world: World, identity: string): MethodTimeoutEntry[] | undefined {
  const record = world.ids[identity]
  if (record === undefined || record.active === null) return undefined
  const schemaDef = world.defs[record.schema]
  if (schemaDef === undefined) return undefined
  let byIdentity = entriesCache.get(schemaDef)
  if (byIdentity === undefined) {
    byIdentity = new Map()
    entriesCache.set(schemaDef, byIdentity)
  }
  const cached = byIdentity.get(identity)
  if (cached !== undefined) return cached ?? undefined
  const body = schemaDef.body
  const raw = isRecord(body) ? body['method_timeouts'] : undefined
  if (raw === undefined) {
    byIdentity.set(identity, null)
    return undefined
  }
  const entries = parseMethodTimeouts(identity, raw, [])
  byIdentity.set(identity, entries)
  return entries
}

/**
 * 解析单次调用的方法级超时覆盖：`<port>.<method>` 精确匹配优先，其次裸 `method`（全局匹配）；
 * 无声明 / 声明非法返回 `undefined`（调用方回落到进程级 / 常量）。
 */
export function resolveMethodTimeoutMs(
  world: World,
  identity: string,
  port: string,
  method: string,
): number | undefined {
  const entries = entriesOfIdentity(world, identity)
  if (entries === undefined) return undefined
  const exact = `${port}.${method}`
  let fallback: number | undefined
  for (const entry of entries) {
    if (entry.key === exact) return entry.timeoutMs
    if (entry.key === method) fallback = entry.timeoutMs
  }
  return fallback
}
