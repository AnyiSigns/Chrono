// 共享纯函数：文本规范化与精确去重。

import type { Json } from 'plugin-sdk'

/** 规范化文本：trim + 空白折叠；非字符串回空串。 */
export function normalizeText(value: Json | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
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
