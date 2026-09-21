// 最小 CDP 连接：WebSocket 上按 id 配对的请求 / 应答 + 事件订阅。
// 用 Node 内建全局 WebSocket，不引第三方依赖。连接失败 / 超时 → ToolError。

import { ToolError } from '../types.ts'
import type { Json, Rec } from '../types.ts'

interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
  readyState: number
}

export interface CdpEvent {
  method: string
  params: Rec
  sessionId: string | null
}

interface Pending {
  resolve: (value: Json) => void
  reject: (error: ToolError) => void
  timer: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(event: CdpEvent) => void>()
  private readonly ws: WebSocketLike

  private constructor(ws: WebSocketLike) {
    this.ws = ws
  }

  /** 连接 ws 端点；`open` 前失败或超时 → tool_timeout / browser_unsupported。 */
  static connect(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
    if (typeof WebSocketCtor !== 'function') {
      throw new ToolError('browser_unsupported', 'global WebSocket is not available')
    }
    return new Promise<CdpConnection>((resolve, reject) => {
      const socket = new WebSocketCtor(wsUrl)
      const timer = setTimeout(() => {
        socket.close()
        reject(new ToolError('tool_timeout', `CDP connect timed out: ${wsUrl}`))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        const connection = new CdpConnection(socket)
        connection.attach()
        resolve(connection)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new ToolError('browser_unsupported', `CDP connect failed: ${wsUrl}`))
      })
    })
  }

  /** 订阅事件；返回退订函数。 */
  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 发一条 CDP 命令并等待结果；超时 → tool_timeout。 */
  send(method: string, params: Rec = {}, sessionId?: string, timeoutMs = 30000): Promise<Json> {
    const id = (this.nextId += 1)
    const payload: Rec = { id, method, params }
    if (typeof sessionId === 'string') payload['sessionId'] = sessionId
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ToolError('tool_timeout', `CDP ${method} did not answer in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ToolError('browser_unsupported', `CDP send failed: ${(err as Error).message}`))
      }
    })
  }

  /** 由子类 / 工厂在收到帧时喂入；公开供测试直接驱动。 */
  handleFrame(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    if (typeof parsed['id'] === 'number') {
      this.settle(parsed)
      return
    }
    if (typeof parsed['method'] === 'string') {
      const event: CdpEvent = {
        method: parsed['method'],
        params: isRecord(parsed['params']) ? parsed['params'] : {},
        sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null,
      }
      for (const listener of this.listeners) listener(event)
    }
  }

  private settle(message: Rec): void {
    const id = message['id'] as number
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (isRecord(message['error'])) {
      const error = message['error'] as Rec
      entry.reject(new ToolError('tool_failed', typeof error['message'] === 'string' ? error['message'] : 'CDP error'))
      return
    }
    entry.resolve((message['result'] ?? null) as Json)
  }

  /** 由工厂绑定 message 事件；供 connect 后立即接线。 */
  attach(): void {
    this.ws.addEventListener('message', (event) => {
      const data = event.data
      if (typeof data === 'string') this.handleFrame(data)
      else if (data instanceof Uint8Array) this.handleFrame(Buffer.from(data).toString('utf8'))
    })
    this.ws.addEventListener('close', () => this.failAll('transport_failed'))
  }

  failAll(code: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new ToolError(code, 'CDP connection closed'))
    }
    this.pending.clear()
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // 已关闭。
    }
    this.failAll('transport_failed')
  }
}
