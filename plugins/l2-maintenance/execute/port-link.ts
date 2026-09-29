// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `needs` 含 `short-memory`（L1/L2 读写）、`session`（会话 → 工作区归属）、
// `embedding`（去重向量）、`compress`（需要摘要时 summarize）。失败作数据（BackendError），
// 不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

/** `short-memory.read` / `apply` 的反向调用等待上限。 */
export const SHORT_MEMORY_TIMEOUT_MS = 15000
/** `session.read` 的反向调用等待上限（须大于 session.read 声明）。 */
export const SESSION_TIMEOUT_MS = 120000
/** `embedding.embed` 的反向调用等待上限。 */
export const EMBEDDING_TIMEOUT_MS = 30000
/** `compress.summarize` 的反向调用等待上限（须大于 compress.summarize 声明）。 */
export const COMPRESS_TIMEOUT_MS = 3900001

/** 短期记忆 owner 后端抽象：生产环境是反向调用 `short-memory.read` / `apply`。 */
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
    const outcome = await this.link.call(
      'short-memory',
      'read',
      {},
      { timeoutMs: SHORT_MEMORY_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.read returned a non-object')
    return outcome.value
  }

  async apply(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'apply', args, {
      timeoutMs: SHORT_MEMORY_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.apply returned a non-object')
    return outcome.value
  }
}

/** 会话 owner 后端抽象：生产环境是反向调用 `session.read`（取会话 → 工作区归属）。 */
export interface SessionBackend {
  read(): Promise<Rec>
}

/** `session` 的反向调用后端：读会话 body（含 conversations[].workspace_id）。 */
export class RemoteSession implements SessionBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(): Promise<Rec> {
    const outcome = await this.link.call('session', 'read', {}, { timeoutMs: SESSION_TIMEOUT_MS })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('session_bad_result', 'session.read returned a non-object')
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

/** 从计划值里取 extern 载荷（`compress.*` 回计划值，摘要住 extern.payload）。 */
function externPayload(value: Json): Rec {
  if (isRecord(value) && Array.isArray(value['$directives'])) {
    for (const directive of value['$directives'] as Json[]) {
      if (isRecord(directive) && directive['kind'] === 'extern' && isRecord(directive['payload'])) {
        return directive['payload'] as Rec
      }
    }
  }
  if (isRecord(value)) return value
  throw new BackendError('compress_bad_result', 'compress.summarize returned no payload')
}

/** 摘要后端抽象：生产环境是反向调用 `compress.summarize`，单测注入假后端。 */
export interface CompressBackend {
  summarize(args: Rec): Promise<Rec>
}

/** `compress.summarize` 的反向调用后端：成功回 extern 载荷（含结构化 summary）。 */
export class RemoteCompress implements CompressBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async summarize(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('compress', 'summarize', args, {
      timeoutMs: COMPRESS_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    return externPayload(outcome.value)
  }
}
