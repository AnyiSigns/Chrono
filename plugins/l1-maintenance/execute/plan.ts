// 共享纯函数：只做形状归一与时间格式化，不读投影、不取当前时间。

import { BadArgsError } from './types.ts'
import type { Json } from './types.ts'

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
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
