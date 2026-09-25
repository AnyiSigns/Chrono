// 共享纯函数：JSON 形态判定与字段取值。L1 / L2 已出世界，本文件不构造写计划。

import type { CallEnv, Json } from './types.ts'

export type Rec = { [key: string]: Json }

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}
