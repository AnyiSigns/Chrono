// 共享纯函数：只做形状归一与时间格式化，不读投影、不取当前时间。

import { BadArgsError } from './types.ts'
import type { Json } from './types.ts'

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 规范化 + 去空 + 精确去重（保序）。 */
export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = item.trim().replace(/\s+/g, ' ')
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 字符串数组：缺省回空数组；含非字符串即拒（结构化 bad_args）。 */
export function asStringList(value: Json | undefined, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadArgsError(`${field} must be an array`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new BadArgsError(`${field} must contain strings`)
    out.push(item)
  }
  return out
}

/** 可选整数字段：缺省回落 fallback；非整数 / 越下界即拒。 */
export function integerField(
  value: Json | undefined,
  field: string,
  fallback: number,
  min: number,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new BadArgsError(`${field} must be an integer`)
  if (value < min) throw new BadArgsError(`${field} must be >= ${min}`)
  return value
}

/** 可选数值字段：缺省回落 fallback；非有限数 / 越界即拒。 */
export function numberField(
  value: Json | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new BadArgsError(`${field} must be a number`)
  if (value < min || value > max) throw new BadArgsError(`${field} must be within [${min}, ${max}]`)
  return value
}

/** ISO 时间归一为 epoch 毫秒；非法回 null。 */
function isoMs(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 时间先后判据：`at` 是否不晚于 `cursor`。
 * 两侧可带不同时区偏移 / 不同精度，故先归一为 epoch 毫秒再比较；无法解析时回落字典序。
 */
export function atOrBefore(at: string, cursor: string): boolean {
  const atMs = isoMs(at)
  const cursorMs = isoMs(cursor)
  if (atMs !== null && cursorMs !== null) return atMs <= cursorMs
  return at <= cursor
}
