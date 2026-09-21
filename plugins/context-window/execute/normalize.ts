// 流水线第 1 步收尾：结构化消息 → 规范消息（dedup_key / conflict_key / tokens / cacheKey）。
// 规范化与计数都按消息 def 键缓存（历史 = ref 哈希；合成消息 = 内容 dedup_key），避免每轮重复计算。

import { cachedDedupKey, computeContentKey, computeDedupKey, countParts, normalizeText } from './text.ts'
import type { CanonicalMessage, RawMessage } from './types.ts'

/**
 * 把结构化候选补全为规范消息：计算 dedup_key / conflict_key / content_key / tokens。
 * `conflict_key` 优先取记忆条目的 `subject`（同键多版本取最新），否则回落 dedup_key。
 */
export function canonicalize(raws: RawMessage[]): CanonicalMessage[] {
  const result: CanonicalMessage[] = []
  for (const raw of raws) {
    const defKey = raw.defKey ?? null
    const dedupKey = defKey !== null ? cachedDedupKey(defKey, raw.role, raw.parts) : computeDedupKey(raw.role, raw.parts)
    const cacheKey = defKey ?? dedupKey
    const tokens = countParts(raw.parts, cacheKey)
    const conflictKey =
      raw.subject !== null && raw.subject.length > 0
        ? `subject:${normalizeText(raw.subject)}`
        : dedupKey
    result.push({ ...raw, tokens, dedupKey, conflictKey, cacheKey, contentKey: computeContentKey(raw.parts) })
  }
  return result
}
