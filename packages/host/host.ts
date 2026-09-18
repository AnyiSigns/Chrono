// 宿主进程：唯一写者。抢锁 → 全量重放 → 开入站 socket → 串行处理提交。
// 装配与效果边界由此汇合：本文件只做接线与派发，不解释命令语义。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import {
  listCommands,
  resolveCommand,
  startAssembly,
  validateArgs,
  validateArgsSchema,
} from './assembly/index.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import { createRoundRouter, runSubmission } from './effect/index.ts'
import type { DirectiveDraft, RoundRouter } from './effect/index.ts'
import { appendJournal, acquireLock, loadAnchor, releaseLock } from './ledger/index.ts'
import { appendLifecycle } from './lifecycle.ts'
import { hostPaths, socketPath } from './paths.ts'
import { projectBaseOnly } from './projection/index.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './wire.ts'
import type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
import type { Entry, Json, World, Head } from '../kernel/index.ts'

export interface HostOptions {
  root: string
  /** 效果调用超时；缺省走 `DEFAULT_CALL_TIMEOUT_MS`（测试可注入更短值）。 */
  callTimeoutMs?: number
}

export interface HostHandle {
  root: string
  socket: string
  /** 停机序列：等在途提交 → 断开客户端 → 关闭服务 → 释放锁。 */
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

/** 合法 op 名单（与内核 `Op` 同口径）：入站 write 形态校验用。 */
const OP_NAMES: ReadonlySet<string> = new Set([
  'put',
  'add_identity',
  'add_gen',
  'set_active',
  'retire',
  'fork',
  'graft',
  'batch',
  'note',
  'snapshot',
])

/** 机械校验 directives 形态；非法返回 null（不得让畸形提交打崩写者）。
 *  eval 的 `ctx` 字段保原样：缺省留给宿主投影，显式给出（含 null）透传（A14）。 */
function asDirectives(value: unknown): DirectiveDraft[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const record = item as { [k: string]: unknown }
    const kind = record['kind']
    if (kind === 'eval') {
      if (typeof record['entry'] !== 'string' || record['entry'].length === 0) return null
      continue
    }
    if (kind === 'extern') continue
    if (kind === 'write') {
      const request = record['request']
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return null
      const op = (request as { [k: string]: unknown })['op']
      if (typeof op !== 'string' || !OP_NAMES.has(op)) return null
      continue
    }
    return null
  }
  return value as DirectiveDraft[]
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
  let router: RoundRouter | undefined

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
  const persistRound = (entries: Entry[]): void => {
    appendJournal(paths.journalFile, entries)
  }

  let runtime: AssemblyRuntimeHandle | undefined
  /** 写类提交的串行链：单写者语义下同一时刻至多一次 run。 */
  let chain: Promise<void> = Promise.resolve()
  /** 逐轮时间戳非回退（A10）：时钟回拨时仍单调 +1。 */
  let lastNow = startedAt
  const nextNow = (): number => {
    const now = Date.now()
    lastNow = now > lastNow ? now : lastNow + 1
    return lastNow
  }

  const handleSubmit = async (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'submit' }>,
    directives: DirectiveDraft[],
    runId: string,
  ): Promise<void> => {
    // 入站直提 eval 的属主：命令入口哈希 → 声明身份；解析不到则不路由（A1 不猜）
    const entryOwners = new Map<string, string>()
    for (const command of listCommands(world)) {
      if (!entryOwners.has(command.entry)) entryOwners.set(command.entry, command.identity)
    }
    const outcome = await runSubmission({
      world,
      head,
      directives,
      caps: message.caps ?? {},
      limits: message.limits ?? DEFAULT_LIMITS,
      initiator: 'client',
      now: nextNow,
      router,
      callTimeoutMs: options.callTimeoutMs,
      initialOwnerOf: (directive) =>
        directive.kind === 'eval' ? entryOwners.get(directive.entry) : undefined,
      ctxFor: projectBaseOnly,
      onAudit: persistAudit,
      onRound: persistRound,
    })
    world = outcome.world
    head = outcome.head
    send(socket, {
      v: PROTOCOL_VERSION,
      kind: 'result',
      run: runId,
      status: outcome.status,
      observations: outcome.observations,
    })
  }

  const handleCommand = async (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'command' }>,
  ): Promise<void> => {
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
    const args = message.args ?? null
    if (command.argsSchema !== null) {
      const schemaDef = world.defs[command.argsSchema]
      // 运行期 add_gen 产出的 argsSchema 未必过入世门禁：命令侧补一次方言元校验（fail-closed）
      const dialect = schemaDef === undefined ? null : validateArgsSchema(schemaDef.body)
      if (schemaDef === undefined || dialect === null || !dialect.ok) {
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'error',
          code: 'bad_args_schema',
          message: message.name,
        })
        return
      }
      if (!validateArgs(schemaDef.body, args)) {
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'error',
          code: 'bad_args',
          message: message.name,
        })
        return
      }
    }
    const directives: DirectiveDraft[] = [{ kind: 'eval', entry: command.entry, args }]
    const outcome = await runSubmission({
      world,
      head,
      directives,
      caps: message.caps ?? {},
      limits: message.limits ?? DEFAULT_LIMITS,
      initiator: 'command',
      now: nextNow,
      router,
      callTimeoutMs: options.callTimeoutMs,
      initialOwnerOf: (directive) => (directive.kind === 'eval' ? command.identity : undefined),
      ctxFor: projectBaseOnly,
      onAudit: persistAudit,
      onRound: persistRound,
    })
    world = outcome.world
    head = outcome.head
    send(socket, {
      v: PROTOCOL_VERSION,
      id: message.id,
      kind: 'result',
      status: outcome.status,
      observations: outcome.observations,
    })
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

  let stopPromise: Promise<void> | undefined
  const doStop = async (): Promise<void> => {
    stopping = true
    try {
      appendLifecycle(paths.lifecycleFile, { at: Date.now(), kind: 'host', event: 'stop' })
    } finally {
      // 在途提交先跑完（审计 / 业务写不落在停机中途），再断连接与服务
      await chain.catch(() => {})
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

  /** 停机幂等：并发 / 重复调用共享同一个 promise。 */
  const stop = (): Promise<void> => {
    if (stopPromise === undefined) stopPromise = doStop()
    return stopPromise
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
        if (stopping) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'internal',
            message: 'stopping',
          })
          return
        }
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
        const submit = message
        const runId = randomUUID()
        // accepted 先于排队发出：长提交不阻塞后到客户端的受理确认
        send(socket, { v: PROTOCOL_VERSION, id: submit.id, kind: 'accepted', run: runId })
        chain = chain
          .then(() => handleSubmit(socket, submit, directives, runId))
          .catch(() => {
            try {
              send(socket, {
                v: PROTOCOL_VERSION,
                id: submit.id,
                kind: 'error',
                code: 'internal',
                message: 'submit failed',
              })
            } catch {
              // 客户端已断：错误无处可送
            }
          })
        return
      }
      case 'command': {
        if (stopping) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'internal',
            message: 'stopping',
          })
          return
        }
        const command = message
        chain = chain
          .then(() => handleCommand(socket, command))
          .catch(() => {
            try {
              send(socket, {
                v: PROTOCOL_VERSION,
                id: command.id,
                kind: 'error',
                code: 'internal',
                message: 'command failed',
              })
            } catch {
              // 客户端已断：错误无处可送
            }
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
        setImmediate(() => {
          stop().catch(() => {
            // 停机尽力而为；失败由锁 / socket 清理逻辑兜底
          })
        })
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
    const driftLogged = new Set<string>()
    router = createRoundRouter({
      endpoints: runtime.endpoints,
      onDrift: (impl, cap, gen) => {
        // 同一 (发出者, pin 名, 依赖世代) 只记一条证据，避免每次调用都刷运维日志
        const key = `${impl}\u0000${cap}\u0000${gen}`
        if (driftLogged.has(key)) return
        driftLogged.add(key)
        appendLifecycle(paths.lifecycleFile, {
          at: Date.now(),
          kind: 'dep',
          event: 'drift',
          impl,
          cap,
          gen,
        })
      },
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
