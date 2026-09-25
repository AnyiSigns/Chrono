// 共享纯函数：JSON 形态判定、文本规范化与结构化错误值。压缩产物已出世界，本文件不构造写计划。

import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 规范化文本：trim + 空白折叠；非字符串回空串。 */
export function normalizeText(value: Json | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
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

/** 规范化 + 去空 + 精确去重（保序）。 */
export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = normalizeText(item)
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 帧 env 的固定时钟；env 缺失时回落 args.now，绝不自取时钟。 */
export function nowOf(env: CallEnv, args: Rec): number {
  if (typeof env.now === 'number' && Number.isFinite(env.now)) return env.now
  const fallback = args['now']
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}
