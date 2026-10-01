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
    socket.write(frame)
  }
  const broadcast: BroadcastFn = (impl, topic, payload) => {
    for (const client of clients) {
      send(client, { v: PROTOCOL_VERSION, impl, kind: 'event', topic, payload })
    }
  }

  const server = createServer((socket: Socket) => {
    clients.add(socket)
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
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
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
