// 共享纯函数：schema / args 可调数值的形态判定。本插件不构造世界写计划。

import type { Json } from 'plugin-sdk'

/** 正整数；否则回落缺省（用于 schema / args 的可调数值）。 */
export function positiveInt(value: Json | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return value
}
