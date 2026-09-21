// 方法级调用超时：从世界读各身份 `schema` def body 顶层的 `method_timeouts` 声明，
// 按 (身份, 能力类, 方法) 解析单次调用的等待上限——优先级「方法级 > 进程级 > 常量」。
// 声明非法只记 invalid（由宿主落运维日志）、按无覆盖处理，不阻断其余身份 / 方法。

import type { Json, World } from '../kernel/index.ts'
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

/** 按世界对象缓存各身份的声明条目：同一世界视图内多次调用不重复读 schema。 */
const entriesCache = new WeakMap<World, Map<string, MethodTimeoutEntry[]>>()

function entriesOfIdentity(world: World, identity: string): MethodTimeoutEntry[] | undefined {
  let byIdentity = entriesCache.get(world)
  if (byIdentity === undefined) {
    byIdentity = new Map()
    for (const entry of readMethodTimeouts(world).entries) {
      const list = byIdentity.get(entry.identity)
      if (list === undefined) byIdentity.set(entry.identity, [entry])
      else list.push(entry)
    }
    entriesCache.set(world, byIdentity)
  }
  return byIdentity.get(identity)
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
