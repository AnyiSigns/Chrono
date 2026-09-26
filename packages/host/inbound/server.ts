// 入站面服务端：本地 socket 监听、已连接客户端集合、帧编解码接入与事件广播。
// 只做传输与路由接入，不解释消息语义；dispatch 由组合根懒注入（server 先于 handler 组装）。

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
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
    socket.write(encodeFrame(message as unknown as Json))
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
        // 畸形帧：断掉该客户端，写者进程不因入站损坏退出
        socket.destroy()
        return
      }
      for (const raw of frames) {
        const message = readMessage(raw)
        if (message === null) continue
        try {
          deps.getDispatch()(socket, message)
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
    if (process.platform !== 'win32' && existsSync(deps.address)) {
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
      if (process.platform === 'win32') return
      try {
        unlinkSync(deps.address)
      } catch {
        // socket 文件可能已被外部清理；停机不因此失败
      }
    },
  }
}
