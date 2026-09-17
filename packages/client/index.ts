// 入站面客户端库：connect / submit / command / commands / status / stop / 收 event。
// CLI、UI 与以客户端身份连接的插件共用本库；不在这里实现任何判定。

import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { createFrameDecoder, encodeFrame } from './frame.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import type { Limits, OutboundMessage } from './protocol.ts'
import { resolveRoot, socketPath } from './socket.ts'
import type { Directive, Json } from '../kernel/index.ts'

export interface ClientOptions {
  root?: string
  timeoutMs?: number
}

export interface SubmitOptions {
  caps?: Record<string, boolean>
  limits?: Limits
}

export interface SubmitResult {
  run: string
  status: string
  observations: Json[]
}

export interface CommandResult {
  status: string
  observations: Json[]
}

export interface CommandInfo {
  identity: string
  name: string
  entry: string
}

export interface StatusResult {
  world_head: { seq: number; hash: string | null }
  loaded: { id: string; gen: string }[]
}

export interface EventMessage {
  impl: string
  topic: string
  payload: Json
}

export interface Client {
  submit(directives: Directive[], options?: SubmitOptions): Promise<SubmitResult>
  command(name: string, args?: Json, options?: SubmitOptions): Promise<CommandResult>
  commands(): Promise<CommandInfo[]>
  status(): Promise<StatusResult>
  stop(): Promise<void>
  onEvent(handler: (event: EventMessage) => void): void
  close(): void
}

export class ClientError extends Error {
  readonly code: string
  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.code = code
  }
}

type Waiter = (message: OutboundMessage | null) => void

const DEFAULT_TIMEOUT_MS = 30_000

class HostClient implements Client {
  private readonly socket: Socket
  private readonly timeoutMs: number
  private readonly decoder = createFrameDecoder()
  private readonly idWaiters = new Map<string, Waiter>()
  private readonly runWaiters = new Map<string, Waiter>()
  private readonly bufferedResults = new Map<string, OutboundMessage>()
  private readonly eventHandlers: ((event: EventMessage) => void)[] = []

  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => this.failAll())
    socket.on('error', () => this.failAll())
  }

  submit(directives: Directive[], options: SubmitOptions = {}): Promise<SubmitResult> {
    const id = randomUUID()
    const accepted = this.once<Extract<OutboundMessage, { kind: 'accepted' }>>(id)
    const message: { [k: string]: Json } = {
      v: PROTOCOL_VERSION,
      id,
      kind: 'submit',
      directives: directives as unknown as Json,
    }
    if (options.caps !== undefined) message['caps'] = options.caps
    if (options.limits !== undefined) message['limits'] = options.limits as unknown as Json
    this.write(message as unknown as Json)
    return accepted.then(async (acc) => {
      if (acc.run === undefined) throw new ClientError('internal', 'accepted without run')
      const result = await this.awaitRun(acc.run)
      return { run: acc.run, status: result.status, observations: result.observations }
    })
  }

  async command(
    name: string,
    args: Json = null,
    options: SubmitOptions = {},
  ): Promise<CommandResult> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'result'; id: string }>>(id)
    const message: { [k: string]: Json } = { v: PROTOCOL_VERSION, id, kind: 'command', name, args }
    if (options.caps !== undefined) message['caps'] = options.caps
    if (options.limits !== undefined) message['limits'] = options.limits as unknown as Json
    this.write(message as unknown as Json)
    const result = await pending
    return { status: result.status, observations: result.observations }
  }

  async commands(): Promise<CommandInfo[]> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'list' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'commands' })
    const list = await pending
    return list.commands as unknown as CommandInfo[]
  }

  async status(): Promise<StatusResult> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'state' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'status' })
    const state = await pending
    return state as unknown as StatusResult
  }

  async stop(): Promise<void> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'accepted' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'stop' })
    await pending
    this.close()
  }

  onEvent(handler: (event: EventMessage) => void): void {
    this.eventHandlers.push(handler)
  }

  close(): void {
    this.failAll()
    this.socket.destroy()
  }

  private awaitRun(
    run: string,
  ): Promise<Extract<OutboundMessage, { kind: 'result'; run: string }>> {
    const buffered = this.bufferedResults.get(run)
    if (buffered !== undefined) {
      this.bufferedResults.delete(run)
      return Promise.resolve(buffered as Extract<OutboundMessage, { kind: 'result'; run: string }>)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runWaiters.delete(run)
        reject(new ClientError('timeout'))
      }, this.timeoutMs)
      this.runWaiters.set(run, (message) => {
        clearTimeout(timer)
        if (message === null || message.kind !== 'result' || !('run' in message)) {
          reject(new ClientError('connection_closed'))
          return
        }
        resolve(message)
      })
    })
  }

  private once<T extends OutboundMessage>(id: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idWaiters.delete(id)
        reject(new ClientError('timeout'))
      }, this.timeoutMs)
      this.idWaiters.set(id, (message) => {
        clearTimeout(timer)
        if (message === null) {
          reject(new ClientError('connection_closed'))
          return
        }
        if (message.kind === 'error') {
          reject(new ClientError(message.code, message.message))
          return
        }
        resolve(message as T)
      })
    })
  }

  private write(message: Json): void {
    this.socket.write(encodeFrame(message))
  }

  private onData(chunk: Buffer): void {
    for (const raw of this.decoder.push(chunk)) {
      this.dispatch(raw as unknown as OutboundMessage)
    }
  }

  private dispatch(message: OutboundMessage): void {
    if (message.kind === 'event') {
      for (const handler of this.eventHandlers) {
        handler({ impl: message.impl, topic: message.topic, payload: message.payload })
      }
      return
    }
    if (message.kind === 'result' && 'run' in message) {
      const waiter = this.runWaiters.get(message.run)
      if (waiter !== undefined) {
        this.runWaiters.delete(message.run)
        waiter(message)
      } else {
        this.bufferedResults.set(message.run, message)
      }
      return
    }
    if ('id' in message) {
      const waiter = this.idWaiters.get(message.id)
      if (waiter !== undefined) {
        this.idWaiters.delete(message.id)
        waiter(message)
      }
    }
  }

  private failAll(): void {
    for (const waiter of this.idWaiters.values()) waiter(null)
    this.idWaiters.clear()
    for (const waiter of this.runWaiters.values()) waiter(null)
    this.runWaiters.clear()
  }
}

/** 连接运行中的宿主；成功即返回客户端句柄。 */
export function connect(options: ClientOptions = {}): Promise<Client> {
  const root = resolveRoot(options.root)
  const address = socketPath(root)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const socket = netConnect(address)
    const client = new HostClient(socket, timeoutMs)
    socket.once('connect', () => resolve(client))
    socket.once('error', (err) => {
      client.close()
      reject(err)
    })
  })
}
