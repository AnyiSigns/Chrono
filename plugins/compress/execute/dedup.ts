// 去重：文本 + 向量余弦（向量由向量化服务提供，经反向调用）。
// 向量路径失败时回落精确文本去重——去重是尽力而为，权威重去重归记忆维护服务。
// 纯函数 + 一个可选后端：同文本同向量（向量化确定性）⇒ 同输入同输出。

import { normalizeText, uniqueStrings } from './plan.ts'
import { log } from './frames.ts'
import type { EmbeddingBackend } from './port-link.ts'

/** 去重选项：无后端（或后端失败）时只做精确文本去重。 */
export interface DedupOptions {
  embedding?: EmbeddingBackend
  model: string
  threshold: number
}

export interface DedupResult {
  accepted: string[]
  dedup: 'vector' | 'text'
}

/** 余弦相似度；任一向量为空 / 维度不符回 0（不抛错）。 */
export function cosine(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  for (let index = 0; index < left.length; index++) dot += left[index] * right[index]
  return dot
}

function maxCosine(vector: number[], others: number[][]): number {
  let best = 0
  for (const other of others) {
    const value = cosine(vector, other)
    if (value > best) best = value
  }
  return best
}

/**
 * 从 `incoming` 里挑出与 `reference` 及已接受项都不重复的项（保序）。
 * 有向量后端时用余弦阈值判定近似重复；后端缺失 / 失败回落精确文本去重。
 */
export async function dedupNewItems(
  incoming: string[],
  reference: string[],
  options: DedupOptions,
): Promise<DedupResult> {
  const referenceTexts = uniqueStrings(reference)
  const referenceSet = new Set(referenceTexts.map((text) => normalizeText(text)))
  const candidates = uniqueStrings(incoming).filter((text) => !referenceSet.has(text))
  if (candidates.length === 0) return { accepted: [], dedup: 'text' }

  const needVectors =
    options.embedding !== undefined && (referenceTexts.length > 0 || candidates.length > 1)
  if (!needVectors) return { accepted: candidates, dedup: 'text' }

  let candidateVectors: number[][]
  let referenceVectors: number[][]
  try {
    const all = await options.embedding!.embed([...candidates, ...referenceTexts], options.model)
    candidateVectors = all.slice(0, candidates.length)
    referenceVectors = all.slice(candidates.length)
  } catch (err) {
    // 去重是尽力而为：后端失败回落实属正常降级，但必须留痕以便区分「无后端」与「后端坏」。
    log(`embedding backend failed; falling back to text dedup: ${(err as Error).message}`)
    return { accepted: candidates, dedup: 'text' }
  }

  const accepted: string[] = []
  const acceptedVectors: number[][] = []
  for (let index = 0; index < candidates.length; index++) {
    const vector = candidateVectors[index]
    if (maxCosine(vector, referenceVectors) >= options.threshold) continue
    if (maxCosine(vector, acceptedVectors) >= options.threshold) continue
    accepted.push(candidates[index])
    acceptedVectors.push(vector)
  }
  return { accepted, dedup: 'vector' }
}
