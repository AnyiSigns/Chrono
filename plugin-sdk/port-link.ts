// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）：服务发 `port.call`，
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）。
// 失败作数据（结构化错误），不抛未捕获错误、不断通道。

import { writeFrame, SERVICE_PROTOCOL_VERSION } from './wire.ts'
import type { Json, Rec } from './json.ts'
import type { PortCaller, PortOutcome } from './types.ts'

/** 反向调用等待上限（通道兜底）。 */
export const PORT_CALL_TIMEOUT_MS = 30000

interface PendingCall {
  resolve: (outcome: PortOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export interface PortLinkOptions {
  /** 发帧出口；缺省写 stdout（stdio 形态）。 */
  write?: (message: Json) => void
  /** 等待上限；缺省 `PORT_CALL_TIMEOUT_MS`。 */
  timeoutMs?: number
  /** 帧 id 前缀；缺省 `port`。 */
  idPrefix?: string
}

/** 反向调用通道：`call` 发 `port.call`，`settle` 结算宿主回帧。 */
export class PortLink implements PortCaller {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private readonly write: (message: Json) => void
  private readonly timeoutMs: number
  private readonly idPrefix: string

  constructor(options: PortLinkOptions = {}) {
    this.write = options.write ?? writeFrame
    this.timeoutMs = options.timeoutMs ?? PORT_CALL_TIMEOUT_MS
    this.idPrefix = options.idPrefix ?? 'port'
  }

  call(port: string, method: string, args: Rec): Promise<PortOutcome> {
    this.seq += 1
    const id = `${this.idPrefix}-${this.seq}`
    return new Promise<PortOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: `${port}.${method} timeout` })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        this.write({ v: SERVICE_PROTOCOL_VERSION, id, kind: 'port.call', port, method, args })
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
        code: typeof message['error'] === 'string' ? message['error'] : 'port_failed',
        message: typeof message['message'] === 'string' ? message['message'] : '',
      })
    }
    return true
  }

  /** 断连 / drain 时结算全部在途：失败作数据，不悬挂。 */
  failAll(code = 'transport_failed'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code, message: 'link closed' })
    }
    this.pending.clear()
  }
}
