// 向量化与按 entry 聚合去重：切块（#20 chunk）→ 批量向量（#20 embed）→ 余弦阈值贪心去重。
// 同输入同输出：条目排序由 (at 降序, 来源优先级升序, key 升序) 完全决定；向量由后端确定返回。

import { BackendError } from './types.ts'
import type { Chunk, EmbeddingBackend } from './port-link.ts'

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

/** 多个向量的归一化均值（条目代表向量）；空输入回空向量。 */
export function meanNormalized(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = Math.max(...vectors.map((vector) => vector.length))
  const sum = new Array(dim).fill(0)
  for (const vector of vectors) {
    for (let index = 0; index < dim; index++) sum[index] += vector[index] ?? 0
  }
  return normalize(sum.map((value) => value / vectors.length))
}

/** 切块：空块集补一个整段块（与 #20 契约一致）。 */
export async function chunkText(text: string, embedding: EmbeddingBackend): Promise<Chunk[]> {
  const chunks = await embedding.chunk(text)
  if (chunks.length > 0) return chunks
  return [{ index: 0, start: 0, end: [...text].length, text }]
}

export interface Vectorized {
  chunks: Chunk[][]
  /** 与输入等长：每个文本的块向量（已归一）。 */
  vectors: number[][][]
}

/** 批量向量化：每个文本先 `chunk` 再 `embed`（一次批量调用），保持确定序。 */
export async function vectorizeTexts(
  texts: string[],
  embedding: EmbeddingBackend,
  model: string,
): Promise<Vectorized> {
  const chunks: Chunk[][] = []
  const flat: string[] = []
  const owner: number[] = []
  for (const text of texts) {
    const textChunks = await chunkText(text, embedding)
    chunks.push(textChunks)
    for (const chunk of textChunks) {
      flat.push(chunk.text)
      owner.push(chunks.length - 1)
    }
  }
  let raw: number[][] = []
  if (flat.length > 0) {
    raw = await embedding.embed(flat, model)
    if (raw.length !== flat.length) {
      throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
    }
  }
  const vectors: number[][][] = texts.map(() => [])
  owner.forEach((textIndex, position) => {
    vectors[textIndex].push(normalize(raw[position] ?? []))
  })
  return { chunks, vectors }
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
  /** key → 条目代表向量（已归一）。 */
  vectors: Map<string, number[]>
}

function compareItems(left: DedupItem, right: DedupItem): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1
  if (left.priority !== right.priority) return left.priority - right.priority
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
}

/**
 * 余弦阈值贪心去重：按确定序处理，条目若与任一已接受条目余弦 ≥ 阈值即判重（记 `duplicate_of`）。
 * 空集不调用后端（空集不产生写的前提）。
 */
export async function dedupByCosine(
  items: DedupItem[],
  threshold: number,
  embedding: EmbeddingBackend,
  model: string,
): Promise<DedupResult> {
  const vectors = new Map<string, number[]>()
  if (items.length === 0) return { accepted: [], duplicates: [], vectors }
  const vectorized = await vectorizeTexts(
    items.map((item) => item.text),
    embedding,
    model,
  )
  items.forEach((item, index) => {
    vectors.set(item.key, meanNormalized(vectorized.vectors[index]))
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
  return { accepted, duplicates, vectors }
}
