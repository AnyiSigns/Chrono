// 宿主进程：唯一写者。抢锁 → 全量重放 → 开入站 socket → 串行处理提交。
// 装配与效果边界由此汇合：本文件只做接线与派发，不解释命令语义。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { listCommands, resolveCommand } from './assembly/index.ts'
import { runRound } from './effect/index.ts'
import { appendJournal, acquireLock, loadAnchor, releaseLock } from './ledger/index.ts'
import { appendLifecycle } from './lifecycle.ts'
import { hostPaths, socketPath } from './paths.ts'
import { projectBaseOnly } from './projection/index.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './wire.ts'
import type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
import type { Directive, Entry, Hash, Json, World, Head } from '../kernel/index.ts'

export interface HostOptions {
  root: string
}

export interface HostHandle {
  root: string
  socket: string
  /** 停机序列：断开客户端 → 关闭服务 → 释放锁。 */
  stop: () => Promise<void>
  /** 插件事件透传入口：只广播给已连接客户端，不落账、不推进。 */
  emitEvent: (impl: string, topic: string, payload: Json) => void
}

/** 发起者未给 limits 时的宿主默认预算。 */
const DEFAULT_LIMITS: Limits = { gas: 1_000_000, depth: 64 }

function asRecord(value: Json): { [k: string]: Json } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function readMessage(raw: Json): InboundMessage | null {
  const record = asRecord(raw)
  if (!record) return null
  if (typeof record['v'] !== 'string' || typeof record['id'] !== 'string') return null
  if (typeof record['kind'] !== 'string') return null
  return record as unknown as InboundMessage
}

/** 机械填字段：写请求的位置恒为当前链头，id / by 缺省补齐；args / op 原样透传。 */
function normalizeDirectives(directives: Directive[], head: Head): Directive[] {
  return directives.map((directive) => {
    if (directive.kind !== 'write') return directive
    const request = { ...directive.request }
    const id = typeof request.id === 'string' ? request.id : ''
    const by = typeof request.by === 'string' ? request.by : ''
    request.id = id.length > 0 ? id : `w-${randomUUID()}`
    request.by = by.length > 0 ? by : 'client'
    request.target = { expect_pos: head.hash }
    return { kind: 'write', request }
  })
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(address, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/** 起宿主：全程阻塞在入站 socket 上，直到 stop 被调用。 */
export async function startHost(options: HostOptions): Promise<HostHandle> {
  const root = options.root
  const paths = hostPaths(root)
  const startedAt = Date.now()
  const lock = acquireLock(paths.lockFile, startedAt)
  if (!lock.ok) throw new Error('writer_busy')

  const anchor = loadAnchor(paths.journalFile)
  let world: World = anchor.world
  let head: Head = anchor.head
  const clients = new Set<Socket>()
  let stopping = false

  const address = socketPath(root)
  mkdirSync(paths.sockDir, { recursive: true })
  if (process.platform !== 'win32' && existsSync(address)) {
    try {
      unlinkSync(address)
    } catch {
      // 陈旧 socket 文件清理失败不致命，listen 会给出真实错误
    }
  }

  const send = (socket: Socket, message: OutboundMessage): void => {
    socket.write(encodeFrame(message as unknown as Json))
  }
  const broadcast = (impl: string, topic: string, payload: Json): void => {
    for (const client of clients) {
      send(client, { v: PROTOCOL_VERSION, impl, kind: 'event', topic, payload })
    }
  }

  const persistAudit = (entry: Entry): void => {
    appendJournal(paths.journalFile, [entry])
  }

  const server = createServer((socket: Socket) => {
    clients.add(socket)
    const decoder = createFrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const message = readMessage(raw)
        if (message === null) continue
        dispatch(socket, message)
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    for (const client of clients) client.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      try {
        unlinkSync(address)
      } catch {
        // socket 文件可能已被外部清理；停机不因此失败
      }
    }
    releaseLock(paths.lockFile)
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'cycle',
      phase: 'stop',
      pid: process.pid,
    })
  }

  const dispatch = (socket: Socket, message: InboundMessage): void => {
    if (message.v !== PROTOCOL_VERSION) {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'protocol_mismatch',
        message: `protocol ${message.v} != ${PROTOCOL_VERSION}`,
      })
      return
    }
    switch (message.kind) {
      case 'submit': {
        const runId = randomUUID()
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted', run: runId })
        const outcome = runRound({
          world,
          head,
          directives: normalizeDirectives(message.directives, head),
          caps: message.caps ?? {},
          limits: message.limits ?? DEFAULT_LIMITS,
          initiator: 'client',
          now: Date.now(),
          onAudit: persistAudit,
        })
        world = outcome.world
        head = outcome.head
        if (outcome.status === 'done') appendJournal(paths.journalFile, outcome.journal)
        send(socket, {
          v: PROTOCOL_VERSION,
          kind: 'result',
          run: runId,
          status: outcome.status,
          observations: outcome.observations,
        })
        return
      }
      case 'command': {
        const command = resolveCommand(world, message.name)
        if (command === null) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'unknown_command',
            message: message.name,
          })
          return
        }
        const directives: Directive[] = [
          {
            kind: 'eval',
            entry: command.entry,
            args: message.args ?? null,
            ctx: projectBaseOnly(world, head),
          },
        ]
        const outcome = runRound({
          world,
          head,
          directives,
          caps: message.caps ?? {},
          limits: message.limits ?? DEFAULT_LIMITS,
          initiator: 'command',
          now: Date.now(),
          onAudit: persistAudit,
        })
        world = outcome.world
        head = outcome.head
        if (outcome.status === 'done') appendJournal(paths.journalFile, outcome.journal)
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'result',
          status: outcome.status,
          observations: outcome.observations,
        })
        return
      }
      case 'commands': {
        const commands = listCommands(world).map((command) => ({
          identity: command.identity,
          name: command.name,
          entry: command.entry,
        }))
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'list', commands })
        return
      }
      case 'status': {
        const loaded = Object.keys(world.ids)
          .sort()
          .filter((id) => world.ids[id].active !== null)
          .map((id) => ({ id, gen: world.ids[id].active as Hash }))
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'state',
          world_head: { seq: head.seq, hash: head.hash },
          loaded,
        })
        return
      }
      case 'stop': {
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted' })
        setImmediate(() => void stop())
        return
      }
    }
  }

  await listen(server, address)
  appendLifecycle(paths.lifecycleFile, {
    at: startedAt,
    kind: 'cycle',
    phase: 'start',
    pid: process.pid,
  })

  return {
    root,
    socket: address,
    stop,
    emitEvent: broadcast,
  }
}
