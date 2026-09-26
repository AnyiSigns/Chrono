// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `pins` 含 `embedding` → embedding：建 / 重建索引与 put 去重经 `port.call embedding.chunk` + `embedding.embed`。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from './plan.ts'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** 窗口切块结果（`embedding.chunk` 的出参；start / end 为 Unicode 码点偏移）。 */
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

/** 向量化后端抽象：生产环境是反向调用 `embedding.*`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<EmbeddingResult>
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
        throw new BackendError('embedding_bad_result', 'embedding.embed returned a malformed vector')
      }
      vectors.push(vector as number[])
    }
    if (vectors.length !== texts.length) {
      throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
    }
    return {
      model: typeof value['model'] === 'string' ? (value['model'] as string) : model,
      dim: typeof value['dim'] === 'number' ? (value['dim'] as number) : vectors.length > 0 ? vectors[0].length : 0,
      vectors,
    }
  }

  async chunk(text: string): Promise<Chunk[]> {
    const outcome = await this.link.call('embedding', 'chunk', { text })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    const value = outcome.value
    if (!Array.isArray(value)) {
      throw new BackendError('embedding_bad_result', 'embedding.chunk returned a non-array')
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
        throw new BackendError('embedding_bad_result', 'embedding.chunk returned a malformed chunk')
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
