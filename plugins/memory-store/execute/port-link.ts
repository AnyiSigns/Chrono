// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `needs` 含 `embedding`（向量化）、`tokenizer`（切块）与 `vector-index`（③ 索引）：
// 建 / 重建索引与 put 去重经 `port.call tokenizer.chunk` + `embedding.embed`；
// 索引读写与 top-k 经 `port.call vector-index.*`（只经逻辑 key 往返，哈希映射留在本服务）。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from './plan.ts'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** 窗口切块结果（`tokenizer.chunk` 的出参；start / end 为 Unicode 码点偏移）。 */
export interface Chunk {
  index: number
  start: number
  end: number
  text: string
}

/** `embedding.embed` 出参：与 texts 一一对应、每维 dim、已 L2 归一。 */
export interface EmbeddingResult {
  model: string
  dim: number
  vectors: number[][]
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<EmbeddingResult>
}

/** 切块后端抽象：生产环境是反向调用 `tokenizer.chunk`，单测注入假后端。 */
export interface TokenizerBackend {
  chunk(text: string): Promise<Chunk[]>
}

/** `embedding.embed` 的反向调用后端：成功回 {model, dim, vectors}。 */
export class RemoteEmbedding implements EmbeddingBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async embed(texts: string[], model: string): Promise<EmbeddingResult> {
    const outcome = await this.link.call('embedding', 'embed', { texts, model })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    const value = outcome.value
    if (!isRecord(value) || !Array.isArray(value['vectors'])) {
      throw new BackendError('embedding_bad_result', 'embedding.embed returned no vectors')
    }
    const vectors: number[][] = []
    for (const vector of value['vectors'] as Json[]) {
      if (!Array.isArray(vector) || vector.some((item) => typeof item !== 'number')) {
        throw new BackendError(
          'embedding_bad_result',
          'embedding.embed returned a malformed vector',
        )
      }
      vectors.push(vector as number[])
    }
    if (vectors.length !== texts.length) {
      throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
    }
    return {
      model: typeof value['model'] === 'string' ? (value['model'] as string) : model,
      dim:
        typeof value['dim'] === 'number'
          ? (value['dim'] as number)
          : vectors.length > 0
            ? vectors[0].length
            : 0,
      vectors,
    }
  }
}

/** `tokenizer.chunk` 的反向调用后端：成功回 [{index,start,end,text}]。 */
export class RemoteTokenizer implements TokenizerBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async chunk(text: string): Promise<Chunk[]> {
    const outcome = await this.link.call('tokenizer', 'chunk', { text })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    const value = outcome.value
    if (!Array.isArray(value)) {
      throw new BackendError('tokenizer_bad_result', 'tokenizer.chunk returned a non-array')
    }
    const chunks: Chunk[] = []
    for (const item of value) {
      if (
        !isRecord(item) ||
        typeof item['index'] !== 'number' ||
        typeof item['start'] !== 'number' ||
        typeof item['end'] !== 'number' ||
        typeof item['text'] !== 'string'
      ) {
        throw new BackendError('tokenizer_bad_result', 'tokenizer.chunk returned a malformed chunk')
      }
      chunks.push({
        index: item['index'] as number,
        start: item['start'] as number,
        end: item['end'] as number,
        text: item['text'] as string,
      })
    }
    return chunks
  }
}

/** 索引记录（`vector-index` 的往返形状：逻辑 key + 块号 + 向量）。 */
export interface VectorRecord {
  key: string
  chunk_index: number
  vector: number[]
}

/** 索引命中（`vector-index.search` 出参：只含逻辑 key）。 */
export interface VectorHit {
  key: string
  chunk_index: number
  score: number
}

/** 索引描述（不含记录）：消费方版本计数在 `count`。 */
export interface VectorIndexMeta {
  modelId: string
  dim: number
  count: number
}

/** 索引全量描述（含记录）：供消费方做覆盖判据与去重。 */
export interface VectorIndexInfo extends VectorIndexMeta {
  records: VectorRecord[]
}

/** 向量索引后端抽象：生产环境是反向调用 `vector-index.*`，单测注入假后端。 */
export interface VectorIndexBackend {
  upsert(input: {
    model: string
    dim: number
    count: number
    records: VectorRecord[]
  }): Promise<VectorIndexMeta>
  remove(keys: string[]): Promise<void>
  search(query: number[], topK: number): Promise<VectorHit[]>
  /** 无索引（未建 / 已清）回 null。 */
  info(): Promise<VectorIndexInfo | null>
  clear(): Promise<void>
}

function integerField(value: Json | undefined, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new BackendError('vector_index_bad_result', `vector-index returned a bad ${field}`)
  }
  return value
}

function parseMeta(value: Json): VectorIndexMeta {
  if (!isRecord(value)) {
    throw new BackendError('vector_index_bad_result', 'vector-index returned a non-object')
  }
  return {
    modelId: typeof value['model'] === 'string' ? (value['model'] as string) : '',
    dim: integerField(value['dim'], 'dim', 1),
    count: integerField(value['count'], 'count', 0),
  }
}

function parseRecords(value: Json | undefined): VectorRecord[] {
  if (!Array.isArray(value)) {
    throw new BackendError('vector_index_bad_result', 'vector-index returned no records')
  }
  const out: VectorRecord[] = []
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['key'] !== 'string' ||
      typeof item['chunk_index'] !== 'number' ||
      !Array.isArray(item['vector']) ||
      item['vector'].some((part) => typeof part !== 'number')
    ) {
      throw new BackendError('vector_index_bad_result', 'vector-index returned a malformed record')
    }
    out.push({
      key: item['key'] as string,
      chunk_index: item['chunk_index'] as number,
      vector: item['vector'] as number[],
    })
  }
  return out
}

function parseHits(value: Json): VectorHit[] {
  if (!isRecord(value) || !Array.isArray(value['hits'])) {
    throw new BackendError('vector_index_bad_result', 'vector-index.search returned no hits')
  }
  const out: VectorHit[] = []
  for (const item of value['hits'] as Json[]) {
    if (
      !isRecord(item) ||
      typeof item['key'] !== 'string' ||
      typeof item['chunk_index'] !== 'number' ||
      typeof item['score'] !== 'number'
    ) {
      throw new BackendError(
        'vector_index_bad_result',
        'vector-index.search returned a malformed hit',
      )
    }
    out.push({
      key: item['key'] as string,
      chunk_index: item['chunk_index'] as number,
      score: item['score'] as number,
    })
  }
  return out
}

/** `vector-index.*` 的反向调用后端：索引读写与 top-k 委派给提供方，只经逻辑 key 往返。 */
export class RemoteVectorIndex implements VectorIndexBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async upsert(input: {
    model: string
    dim: number
    count: number
    records: VectorRecord[]
  }): Promise<VectorIndexMeta> {
    const outcome = await this.link.call('vector-index', 'upsert', {
      model: input.model,
      dim: input.dim,
      count: input.count,
      records: input.records,
    })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    return parseMeta(outcome.value)
  }

  async remove(keys: string[]): Promise<void> {
    const outcome = await this.link.call('vector-index', 'remove', { keys })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
  }

  async search(query: number[], topK: number): Promise<VectorHit[]> {
    const outcome = await this.link.call('vector-index', 'search', {
      query_vector: query,
      top_k: topK,
    })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    return parseHits(outcome.value)
  }

  async info(): Promise<VectorIndexInfo | null> {
    const outcome = await this.link.call('vector-index', 'info', {})
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    const value = outcome.value
    if (!isRecord(value) || value['present'] !== true) return null
    return { ...parseMeta(value), records: parseRecords(value['records']) }
  }

  async clear(): Promise<void> {
    const outcome = await this.link.call('vector-index', 'clear', {})
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
  }
}
