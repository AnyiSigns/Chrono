// 委托存储后端抽象：生产环境经 SDK 反向调用通道发 `port.call storage-kv.*`，单测注入假后端。
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）；命名空间由宿主填的 `env.emitter` 决定。
// 失败作数据（ToolError），不抛未捕获错误、不断通道。

import { isRecord } from 'plugin-sdk'
import { ToolError } from './types.ts'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

/** 委托存储的键值后端抽象：生产环境是反向调用 `storage-kv.*`，单测注入假后端。 */
export interface StorageBackend {
  get(key: string): Promise<Json | null>
  batch(ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }>): Promise<void>
}

/** `storage-kv` 的反向调用后端：按发出者命名空间读写本 owner 数据。 */
export class RemoteStorage implements StorageBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  private async invoke(method: string, args: Rec): Promise<Json> {
    const outcome = await this.link.call('storage-kv', method, args)
    if (!outcome.ok) throw new ToolError(outcome.code, outcome.message)
    return outcome.value
  }

  async get(key: string): Promise<Json | null> {
    const value = await this.invoke('get', { key })
    if (!isRecord(value) || value['found'] !== true) return null
    return value['value'] ?? null
  }

  async batch(ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }>): Promise<void> {
    await this.invoke('batch', { ops })
  }
}
