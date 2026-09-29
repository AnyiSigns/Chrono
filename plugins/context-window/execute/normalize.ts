// 流水线第 1 步收尾：结构化消息 → 规范消息（dedup_key / tokens / cacheKey）。
// 规范化缓存按历史 def 键；计数缓存按 def 键（历史）或原始内容键（合成消息 / parts 被改写的消息），
// 避免每轮重复计算，且保证缓存键与计数输入同口径。
// 消息 token = parts 计数 + 推理块计数 + 工具调用计数；后两者单独记以便分节明细，并按每模型校正系数缩放。

import {
  cachedDedupKey,
  computeContentKey,
  computeDedupKey,
  computeTokenKey,
  countParts,
  reasoningText,
  stableStringify,
} from './text.ts'
import { lookupCount } from './tokens.ts'
import type { CanonicalMessage, RawMessage } from './types.ts'

export interface CanonicalizeOptions {
  /** 每模型 token 校正系数（真实 prompt_tokens / 估算）；缺省 1。 */
  scale?: number
}

/**
 * 把结构化候选补全为规范消息：计算 dedup_key / content_key / tokens。
 */
export function canonicalize(
  raws: RawMessage[],
  options: CanonicalizeOptions = {},
): CanonicalMessage[] {
  const rawScale = options.scale
  const scale =
    typeof rawScale === 'number' && Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1
  const scaled = (value: number): number => Math.max(0, Math.round(value * scale))
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
    const partsTokens = countParts(raw.parts, cacheKey)
    const reasoningTokens =
      raw.reasoning != null ? (lookupCount(reasoningText(raw.reasoning)) ?? 0) : 0
    const toolCallTokens = Array.isArray(raw.toolCalls)
      ? (lookupCount(stableStringify(raw.toolCalls)) ?? 0)
      : 0
    const scaledReasoning = scaled(reasoningTokens)
    const scaledCalls = scaled(toolCallTokens)
    result.push({
      ...raw,
      tokens: scaled(partsTokens) + scaledReasoning + scaledCalls,
      reasoningTokens: scaledReasoning,
      toolCallTokens: scaledCalls,
      dedupKey,
      cacheKey,
      contentKey: computeContentKey(raw.parts),
    })
  }
  return result
}
