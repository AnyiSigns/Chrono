// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）。
// 本插件对工具提供者（describe / invoke）、guard、能力类方法、保留身份 host 的调用都走 `port.call`；
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）。
// 失败作数据（PortOutcome），不抛未捕获错误、不断通道；单测用可注入的假 bridge 替换真实通道。

import { writeFrame } from './frames.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const PORT_CALL_TIMEOUT_MS = 30000

export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

interface PendingCall {
  resolve: (outcome: PortOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一条服务连接上的反向调用登记表：`call` 发 `port.call` 并等待应答，
 * 帧循环收到 `port.result` / `port.error` 时调 `settle` 结算。
 */
export class PortLink {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private readonly write: (message: Json) => void
  private readonly timeoutMs: number

  constructor(write: (message: Json) => void = writeFrame, timeoutMs: number = PORT_CALL_TIMEOUT_MS) {
    this.write = write
    this.timeoutMs = timeoutMs
  }

  /** 发一条 `port.call` 并等待应答；超时 / 写失败作结构化失败。 */
  call(port: string, method: string, args: Rec): Promise<PortOutcome> {
    this.seq += 1
    const id = `tools-${this.seq}`
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
        code: typeof message['error'] === 'string' ? message['error'] : 'transport_failed',
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

/** 从 `{tools:[...]}` 形态的 describe 结果里取工具数组；形态不符回空。 */
export function toolsOf(value: Json): Json[] {
  if (!isRecord(value)) return []
  const tools = value['tools']
  return Array.isArray(tools) ? tools : []
}
