// 文本规范化、记忆渲染、token 计数缓存与前缀和。
// 计数缓存按消息 def 键（历史 = ref 哈希；合成消息 = 规范化 dedup_key）缓存，避免每轮全量重算；
// 前缀和用于历史窗口 / atomic 组的区间求和不重复遍历。

import { countTokens } from './native.ts'
import type { AssetRef, CanonicalPart, Json } from './types.ts'

/** 判断普通对象（非数组、非 null）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 规范化文本：统一换行、压缩连续空白、去首尾空白（dedup_key 的组成部分）。 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
}

/** 拼接文本 parts（非文本 part 不计入文本，另按 1 token 引用开销计）。 */
export function partsText(parts: CanonicalPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text') chunks.push(part.text)
  }
  return chunks.join('\n')
}

/** 非文本 part 数量（每个资产引用按 1 token 开销计）。 */
export function assetPartCount(parts: CanonicalPart[]): number {
  let count = 0
  for (const part of parts) {
    if (part.type !== 'text') count += 1
  }
  return count
}

/** 由角色 + parts 生成规范化 dedup_key（非哈希，纯字符串）。 */
export function computeDedupKey(role: string, parts: CanonicalPart[]): string {
  const pieces = parts.map((part) =>
    part.type === 'text' ? normalizeText(part.text) : `${part.type}:${part.asset.sha256}`,
  )
  return `${role}|${pieces.join('\u0001')}`
}

/** 仅规范化内容（不含角色）：跨来源去重用。 */
export function computeContentKey(parts: CanonicalPart[]): string {
  const pieces = parts.map((part) =>
    part.type === 'text' ? normalizeText(part.text) : `${part.type}:${part.asset.sha256}`,
  )
  return pieces.join('\u0001')
}

/**
 * 计数 / 规范化缓存容量上限：超过即淘汰最久未用条目（LRU 近似，Map 插入序）。
 * 缓存键含历史 def 哈希，长驻服务若不设限会随会话单调增长。
 */
export const CACHE_MAX_ENTRIES = 4096

/** 写入有界缓存：已满且为新键时淘汰最旧条目；命中时刷新到队尾（最近使用）。 */
function cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.has(key)) cache.delete(key)
  else if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/** 规范化结果缓存：def 键 → dedup_key（同 def 只规范化一次；有界）。 */
const normalizeCache = new Map<string, string>()

/** token 计数缓存：def 键 → tokens（有界）。 */
const tokenCache = new Map<string, number>()

/**
 * 计数一个消息的 tokens：文本走原生 tokenizer，资产引用按 1 token/个计。
 * `cacheKey` = 消息 def 键（历史 ref 哈希或 dedup_key）；命中缓存直接返回。
 */
export function countParts(parts: CanonicalPart[], cacheKey: string): number {
  const cached = tokenCache.get(cacheKey)
  if (cached !== undefined) {
    cacheSet(tokenCache, cacheKey, cached)
    return cached
  }
  const tokens = countTokens(partsText(parts)) + assetPartCount(parts)
  cacheSet(tokenCache, cacheKey, tokens)
  return tokens
}

/** 读取 / 计算规范化 dedup_key 并缓存。 */
export function cachedDedupKey(cacheKey: string, role: string, parts: CanonicalPart[]): string {
  const cached = normalizeCache.get(cacheKey)
  if (cached !== undefined) {
    cacheSet(normalizeCache, cacheKey, cached)
    return cached
  }
  const key = computeDedupKey(role, parts)
  cacheSet(normalizeCache, cacheKey, key)
  return key
}

/** 测试用：当前缓存条目数。 */
export function cacheSizes(): { normalize: number; tokens: number } {
  return { normalize: normalizeCache.size, tokens: tokenCache.size }
}

/** 前缀和：`sums[i]` = 前 i 项之和，长度 = values.length + 1。 */
export function prefixSums(values: number[]): number[] {
  const sums = new Array<number>(values.length + 1)
  sums[0] = 0
  for (let index = 0; index < values.length; index += 1) {
    sums[index + 1] = (sums[index] as number) + (values[index] as number)
  }
  return sums
}

/** 区间求和 [start, end)。 */
export function rangeSum(sums: number[], start: number, end: number): number {
  const from = Math.max(0, Math.min(start, sums.length - 1))
  const to = Math.max(from, Math.min(end, sums.length - 1))
  return (sums[to] as number) - (sums[from] as number)
}

/** 解析时间：ISO 字符串 / epoch 毫秒数字 → 毫秒；非法为 0。 */
export function parseAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/** 解析 `expires_at`（数字毫秒或 ISO 字符串）；非法返回 null。 */
export function parseExpiresAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/** 把资产引用收敛成规范形状。 */
export function asAssetRef(value: unknown): AssetRef | null {
  if (!isRecord(value)) return null
  const sha256 = value['sha256']
  const mime = value['mime']
  if (typeof sha256 !== 'string' || sha256.length === 0) return null
  if (typeof mime !== 'string' || mime.length === 0) return null
  const size = value['size']
  const ref: AssetRef = { sha256, mime }
  if (typeof size === 'number' && Number.isFinite(size)) ref.size = size
  return ref
}

/** 记忆摘要字段的中文标签（渲染顺序固定）。 */
const SUMMARY_FIELDS: [string, string][] = [
  ['goal', '目标'],
  ['decisions', '决策'],
  ['facts', '关键事实'],
  ['open_questions', '未决问题'],
  ['files', '涉及文件'],
  ['next_steps', '下一步'],
]

/** 把结构化摘要渲染成确定文本；字符串原样返回；缺字段跳过。 */
export function renderSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary
  if (!isRecord(summary)) return ''
  const lines: string[] = []
  for (const [key, label] of SUMMARY_FIELDS) {
    const value = summary[key]
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`${label}：${value}`)
      continue
    }
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      if (items.length > 0) {
        lines.push(`${label}：`)
        for (const item of items) lines.push(`- ${item}`)
      }
    }
  }
  return lines.join('\n')
}

/** 渲染记忆切片为一条消息文本。 */
export function renderMemory(title: string, summary: unknown): string {
  const body = renderSummary(summary)
  return body.length > 0 ? `[${title}]\n${body}` : `[${title}]`
}

/** 填充 `{key}` 占位（policy 文案模板）。 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] as string) : match,
  )
}

/** 深拷贝 JSON（保证返回值不被调用方改动影响内部状态）。 */
export function cloneJson<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
