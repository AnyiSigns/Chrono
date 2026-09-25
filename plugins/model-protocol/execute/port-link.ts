// 反向调用（服务 → 宿主，docs/protocol.md §2.4）：本插件 `pins` 含 `{"secrets":"secrets"}`，
// 故可按逻辑端口 `secrets` 调 `resolve` 解析 `auth_ref`。帧方向：服务发 `port.call`，
// 宿主按发出者 pins 路由后回 `port.result` / `port.error`（按 id 配对）。
// 明文只活在调用方内存，绝不进日志 / 世界 / 计划 / 事件。

import { writeFrame } from './frames.ts'
import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const PORT_CALL_TIMEOUT_MS = 30000

export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

interface PendingCall {
  resolve: (outcome: PortOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** 一条服务连接上的反向调用登记表；`main.ts` 收到 `port.result` / `port.error` 时调 `settle`。 */
export class PortLink {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0

  /** 调一个逻辑端口的方法；失败作数据回结构化错误（不抛错、不断通道）。 */
  async call(port: string, method: string, args: Rec): Promise<PortOutcome> {
    this.seq += 1
    const id = `mp-port-${this.seq}`
    return new Promise<PortOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: `${port}.${method} timeout` })
      }, PORT_CALL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      writeFrame({ v: '1', id, kind: 'port.call', port, method, args })
    })
  }

  /** 宿主侧应答入口：`port.result` / `port.error` 按 id 结算；返回是否已消费该帧。
   * 只有本链登记过该 id 才消费——多链（secrets / config）共存时，未登记不得吞掉他链的应答。 */
  settle(message: Rec): boolean {
    const kind = message['kind']
    if (kind !== 'port.result' && kind !== 'port.error') return false
    const id = message['id']
    if (typeof id !== 'string') return false
    const entry = this.pending.get(id)
    if (entry === undefined) return false
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

/** 从 bag / config 里取 `auth_ref`；非引用返回 null。 */
export function authRefOf(container: Json | undefined): Rec | null {
  if (!isRecord(container)) return null
  const ref = container['auth_ref']
  return isRecord(ref) ? ref : null
}
