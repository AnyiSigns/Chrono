// 机械闸共享纯函数：形态判定与 def 引用解析（机械闸 / 模型读取共用；纯函数，无副作用）。

import type { Json, Rec } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 数组；否则 null。 */
export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 字符串数组：缺省空数组；含非字符串即剔（不抛）。 */
export function asStringArray(value: Json | undefined): string[] {
  const list = asArray(value)
  if (list === null) return []
  return list.filter((item): item is string => typeof item === 'string')
}

/** 有限数值；否则 null。 */
export function numberField(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 从 def 引用 / 裸哈希取哈希；形态非法返回 null。 */
export function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return HASH_RE.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
}
