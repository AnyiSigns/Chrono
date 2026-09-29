// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `needs` 含 `memory`（L3 读写）、`short-memory`（读 L2 摘要）、`embedding`（去重向量）。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** `short-memory.read` 的反向调用等待上限。 */
export const SHORT_MEMORY_TIMEOUT_MS = 15000
/** `embedding.embed` 的反向调用等待上限。 */
export const EMBEDDING_TIMEOUT_MS = 30000
/** `memory.*` 的反向调用等待上限（须大于 memory-store 的条目写入声明）。 */
export const MEMORY_TIMEOUT_MS = 600001

/** 长期记忆 owner 后端抽象：生产环境是反向调用 `memory.*`。 */
export interface MemoryBackend {
  list(): Promise<Rec>
  append(args: Rec): Promise<Rec>
  remove(args: Rec): Promise<Rec>
  pin(args: Rec): Promise<Rec>
  edit(args: Rec): Promise<Rec>
}

/** `memory-store` 的反向调用后端：清单读取与条目写入。 */
export class RemoteMemory implements MemoryBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  private async invoke(method: string, args: Rec): Promise<Rec> {
    const outcome = await this.link.call('memory', method, args, { timeoutMs: MEMORY_TIMEOUT_MS })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('memory_bad_result', `memory.${method} returned a non-object`)
    return outcome.value
  }

  async list(): Promise<Rec> {
    return this.invoke('list', {})
  }

  async append(args: Rec): Promise<Rec> {
    return this.invoke('append', args)
  }

  async remove(args: Rec): Promise<Rec> {
    return this.invoke('delete', args)
  }

  async pin(args: Rec): Promise<Rec> {
    return this.invoke('pin', args)
  }

  async edit(args: Rec): Promise<Rec> {
    return this.invoke('edit', args)
  }
}

/** 短期记忆 owner 后端抽象：生产环境是反向调用 `short-memory.read`（取 L2 摘要）。 */
export interface ShortMemoryBackend {
  read(): Promise<Rec>
}

/** `short-memory` 的反向调用后端：读整份 L2，供固化取数。 */
export class RemoteShortMemory implements ShortMemoryBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(): Promise<Rec> {
    const outcome = await this.link.call(
      'short-memory',
      'read',
      {},
      {
        timeoutMs: SHORT_MEMORY_TIMEOUT_MS,
      },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.read returned a non-object')
    return outcome.value
  }
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<number[][]>
}

/** `embedding.embed` 的反向调用后端。 */
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
