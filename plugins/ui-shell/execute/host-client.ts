// 反向调用（服务 → 宿主，docs/protocol.md §2.4）：本插件 `pins` 为 `{"host":"host"}`，
// 故 port 恒为保留能力类 `host`。帧方向：服务发 `port.call`，宿主按发出者 pins 路由后回
// `port.result` / `port.error`（按原 id 配对）。失败一律作数据，不抛错、不断通道。

import { randomUUID } from 'node:crypto'
import { writeFrame } from './frames.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 保留能力类名（也是 `pins` 里绑定宿主自身的保留值）。 */
export const HOST_PORT = 'host'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const DEFAULT_HOST_TIMEOUT_MS = 30000

export type HostResult =
  | { ok: true; value: Json }
  | { ok: false; code: string; message: string }

interface PendingCall {
  resolve: (result: HostResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** 一条服务连接上的反向调用登记表；与正向调用按 id 分流（port.result / port.error）。 */
export class HostLink {
  private readonly pending = new Map<string, PendingCall>()
  private readonly timeoutMs: number
  private readonly prefix: string

  constructor(timeoutMs: number = DEFAULT_HOST_TIMEOUT_MS, prefix = 'ui-shell-pc') {
    this.timeoutMs = timeoutMs
    this.prefix = prefix
  }

  /** 发一条 `port.call` 并等待应答；超时作数据回 `transport_failed`。 */
  call(method: string, args: Json): Promise<HostResult> {
    const id = `${this.prefix}-${randomUUID()}`
    return new Promise<HostResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: 'host call timeout' })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      writeFrame({ v: '1', id, kind: 'port.call', port: HOST_PORT, method, args })
    })
  }

  /** 宿主侧应答入口：`port.result` / `port.error` 按 id 结算。 */
  resolve(message: Rec): boolean {
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
        code: typeof message['error'] === 'string' ? message['error'] : 'error',
        message: typeof message['message'] === 'string' ? message['message'] : '',
      })
    }
    return true
  }

  /** 供测试 / 关闭时使用：未结算的调用全部作数据失败。 */
  failAll(code = 'transport_failed'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code, message: 'link closed' })
    }
    this.pending.clear()
  }
}

/** 读插件源码 blob（base64 文本）；形态不符回落 null。 */
export function decodeSourceRead(
  value: Json,
): { path: string; text: string; size: number } | null {
  if (!isRecord(value)) return null
  const path = value['path']
  const content = value['content']
  if (typeof path !== 'string' || typeof content !== 'string') return null
  const size = typeof value['size'] === 'number' ? value['size'] : 0
  try {
    return { path, text: Buffer.from(content, 'base64').toString('utf8'), size }
  } catch {
    return null
  }
}
