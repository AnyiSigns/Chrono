// 共享纯函数：文本规范化、字符串数组校验与精确去重。摘要形状不构造任何世界写计划。

import { BadArgsError } from 'plugin-sdk'
import type { Json } from 'plugin-sdk'

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
