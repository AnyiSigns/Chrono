// 宿主进程：唯一写者。抢锁 → 全量重放 → 开入站 socket → 串行处理提交。
// 装配与效果边界由此汇合：本文件只做接线与派发，不解释命令语义。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { listCommands, resolveCommand, startAssembly } from './assembly/index.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import { runRound } from './effect/index.ts'
import { appendJournal, acquireLock, loadAnchor, releaseLock } from './ledger/index.ts'
import { appendLifecycle } from './lifecycle.ts'
import { hostPaths, socketPath } from './paths.ts'
import { projectBaseOnly } from './projection/index.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './wire.ts'
import type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
import type { Directive, Entry, Json, World, Head } from '../kernel/index.ts'

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

/** 机械校验 directives 形态；非法返回 null（不得让畸形提交打崩写者）。 */
function asDirectives(value: unknown): Directive[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const kind = (item as { [k: string]: unknown })['kind']
    if (kind !== 'eval' && kind !== 'extern' && kind !== 'write') return null
  }
  return value as Directive[]
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

  let runtime: AssemblyRuntimeHandle | undefined
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
          dispatch(socket, message)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    try {
      appendLifecycle(paths.lifecycleFile, { at: Date.now(), kind: 'host', event: 'stop' })
    } finally {
      for (const client of clients) client.destroy()
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      } catch {
        // 未进入监听状态时 close 可能报错；停机继续
      }
      try {
        if (runtime !== undefined) await runtime.stop()
      } catch {
        // 停机尽力而为；锁必须释放
      }
      if (process.platform !== 'win32') {
        try {
          unlinkSync(address)
        } catch {
          // socket 文件可能已被外部清理；停机不因此失败
        }
      }
      releaseLock(paths.lockFile)
    }
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
        const directives = asDirectives(message.directives)
        if (directives === null) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'directives must be an array of directives',
          })
          return
        }
        const runId = randomUUID()
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted', run: runId })
        const outcome = runRound({
          world,
          head,
          directives: normalizeDirectives(directives, head),
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
        if (typeof message.name !== 'string') {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'command name must be a string',
          })
          return
        }
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
        const loaded =
          runtime === undefined
            ? []
            : runtime.loaded().map((entry) => ({ id: entry.id, gen: entry.gen }))
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

  try {
    appendLifecycle(paths.lifecycleFile, { at: startedAt, kind: 'host', event: 'start' })
    runtime = await startAssembly({
      root,
      world,
      log: (record) => appendLifecycle(paths.lifecycleFile, record as unknown as Json),
      onEvent: (impl, topic, payload) => broadcast(impl, topic, payload),
    })
    await listen(server, address)
  } catch (err) {
    // 启动失败不泄漏：停已起服务、关监听、释放锁
    if (runtime !== undefined) {
      try {
        await runtime.stop()
      } catch {
        // 清理尽力而为，不遮蔽原始错误
      }
    }
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } catch {
      // 未进入监听状态时 close 可能报错
    }
    releaseLock(paths.lockFile)
    throw err
  }

  return {
    root,
    socket: address,
    stop,
    emitEvent: broadcast,
  }
}
