// token 计数客户端：按文本键的有界 LRU 缓存 + 每轮装配的「未命中收集」。
// 计数唯一实现在提供方 `token-estimate`（经反向 `port.call token-estimate.count`）；本侧只缓存与编排，
// 不内嵌 JS 计数。装配按「发现 → 批量补齐」迭代：同步跑一遍收集未命中文本，一次批量 count 补齐缓存，
// 直到某遍零未命中即为确定结果（同输入同输出）。因此热路径一轮装配只发一次批量 count，绝不逐条远程调用。
//
// `def 键 → tokens` 的计数缓存仍住 `text.ts`（历史 def 哈希 / 改写内容键），本模块只负责文本级计数来源。

/** 计数 / 规范化缓存容量上限：超过即淘汰最久未用条目（LRU 近似，Map 插入序）。 */
export const COUNT_CACHE_MAX_ENTRIES = 4096

/** 文本 → token 数的有界缓存（跨装配复用；同文本不重复远程计数）。 */
const countCache = new Map<string, number>()

/** 当前装配轮次的未命中文本集合；非装配期（如单元级直调）为 null。 */
let missing: Set<string> | null = null

/**
 * 进程内计数来源（仅在单元级 / 内嵌直调时注入；生产服务不设，走远程批量 count）。
 * 返回 null 表示该文本本来源无法提供，仍按未命中处理。
 */
let localProvider: ((text: string) => number | null) | null = null

/** 测试 / 内嵌用：注入进程内计数来源；传 null 清除。生产入口不调用。 */
export function setLocalCountProvider(provider: ((text: string) => number | null) | null): void {
  localProvider = provider
}

function cacheSet(key: string, value: number): void {
  if (countCache.has(key)) countCache.delete(key)
  else if (countCache.size >= COUNT_CACHE_MAX_ENTRIES) {
    const oldest = countCache.keys().next().value
    if (oldest !== undefined) countCache.delete(oldest)
  }
  countCache.set(key, value)
}

/** 开启一轮装配的未命中收集。 */
export function beginCountPass(): void {
  missing = new Set()
}

/** 结束一轮装配的未命中收集，返回本轮缺失的文本（去重、保序）。 */
export function endCountPass(): string[] {
  const list = missing === null ? [] : [...missing]
  missing = null
  return list
}

/**
 * 取文本的 token 计数：命中缓存返回之；否则登记未命中并返回 null（调用方按 0 继续，待补齐后重跑）。
 * 有注入的进程内来源时优先由它提供。
 */
export function lookupCount(text: string): number | null {
  if (localProvider !== null) {
    const local = localProvider(text)
    if (local !== null) return local
  }
  const cached = countCache.get(text)
  if (cached !== undefined) {
    cacheSet(text, cached)
    return cached
  }
  if (missing !== null) missing.add(text)
  return null
}

/** 把一批远程计数写回缓存（成功项才写）。 */
export function fillCounts(texts: string[], counts: number[]): void {
  for (let index = 0; index < texts.length; index += 1) {
    const value = counts[index]
    if (typeof value === 'number' && Number.isFinite(value)) cacheSet(texts[index] as string, value)
  }
}

/** 测试用：当前缓存条目数。 */
export function countCacheSize(): number {
  return countCache.size
}

/** 测试用：清空文本计数缓存。 */
export function resetCountCache(): void {
  countCache.clear()
}
