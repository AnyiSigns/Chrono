// 自实现入站客户端（UI 插件不得 import 宿主 / 内核 / 客户端包）。
// 连接宿主本地 socket（named pipe / unix domain），按入站协议收发帧：
// 请求按 id 配对；`event` 无 id、按 `impl` 命名空间回调；断线自动重连并上报连接态。
// 只依赖 node:net / node:crypto；日志走 stderr。

import { connect } from 'node:net'
import { createFrameDecoder, encodeFrame } from './frames.js'
import { isRecord } from './types.js'

/** 入站面客户端：单连接、自动重连、按 id 配对请求。 */
export class InboundClient {
  constructor(options) {
    this.options = options
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000
    this.socket = null
    this.decoder = createFrameDecoder()
    this.connected = false
    this.closed = false
    this.reconnectTimer = null
    this.pending = new Map()
  }

  /** 起连接（幂等）：连接失败不抛错，按退避重试。 */
  start() {
    this.tryConnect()
  }

  /** 永久关闭：不再重连，未结算请求作通道失败。 */
  close() {
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

  isConnected() {
    return this.connected
  }

  /** 发一条入站请求并等回帧；未连接 / 超时 / 断连均作数据失败（不抛错）。 */
  request(frame, timeoutMs) {
    const id = frame['id']
    if (typeof id !== 'string' || id.length === 0) {
      return Promise.resolve({ ok: false, frame: null, code: 'internal', message: 'frame id required' })
    }
    const socket = this.socket
    if (!this.connected || socket === null || socket.destroyed) {
      return Promise.resolve({ ok: false, frame: null, code: 'ui_unreachable', message: 'host not connected' })
    }
    const waitMs = timeoutMs ?? this.requestTimeoutMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, frame: null, code: 'transport_failed', message: 'request timeout' })
      }, waitMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        socket.write(encodeFrame(frame))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({ ok: false, frame: null, code: 'ui_unreachable', message: `write failed: ${err.message}` })
      }
    })
  }

  tryConnect() {
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
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (err) => {
      this.options.log(`inbound error: ${err.message}`)
    })
    socket.on('close', () => this.handleDisconnect())
  }

  onData(chunk) {
    let messages
    try {
      messages = this.decoder.push(chunk)
    } catch (err) {
      this.options.log(`inbound bad frame: ${err.message}`)
      this.socket?.destroy()
      return
    }
    for (const message of messages) this.onMessage(message)
  }

  onMessage(message) {
    if (!isRecord(message)) return
    const kind = message['kind']
    if (kind === 'event') {
      const impl = typeof message['impl'] === 'string' ? message['impl'] : 'host'
      const topic = typeof message['topic'] === 'string' ? message['topic'] : ''
      this.options.onEvent?.(impl, topic, message['payload'] ?? null)
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

  handleDisconnect() {
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

  failPending(code, message) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, frame: null, code, message })
    }
    this.pending.clear()
  }
}
