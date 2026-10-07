// 入站面服务端：本地 socket 监听、已连接客户端集合、帧编解码接入与事件广播。
// 只做传输与路由接入，不解释消息语义；dispatch 由组合根懒注入（server 先于 handler 组装）。

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { isWindows } from '../common/platform/index.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from '../wire.ts'
import type { InboundMessage, OutboundMessage } from '../wire.ts'
import { readMessage } from './validate.ts'
import type { BroadcastFn } from '../run-registry.ts'
import type { Json } from '../../kernel/index.ts'

/** 入站 kind → handler 的薄路由入口；由 `inbound/dispatch.ts` 构造。 */
export type DispatchFn = (socket: Socket, message: InboundMessage) => void

export interface InboundServerDeps {
  address: string
  sockDir: string
  /** 懒取路由：连接回调在监听后才触发，故组装顺序可为 server → dispatch。 */
  getDispatch: () => DispatchFn
  /** 运行期 accept 级错误：记录 + 按停机序列收口，不崩宿主。 */
  onRuntimeError: (err: Error) => void
  /** 无法按协议配对的入站畸形帧（缺 / 错型 id、不可解码）：记录宿主运维事件。 */
  onInvalidFrame: (reason: string) => void
}

export interface InboundServerHandle {
  clients: Set<Socket>
  send: (socket: Socket, message: OutboundMessage) => void
  broadcast: BroadcastFn
  listen: () => Promise<void>
  close: () => Promise<void>
  destroyClients: () => void
  unlinkSocket: () => void
}

/** 入站面并发连接上限：超限直接断新连接（本地面，防连接耗尽）。 */
export const MAX_INBOUND_CLIENTS = 64
/** 单客户端在途出站帧上限：慢 / 不读客户端不得拖垮宿主内存。 */
export const MAX_INBOUND_OUTBOUND_FRAMES = 1024
/** 单客户端在途出站字节上限（帧数之外再兜一层大帧）。 */
export const MAX_INBOUND_OUTBOUND_BYTES = 8 * 1024 * 1024

interface ClientState {
  queue: Uint8Array[]
  queuedBytes: number
  blocked: boolean
  closed: boolean
}

function listen(
  server: Server,
  address: string,
  onRuntimeError: (err: Error) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(address, () => {
      server.removeListener('error', onError)
      // 运行期 accept 级错误：挂常驻监听（记录 + 按停机序列收口），不得摘成无监听
      server.on('error', onRuntimeError)
      resolve()
    })
  })
}

export function createInboundServer(deps: InboundServerDeps): InboundServerHandle {
  const clients = new Set<Socket>()
  const states = new WeakMap<Socket, ClientState>()

  const stateOf = (socket: Socket): ClientState => {
    let state = states.get(socket)
    if (state === undefined) {
      state = { queue: [], queuedBytes: 0, blocked: false, closed: false }
      states.set(socket, state)
    }
    return state
  }

  /** 串行写出队列：`socket.write` 返回 false 即停写、等 `drain` 续写（帧序不乱、不追加内部缓冲）。 */
  const pump = (socket: Socket, state: ClientState): void => {
    if (state.blocked || state.closed) return
    while (state.queue.length > 0) {
      const frame = state.queue.shift() as Uint8Array
      state.queuedBytes -= frame.length
      let ok: boolean
      try {
        ok = socket.write(frame)
      } catch {
        state.closed = true
        state.queue.length = 0
        state.queuedBytes = 0
        return
      }
      if (!ok) {
        state.blocked = true
        const onDrain = (): void => {
          socket.off('close', onClose)
          state.blocked = false
          pump(socket, state)
        }
        const onClose = (): void => {
          socket.off('drain', onDrain)
          state.closed = true
          state.queue.length = 0
          state.queuedBytes = 0
        }
        socket.once('drain', onDrain)
        socket.once('close', onClose)
        return
      }
    }
  }

  const send = (socket: Socket, message: OutboundMessage): void => {
    let frame: Uint8Array
    try {
      frame = encodeFrame(message as unknown as Json)
    } catch {
      // 出站帧超上限：不写出对端必然拒收的脏帧；按不可解码帧同样收口（记运维事件 + 断该客户端）
      deps.onInvalidFrame('outbound frame exceeds limit')
      socket.destroy()
      return
    }
    const state = stateOf(socket)
    if (state.closed) return
    state.queue.push(frame)
    state.queuedBytes += frame.length
    if (
      state.queue.length > MAX_INBOUND_OUTBOUND_FRAMES ||
      state.queuedBytes > MAX_INBOUND_OUTBOUND_BYTES
    ) {
      // 慢 / 不读客户端积压超限：fail-closed 断连，不无界缓冲
      state.closed = true
      state.queue.length = 0
      state.queuedBytes = 0
      deps.onInvalidFrame('outbound queue overflow')
      socket.destroy()
      return
    }
    pump(socket, state)
  }
  const broadcast: BroadcastFn = (impl, topic, payload) => {
    for (const client of clients) {
      const state = states.get(client)
      if (state !== undefined && state.closed) continue
      send(client, { v: PROTOCOL_VERSION, impl, kind: 'event', topic, payload })
    }
  }

  const server = createServer((socket: Socket) => {
    if (clients.size >= MAX_INBOUND_CLIENTS) {
      // 连接上限：断新连接并记运维事件，不影响既有客户端
      deps.onInvalidFrame('inbound client limit reached')
      socket.destroy()
      return
    }
    clients.add(socket)
    const state = stateOf(socket)
    const decoder = createFrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      let frames: Json[]
      try {
        frames = decoder.push(chunk)
      } catch {
        // 不可解码的帧（坏 JSON / 超长前缀）：记运维事件后断掉该客户端，写者进程不因此退出
        deps.onInvalidFrame('undecodable frame')
        socket.destroy()
        return
      }
      for (const raw of frames) {
        const read = readMessage(raw)
        if (!read.ok) {
          if (read.id !== null) {
            // 可配对（id 为字符串）但 v / kind 缺或类型错：回错帧，不静默丢弃
            send(socket, {
              v: PROTOCOL_VERSION,
              id: read.id,
              kind: 'error',
              code: 'bad_directive',
              message: 'malformed frame',
            })
            continue
          }
          // 协议上无法配对：记录宿主运维事件并断连，避免调用方悬挂等待
          deps.onInvalidFrame('malformed frame without id')
          socket.destroy()
          return
        }
        try {
          deps.getDispatch()(socket, read.message)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.on('close', () => {
      state.closed = true
      state.queue.length = 0
      state.queuedBytes = 0
      clients.delete(socket)
    })
    socket.on('error', () => {
      state.closed = true
      clients.delete(socket)
    })
  })

  const listenFn = (): Promise<void> => {
    mkdirSync(deps.sockDir, { recursive: true })
    if (!isWindows() && existsSync(deps.address)) {
      try {
        unlinkSync(deps.address)
      } catch {
        // 陈旧 socket 文件清理失败不致命，listen 会给出真实错误
      }
    }
    return listen(server, deps.address, deps.onRuntimeError)
  }

  return {
    clients,
    send,
    broadcast,
    listen: listenFn,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          // 未进入监听状态时 close 可能报错；停机继续
          resolve()
        }
      }),
    destroyClients: () => {
      for (const client of clients) client.destroy()
    },
    unlinkSocket: () => {
      if (isWindows()) return
      try {
        unlinkSync(deps.address)
      } catch {
        // socket 文件可能已被外部清理；停机不因此失败
      }
    },
  }
}
