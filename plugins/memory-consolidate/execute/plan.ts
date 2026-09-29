// 共享纯函数：只做时间格式化与参数形态校验，不读投影、不取当前时间。

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
