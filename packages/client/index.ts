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

/** 宿主出站 kind 白名单（运行期兜底）：未知 kind 视为协议漂移，显式收口而非静默超时。 */
const KNOWN_OUTBOUND_KINDS: ReadonlySet<string> = new Set([
  'event',
  'accepted',
  'error',
  'result',
  'list',
  'state',
  'audits',
  'asset.ref',
  'asset.bytes',
])

export interface SubmitOptions {
  caps?: Record<string, boolean>
  limits?: Limits
  /** 受理回调：`accepted{run}` 到达即调用（UI 需要 run 句柄做取消 / 展示）。 */
  onAccepted?: (run: string) => void
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

/** F8 只读审计面：过滤条件（AND；`outcome` ∈ ok/error/transport_failed/cancelled）。 */
export interface AuditFilter {
  run?: string
  emitter?: string
  outcome?: string
  limit?: number
}

export interface AuditRecord {
  seq: number
  at: number
  by: string
  body: Json
}

export interface AuditReport {
  records: AuditRecord[]
  truncated: boolean
}

/** G4 资产引用：世界侧只存这个（字节住宿主资产区，`getAsset` 取回）。 */
export interface AssetRef {
  kind: 'asset'
  sha256: string
  mime: string
  size: number
}

export interface AssetBytes {
  sha256: string
  size: number
  bytes: Uint8Array
}

export interface EventMessage {
  impl: string
  topic: string
  payload: Json
}

export interface Client {
  submit(directives: Directive[], options?: SubmitOptions): Promise<SubmitResult>
  /** 真取消（protocol §三 `cancel{run}`）：中止在途 / 排队的 run；未知 / 已结束 → `unknown_run`。 */
  cancel(run: string): Promise<void>
  command(name: string, args?: Json, options?: SubmitOptions): Promise<CommandResult>
  commands(): Promise<CommandInfo[]>
  /** F8 只读审计面：按回合 / 身份 / outcome 查询（seq 降序取最新）。 */
  audit(filter?: AuditFilter): Promise<AuditReport>
  /** G4 资产入库：字节直写宿主资产区（不进世界），返回世界侧引用。 */
  putAsset(mime: string, bytes: Uint8Array): Promise<AssetRef>
  /** G4 取资产字节；字节缺失 → `asset_missing`。 */
  getAsset(sha256: string): Promise<AssetBytes>
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
      options.onAccepted?.(acc.run)
      const result = await this.awaitRun(acc.run)
      return { run: acc.run, status: result.status, observations: result.observations }
    })
  }

  async cancel(run: string): Promise<void> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'accepted' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'cancel', run })
    await pending
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

  async audit(filter: AuditFilter = {}): Promise<AuditReport> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'audits' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'audit', filter: filter as unknown as Json })
    const report = await pending
    return report as unknown as AuditReport
  }

  async putAsset(mime: string, bytes: Uint8Array): Promise<AssetRef> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'asset.ref' }>>(id)
    this.write({
      v: PROTOCOL_VERSION,
      id,
      kind: 'asset.put',
      mime,
      bytes: Buffer.from(bytes).toString('base64'),
    })
    const message = await pending
    return message.ref as unknown as AssetRef
  }

  async getAsset(sha256: string): Promise<AssetBytes> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'asset.bytes' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'asset.get', sha256 })
    const message = await pending
    return {
      sha256: message.sha256,
      size: message.size,
      bytes: Buffer.from(message.bytes, 'base64'),
    }
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
    let raws: Json[]
    try {
      raws = this.decoder.push(chunk)
    } catch {
      // 解码器抛错（帧超上限 / 坏 JSON）：与宿主侧同构收口，不让异常冒泡崩客户端进程
      this.failAll()
      this.socket.destroy()
      return
    }
    for (const raw of raws) {
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
    if (!KNOWN_OUTBOUND_KINDS.has(message.kind)) {
      // 未知 kind = 协议漂移：不静默悬挂等待器（否则只落成 timeout），直接收口暴露
      this.failAll()
      this.socket.destroy()
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
