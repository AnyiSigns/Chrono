// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `pins` 含 `model` → model-protocol、`embedding` → embedding：
// semantic 模式经 `port.call model.chat` 出摘要；summarize / extract 去重经 `port.call embedding.embed` 取向量。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from './plan.ts'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** 模型后端抽象：生产环境是反向调用 `model.chat`，单测注入假后端。 */
export interface ModelBackend {
  chat(config: Rec, messages: Json[]): Promise<Rec>
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<number[][]>
}

/** 从模型服务回包里取结构化错误码（`{ok:false, error:{code}}`）。 */
function modelErrorCode(value: Rec): string {
  const error = value['error']
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'] as string
  return 'model_call_failed'
}

/** `model.chat` 的反向调用后端：成功回最终值，失败抛结构化 BackendError。 */
export class RemoteModel implements ModelBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async chat(config: Rec, messages: Json[]): Promise<Rec> {
    const outcome = await this.link.call('model', 'chat', { config, messages })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new BackendError('model_call_failed', 'model.chat returned a non-object')
    if (outcome.value['ok'] === false) {
      throw new BackendError(modelErrorCode(outcome.value), 'model.chat reported failure')
    }
    return outcome.value
  }
}

/** `embedding.embed` 的反向调用后端：成功回向量数组（已 L2 归一）。 */
export class RemoteEmbedding implements EmbeddingBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const outcome = await this.link.call('embedding', 'embed', { texts, model })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value) || !Array.isArray(outcome.value['vectors'])) {
      throw new BackendError('embedding_bad_result', 'embedding.embed returned no vectors')
    }
    const vectors: number[][] = []
    for (const vector of outcome.value['vectors'] as Json[]) {
      if (!Array.isArray(vector) || vector.some((item) => typeof item !== 'number')) {
        throw new BackendError('embedding_bad_result', 'embedding.embed returned a malformed vector')
      }
      vectors.push(vector as number[])
    }
    if (vectors.length !== texts.length) {
      throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
    }
    return vectors
  }
}

/** 短期记忆 owner 后端抽象：生产环境是反向调用 `short-memory.read` / `apply`，单测注入假后端。 */
export interface ShortMemoryBackend {
  read(): Promise<Rec>
  apply(args: Rec): Promise<Rec>
}

/** `short-memory` 的反向调用后端：读整份 L1 / L2，逐键置 / 删写回。 */
export class RemoteShortMemory implements ShortMemoryBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'read', {})
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new BackendError('short_memory_bad_result', 'short-memory.read returned a non-object')
    return outcome.value
  }

  async apply(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'apply', args)
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new BackendError('short_memory_bad_result', 'short-memory.apply returned a non-object')
    return outcome.value
  }
}
