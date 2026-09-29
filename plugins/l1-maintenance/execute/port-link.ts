// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：反向调用通道由 SDK 提供
// （`plugin-sdk` 的 PortLink）；本文件只保留业务后端。
// 本插件 `needs` 含 `short-memory`（L1 读写）与 `session`（会话归属，对齐原 owner 读取面）。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { isRecord } from 'plugin-sdk'
import { BackendError } from './types.ts'
import type { PortCaller } from 'plugin-sdk'
import type { Rec } from './types.ts'

/** `short-memory.read` / `apply` 的反向调用等待上限。 */
export const SHORT_MEMORY_TIMEOUT_MS = 30000
/** `session.read` 的反向调用等待上限（须大于 session.read 声明）。 */
export const SESSION_TIMEOUT_MS = 120000

/** 短期记忆 owner 后端抽象：生产环境是反向调用 `short-memory.read` / `apply`。 */
export interface ShortMemoryBackend {
  read(): Promise<Rec>
  apply(args: Rec): Promise<Rec>
}

/** `short-memory` 的反向调用后端：读整份 L1，逐键置 / 删写回。 */
export class RemoteShortMemory implements ShortMemoryBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'read', {})
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('short_memory_bad_result', 'short-memory.read returned a non-object')
    return outcome.value
  }

  async apply(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('short-memory', 'apply', args)
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
