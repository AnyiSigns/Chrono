// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与委托存储后端抽象。
// 本插件 `pins` 含 `storage-kv` → storage-kv：清单读写经 `port.call storage-kv.get/put/batch/list/dropNamespace`。
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）；命名空间由宿主填的 `env.emitter` 决定。
// 失败作数据（ToolError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { writeFrame } from './frames.ts'
import { isRecord } from './plan.ts'
import { ToolError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const PORT_CALL_TIMEOUT_MS = 30000

export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

interface PendingCall {
  resolve: (outcome: PortOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** 一条服务连接上的反向调用登记表：`call` 发 `port.call` 并等待应答。 */
export class PortLink {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private readonly write: (message: Json) => void
  private readonly timeoutMs: number

  constructor(write: (message: Json) => void = writeFrame, timeoutMs: number = PORT_CALL_TIMEOUT_MS) {
    this.write = write
    this.timeoutMs = timeoutMs
  }

  call(port: string, method: string, args: Rec): Promise<PortOutcome> {
    this.seq += 1
    const id = `todo-${this.seq}`
    return new Promise<PortOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: `${port}.${method} timeout` })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        this.write({ v: '1', id, kind: 'port.call', port, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: (err as Error).message })
      }
    })
  }

  /** 宿主侧应答入口：`port.result` / `port.error` 按 id 结算；返回是否已消费该帧。 */
  settle(message: Rec): boolean {
    const kind = message['kind']
    if (kind !== 'port.result' && kind !== 'port.error') return false
    const id = message['id']
    if (typeof id !== 'string') return true
    const entry = this.pending.get(id)
    if (entry === undefined) return true
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (kind === 'port.result') {
      entry.resolve({ ok: true, value: (message['value'] ?? null) as Json })
    } else {
      entry.resolve({
        ok: false,
        code: typeof message['error'] === 'string' ? message['error'] : 'backend_failed',
        message: typeof message['message'] === 'string' ? message['message'] : '',
      })
    }
    return true
  }

  failAll(code = 'transport_failed'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code, message: 'link closed' })
    }
    this.pending.clear()
  }
}

/** 委托存储的键值后端抽象：生产环境是反向调用 `storage-kv.*`，单测注入假后端。 */
export interface StorageBackend {
  get(key: string): Promise<Json | null>
  put(key: string, value: Json): Promise<void>
  batch(ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }>): Promise<void>
  list(prefix: string): Promise<Array<{ key: string; value: Json }>>
  dropNamespace(): Promise<void>
}

/** `storage-kv` 的反向调用后端：按发出者命名空间读写本 owner 数据。 */
export class RemoteStorage implements StorageBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
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

  async put(key: string, value: Json): Promise<void> {
    await this.invoke('put', { key, value })
  }

  async batch(ops: Array<{ op: 'put' | 'del'; key: string; value?: Json }>): Promise<void> {
    await this.invoke('batch', { ops })
  }

  async list(prefix: string): Promise<Array<{ key: string; value: Json }>> {
    const value = await this.invoke('list', { prefix })
    if (!isRecord(value) || !Array.isArray(value['entries'])) return []
    const out: Array<{ key: string; value: Json }> = []
    for (const item of value['entries'] as Json[]) {
      if (isRecord(item) && typeof item['key'] === 'string') {
        out.push({ key: item['key'] as string, value: (item['value'] ?? null) as Json })
      }
    }
    return out
  }

  async dropNamespace(): Promise<void> {
    await this.invoke('dropNamespace', {})
  }
}
