// 自实现入站客户端（UI 插件不得 import 宿主 / 内核 / 客户端包）。
// 连接宿主本地 socket（named pipe / unix domain），按 docs/protocol.md §三 收发帧：
// 请求按 id 配对；`event` 无 id、按 `impl` 命名空间回调；断线自动重连并上报连接态。
// 只依赖 node:net / node:crypto；日志走 stderr。

import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { createFrameDecoder, encodeFrame } from './frames.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'
import type { InboundResult, Transport } from './bridge.ts'

export interface InboundClientOptions {
  socketPath: string
  log: (line: string) => void
  /** 宿主广播事件（`event` 帧）：impl 命名空间 + topic + payload。 */
  onEvent?: (impl: string, topic: string, payload: Json) => void
  /** 未配对回帧（如 `submit` 的终局 `result`，无 id）：交上层重播。 */
  onFrame?: (frame: Rec) => void
  /** 连接态变化：true = 已连上宿主，false = 断开（含首次连接失败）。 */
  onConnectionChange?: (connected: boolean) => void
  reconnectDelayMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (result: InboundResult) => void
  timer: ReturnType<typeof setTimeout>
}

/** 入站面客户端：单连接、自动重连、按 id 配对请求。 */
export class InboundClient implements Transport {
  private readonly options: InboundClientOptions
  private readonly reconnectDelayMs: number
  private readonly requestTimeoutMs: number
  private socket: Socket | null = null
  private decoder = createFrameDecoder()
  private connected = false
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pending = new Map<string, Pending>()

  constructor(options: InboundClientOptions) {
    this.options = options
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000
  }

  /** 起连接（幂等）：连接失败不抛错，按退避重试。 */
  start(): void {
    this.tryConnect()
  }

  /** 永久关闭：不再重连，未结算请求作通道失败。 */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.failPending('ui_unreachable', 'inbound client closed')
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    if (this.connected) {
      this.connected = false
      this.options.onConnectionChange?.(false)
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** 发一条入站请求并等回帧；未连接 / 超时 / 断连均作数据失败（不抛错）。 */
  request(frame: Rec, timeoutMs?: number): Promise<InboundResult> {
    const id = frame['id']
    if (typeof id !== 'string' || id.length === 0) {
      return Promise.resolve({ ok: false, frame: null, code: 'internal', message: 'frame id required' })
    }
    const socket = this.socket
    if (!this.connected || socket === null || socket.destroyed) {
      return Promise.resolve({
        ok: false,
        frame: null,
        code: 'ui_unreachable',
        message: 'host not connected',
      })
    }
    const waitMs = timeoutMs ?? this.requestTimeoutMs
    return new Promise<InboundResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, frame: null, code: 'transport_failed', message: 'request timeout' })
      }, waitMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        socket.write(encodeFrame(frame as Json))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({
          ok: false,
          frame: null,
          code: 'ui_unreachable',
          message: `write failed: ${(err as Error).message}`,
        })
      }
    })
  }

  private tryConnect(): void {
    if (this.closed || this.connected || this.socket !== null) return
    this.decoder = createFrameDecoder()
    const socket = connect(this.options.socketPath)
    this.socket = socket
    socket.setNoDelay?.(true)
    socket.on('connect', () => {
      this.connected = true
      this.options.log(`inbound connected: ${this.options.socketPath}`)
      this.options.onConnectionChange?.(true)
    })
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err: Error) => {
      this.options.log(`inbound error: ${err.message}`)
    })
    socket.on('close', () => this.handleDisconnect())
  }

  private onData(chunk: Buffer): void {
    let messages: Json[]
    try {
      messages = this.decoder.push(chunk)
    } catch (err) {
      this.options.log(`inbound bad frame: ${(err as Error).message}`)
      this.socket?.destroy()
      return
    }
    for (const message of messages) this.onMessage(message)
  }

  private onMessage(message: Json): void {
    if (!isRecord(message)) return
    const kind = message['kind']
    if (kind === 'event') {
      const impl = typeof message['impl'] === 'string' ? message['impl'] : 'host'
      const topic = typeof message['topic'] === 'string' ? message['topic'] : ''
      this.options.onEvent?.(impl, topic, (message['payload'] ?? null) as Json)
      return
    }
    const id = message['id']
    if (typeof id === 'string') {
      const entry = this.pending.get(id)
      if (entry !== undefined) {
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.resolve({ ok: true, frame: message, code: '', message: '' })
        return
      }
    }
    this.options.onFrame?.(message)
  }

  private handleDisconnect(): void {
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      socket.removeAllListeners()
      socket.destroy()
    }
    if (this.connected) {
      this.connected = false
      this.options.log('inbound disconnected')
      this.options.onConnectionChange?.(false)
    }
    this.failPending('ui_unreachable', 'host connection closed')
    if (!this.closed && this.reconnectTimer === null) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.tryConnect()
      }, this.reconnectDelayMs)
      this.reconnectTimer.unref?.()
    }
  }

  private failPending(code: string, message: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, frame: null, code, message })
    }
    this.pending.clear()
  }
}
