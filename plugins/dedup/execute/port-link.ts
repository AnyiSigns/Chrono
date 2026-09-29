// 向量化后端抽象：生产环境经 SDK 反向调用通道发 `port.call embedding.embed`，单测注入假后端。
// 失败作数据：`dedupNewItems` 捕获后回落精确文本去重（去重是尽力而为），不抛未捕获错误、不断通道。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller } from 'plugin-sdk'

/** `embedding.embed` 的反向调用等待上限（与拆分前 compress → embedding 同口径）。 */
export const EMBEDDING_TIMEOUT_MS = 30000

/** 反向调用后端失败：带结构化码，调用方据此回落。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<number[][]>
}

/** `embedding.embed` 的反向调用后端：成功回向量数组（已 L2 归一）。 */
export class RemoteEmbedding implements EmbeddingBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const outcome = await this.link.call(
      'embedding',
      'embed',
      { texts, model },
      { timeoutMs: EMBEDDING_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value) || !Array.isArray(outcome.value['vectors'])) {
      throw new BackendError('embedding_bad_result', 'embedding.embed returned no vectors')
    }
    const vectors: number[][] = []
    for (const vector of outcome.value['vectors'] as Json[]) {
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
    return vectors
  }
}
