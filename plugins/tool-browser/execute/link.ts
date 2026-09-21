// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）。
// 本插件的 `sandbox.capabilities` 咨询与 `host.asset.put` 存取都经此发出；
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）。
// 失败作数据（ToolError），不抛穿帧循环；单测注入假 link 替换真实通道。

import { log, writeFrame } from './frames.ts'
import { ToolError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用通道：把一条 `port.call` 发出并等待应答值。 */
export interface PortLink {
  call(port: string, method: string, args: Json): Promise<Json>
}

interface Pending {
  resolve: (value: Json) => void
  reject: (error: ToolError) => void
  timer: ReturnType<typeof setTimeout>
}

/** 反向调用等待上限；宿主自身另有调用超时，此处作通道兜底。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30000

/** 走 stdio 协议帧的反向调用通道；`settle` 由帧循环在收到应答时调用。 */
export class StdioPortLink implements PortLink {
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number
  private seq = 0

  constructor(timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  call(port: string, method: string, args: Json): Promise<Json> {
    const id = `tool-browser-${(this.seq += 1)}`
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ToolError('tool_timeout', `${port}.${method} did not answer in time`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        writeFrame({ v: '1', id, kind: 'port.call', port, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ToolError('transport_failed', `cannot write port.call: ${(err as Error).message}`))
      }
    })
  }

  /** 帧循环入口：`port.result` / `port.error` 按 id 结算；返回是否已消费该帧。 */
  settle(message: Json): boolean {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
    const rec = message as Rec
    const kind = rec['kind']
    if (kind !== 'port.result' && kind !== 'port.error') return false
    const id = typeof rec['id'] === 'string' ? rec['id'] : ''
    const entry = this.pending.get(id)
    if (entry === undefined) return true
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (kind === 'port.result') {
      entry.resolve((rec['value'] ?? null) as Json)
    } else {
      const code = typeof rec['error'] === 'string' ? rec['error'] : 'tool_failed'
      const messageText = typeof rec['message'] === 'string' ? rec['message'] : ''
      entry.reject(new ToolError(code, messageText))
    }
    return true
  }

  /** 断连 / 退出：未结算的调用全部作数据失败。 */
  failAll(code: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new ToolError(code, 'link closed'))
    }
    this.pending.clear()
  }

  /** 诊断用：在途调用数。 */
  get size(): number {
    return this.pending.size
  }
}

/** 供帧循环兜底调用；失败只记日志，不阻断退出。 */
export function safeFailAll(link: StdioPortLink): void {
  try {
    link.failAll('transport_failed')
  } catch (err) {
    log(`failAll failed: ${(err as Error).message}`)
  }
}
