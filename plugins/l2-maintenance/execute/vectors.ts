// 向量化与按 entry 聚合去重：批量 embedding.embed → 余弦阈值贪心去重。
// 同输入同输出：条目排序由 (at 降序, 来源优先级升序, key 升序) 完全决定；向量由后端确定返回。

import { BackendError } from './types.ts'
import type { EmbeddingBackend } from './port-link.ts'

/** L2 归一；零向量原样返回零向量（不产生 NaN）。 */
export function normalize(vector: number[]): number[] {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return vector.map(() => 0)
  return vector.map((value) => value / norm)
}

/** 余弦（后端已归一，服务侧再归一一遍以兼容未归一的假后端）。 */
export function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index++) sum += left[index] * right[index]
  return sum
}

/** 去重条目：key 唯一；at 降序优先（同 at 取来源优先级小者），再 key 升序，完全确定。 */
export interface DedupItem {
  key: string
  text: string
  at: string
  priority: number
}

export interface DedupResult {
  accepted: DedupItem[]
  duplicates: Array<{ key: string; duplicate_of: string; score: number }>
}

function compareItems(left: DedupItem, right: DedupItem): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1
  if (left.priority !== right.priority) return left.priority - right.priority
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
}

/**
 * 余弦阈值贪心去重：按确定序处理，条目若与任一已接受条目余弦 ≥ 阈值即判重（记 `duplicate_of`）。
 * 每条文本一次 `embedding.embed`（不切块）；空集不调用后端（空集不产生写的前提）。
 * `model` 缺省（null / undefined）时不带 `model`，交由向量化门面按提供方元数据选默认。
 */
export async function dedupByCosine(
  items: DedupItem[],
  threshold: number,
  embedding: EmbeddingBackend,
  model?: string | null,
): Promise<DedupResult> {
  if (items.length === 0) return { accepted: [], duplicates: [] }
  const raw = await embedding.embed(
    items.map((item) => item.text),
    model,
  )
  if (raw.length !== items.length) {
    throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
  }
  const vectors = new Map<string, number[]>()
  items.forEach((item, index) => {
    const vector = raw[index]
    if (!Array.isArray(vector)) {
      throw new BackendError('embedding_bad_result', 'embedding.embed returned a malformed vector')
    }
    vectors.set(item.key, normalize(vector))
  })
  const sorted = [...items].sort(compareItems)
  const accepted: DedupItem[] = []
  const duplicates: Array<{ key: string; duplicate_of: string; score: number }> = []
  for (const item of sorted) {
    let best: { key: string; score: number } | null = null
    for (const kept of accepted) {
      const score = cosine(vectors.get(item.key) ?? [], vectors.get(kept.key) ?? [])
      if (best === null || score > best.score) best = { key: kept.key, score }
    }
    if (best !== null && best.score >= threshold) {
      duplicates.push({ key: item.key, duplicate_of: best.key, score: best.score })
    } else {
      accepted.push(item)
    }
  }
  return { accepted, duplicates }
}
