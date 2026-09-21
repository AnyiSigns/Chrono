// 反向调用链接：服务发 `port.call`，宿主按发出者 pins 路由后回 `port.result` / `port.error`（按 id 配对）。
// 本插件用它调隔离执行与资产存取；调用 id 只用于配对，不影响结果。

import { writeFrame } from './frames.ts'
import type { CallOutcome } from './backend.ts'
import type { Json, Rec } from './types.ts'

const CALL_TIMEOUT_MS = 30000

interface PendingCall {
  resolve: (outcome: CallOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export class ReverseLink {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0

  /** 发起一次反向调用；超时 / 断连 / 写帧失败作结构化失败。 */
  call(port: string, method: string, args: Rec): Promise<CallOutcome> {
    const id = `tool-http-pc-${this.seq}`
    this.seq += 1
    return new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'tool_timeout', message: 'reverse call timeout' })
      }, CALL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        writeFrame({ v: '1', id, kind: 'port.call', port, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: (err as Error).message })
      }
    })
  }

  /** 宿主侧应答入口：按 id 结算；返回是否消费了该帧。 */
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
        code: typeof message['error'] === 'string' ? message['error'] : 'error',
        message: typeof message['message'] === 'string' ? message['message'] : '',
      })
    }
    return true
  }

  /** 断连 / 退出：未结算的调用全部作数据失败。 */
  failAll(code = 'transport_failed'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code, message: 'link closed' })
    }
    this.pending.clear()
  }
}
