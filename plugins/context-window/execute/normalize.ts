// 流水线第 1 步收尾：结构化消息 → 规范消息（dedup_key / conflict_key / tokens / cacheKey）。
// 规范化缓存按历史 def 键；计数缓存按 def 键（历史）或原始内容键（合成消息 / parts 被改写的消息），
// 避免每轮重复计算，且保证缓存键与计数输入同口径。

import { cachedDedupKey, computeContentKey, computeDedupKey, computeTokenKey, countParts, normalizeText } from './text.ts'
import type { CanonicalMessage, RawMessage } from './types.ts'

/**
 * 把结构化候选补全为规范消息：计算 dedup_key / conflict_key / content_key / tokens。
 * `conflict_key` 优先取记忆条目的 `subject`（同键多版本取最新），否则回落 dedup_key。
 */
export function canonicalize(raws: RawMessage[]): CanonicalMessage[] {
  const result: CanonicalMessage[] = []
  for (const raw of raws) {
    const defKey = raw.defKey ?? null
    const tokenKey = raw.tokenKey ?? null
    // parts 被改写时 tokenKey 非空：不得按 def 键复用规范化缓存，否则与未改写形态串 dedup_key。
    const dedupKey =
      tokenKey !== null || defKey === null
        ? computeDedupKey(raw.role, raw.parts)
        : cachedDedupKey(defKey, raw.role, raw.parts)
    // 计数缓存键必须与计数输入同口径：改写用改写后内容键，历史用 def 哈希，合成消息用原始内容键。
    const cacheKey = tokenKey ?? defKey ?? computeTokenKey(raw.parts)
    const tokens = countParts(raw.parts, cacheKey)
    const conflictKey =
      raw.subject !== null && raw.subject.length > 0
        ? `subject:${normalizeText(raw.subject)}`
        : dedupKey
    result.push({ ...raw, tokens, dedupKey, conflictKey, cacheKey, contentKey: computeContentKey(raw.parts) })
  }
  return result
}
