// 入站面客户端库：connect / submit / command / commands / status / stop / 收 event。
// CLI、UI 与以客户端身份连接的插件共用本库；不在这里实现任何判定。

import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { createFrameDecoder, encodeFrame } from './frame.ts'
import { MAX_ASSET_BYTES, PROTOCOL_VERSION } from './protocol.ts'
import type { Limits, OutboundMessage } from './protocol.ts'
import { resolveRoot, socketPath } from './socket.ts'
import type { Directive, Json } from '../kernel/index.ts'

export interface ClientOptions {
  root?: string
  /** 普通请求（连接 / 单帧应答）等待上限；缺省 30s。 */
  timeoutMs?: number
  /**
   * 一次 run（`submit` / `command` / `forward`）的整体等待上限；与普通请求超时分开——
   * run 可跨多轮、多次服务调用，用单次调用口径判它会误判 `timeout`。缺省回落 `timeoutMs`
   * （保持既有调用方行为）；boot 按宿主 `call-timeout` 口径透传（见 `boot/commands.ts`）。
   */
  runTimeoutMs?: number
}

/** 宿主出站 kind 白名单（运行期兜底）：未知 kind 视为协议漂移，显式收口而非静默超时。 */
export const KNOWN_OUTBOUND_KINDS: ReadonlySet<string> = new Set([
  'event',
  'accepted',
  'error',
  'result',
  'list',
  'state',
  'audits',
  'asset.ref',
  'asset.bytes',
  'secrets.ok',
])

export interface SubmitOptions {
  caps?: Record<string, boolean>
  limits?: Limits
  /** 可选线程标记：随宿主 run 生命周期事件原样回带，宿主不解释（与 wire 对齐）。 */
  thread?: string
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
  world_rev: string
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
  /**
   * H8 插件入站转发：把帧交给 `identity` **自己声明**的入口 term（构造一次 run）。
   * 命令不属于该身份 → `unknown_command`；宿主只做机械路由、不认识业务。
   */
  forward(
    identity: string,
    command: string,
    args?: Json,
    options?: SubmitOptions,
  ): Promise<CommandResult>
  commands(): Promise<CommandInfo[]>
  /** F8 只读审计面：按回合 / 身份 / outcome 查询（seq 降序取最新）。 */
  audit(filter?: AuditFilter): Promise<AuditReport>
  /** G4 资产入库：字节直写宿主资产区（不进世界），返回世界侧引用。 */
  putAsset(mime: string, bytes: Uint8Array): Promise<AssetRef>
  /** G4 取资产字节；字节缺失 → `asset_missing`。 */
  getAsset(sha256: string): Promise<AssetBytes>
  /** 密钥本地存储面：直写宿主本地密钥文件（不进世界、不进审计）；失败以协议错误码收口。 */
  putSecret(name: string, value: string): Promise<void>
  /** 删除宿主本地密钥文件中的条目；不存在也回 `secrets.ok`（幂等）。 */
  deleteSecret(name: string): Promise<void>
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

/** 早到结果缓冲上限：结果先于等待者到达时暂存，无界会随长驻连接单调增长。 */
const MAX_BUFFERED_RESULTS = 1024

class HostClient implements Client {
  private readonly socket: Socket
  private readonly timeoutMs: number
  private readonly runTimeoutMs: number
  private readonly decoder = createFrameDecoder()
  private readonly idWaiters = new Map<string, Waiter>()
  private readonly runWaiters = new Map<string, Waiter>()
  /** submit 的请求 id → `accepted{run}` 的 run id：受理后到达的 `error{id}` 据此归位到该 run。 */
  private readonly submitRuns = new Map<string, string>()
  /** 先于等待者到达的 run 错误：与早到结果同规暂存，供 `awaitRun` 立即以真实错误码收口。 */
  private readonly pendingRunErrors = new Map<string, ClientError>()
  private readonly bufferedResults = new Map<string, OutboundMessage>()
  private readonly eventHandlers: ((event: EventMessage) => void)[] = []

  constructor(socket: Socket, timeoutMs: number, runTimeoutMs: number) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.runTimeoutMs = runTimeoutMs
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
    if (options.thread !== undefined) message['thread'] = options.thread
    this.write(message as unknown as Json)
    return accepted.then(async (acc) => {
      if (acc.run === undefined) throw new ClientError('internal', 'accepted without run')
      try {
        options.onAccepted?.(acc.run)
        const result = await this.awaitRun(acc.run)
        return { run: acc.run, status: result.status, observations: result.observations }
      } finally {
        // run 已收口（成功 / 错误 / 超时 / 回调抛错）：清理 id → run 关联，防长驻连接无界增长
        this.submitRuns.delete(id)
      }
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
    // 命令走一次 run（可多轮），等待按 run 口径而非单帧请求口径
    const pending = this.once<Extract<OutboundMessage, { kind: 'result'; id: string }>>(
      id,
      this.runTimeoutMs,
    )
    const message: { [k: string]: Json } = { v: PROTOCOL_VERSION, id, kind: 'command', name, args }
    if (options.caps !== undefined) message['caps'] = options.caps
    if (options.limits !== undefined) message['limits'] = options.limits as unknown as Json
    if (options.thread !== undefined) message['thread'] = options.thread
    this.write(message as unknown as Json)
    const result = await pending
    return { status: result.status, observations: result.observations }
  }

  async forward(
    identity: string,
    command: string,
    args: Json = null,
    options: SubmitOptions = {},
  ): Promise<CommandResult> {
    const id = randomUUID()
    // 转发同样走一次 run（可多轮），等待按 run 口径
    const pending = this.once<Extract<OutboundMessage, { kind: 'result'; id: string }>>(
      id,
      this.runTimeoutMs,
    )
    const message: { [k: string]: Json } = {
      v: PROTOCOL_VERSION,
      id,
      kind: 'forward',
      identity,
      command,
      args,
    }
    if (options.caps !== undefined) message['caps'] = options.caps
    if (options.limits !== undefined) message['limits'] = options.limits as unknown as Json
    if (options.thread !== undefined) message['thread'] = options.thread
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
    // 契约上限在入口前置（见 docs/protocol.md 资产面）：超 8 MiB 宿主必回 `asset_too_large`；
    // 若照发帧，8–12 MiB 与 >≈12 MiB（base64 撑爆 16 MiB 帧上限）会退化成两种收口，故在此统一。
    if (bytes.length > MAX_ASSET_BYTES) throw new ClientError('asset_too_large')
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

  async putSecret(name: string, value: string): Promise<void> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'secrets.ok' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'secrets.put', name, value })
    await pending
  }

  async deleteSecret(name: string): Promise<void> {
    const id = randomUUID()
    const pending = this.once<Extract<OutboundMessage, { kind: 'secrets.ok' }>>(id)
    this.write({ v: PROTOCOL_VERSION, id, kind: 'secrets.delete', name })
    await pending
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
    // accepted 后到达的 error{id} 已按 run 归位并暂存：立即以真实错误码收口，不落成 timeout。
    const pendingError = this.pendingRunErrors.get(run)
    if (pendingError !== undefined) {
      this.pendingRunErrors.delete(run)
      return Promise.reject(pendingError)
    }
    // 连接已断（含同批未知 kind 触发 failAll 后）时，等运行超时没有意义：立即以 connection_closed 收口。
    if (this.socket.destroyed) return Promise.reject(new ClientError('connection_closed'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runWaiters.delete(run)
        reject(new ClientError('timeout'))
      }, this.runTimeoutMs)
      this.runWaiters.set(run, (message) => {
        clearTimeout(timer)
        if (message === null) {
          reject(new ClientError('connection_closed'))
          return
        }
        if (message.kind === 'error') {
          reject(new ClientError(message.code, message.message))
          return
        }
        if (message.kind !== 'result' || !('run' in message)) {
          reject(new ClientError('connection_closed'))
          return
        }
        resolve(message)
      })
    })
  }

  private once<T extends OutboundMessage>(
    id: string,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    // 连接已断时不再注册等待器：否则等满超时才失败，且期间该 id 永远不会到达。
    if (this.socket.destroyed) return Promise.reject(new ClientError('connection_closed'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idWaiters.delete(id)
        reject(new ClientError('timeout'))
      }, timeoutMs)
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
    let frame: Uint8Array
    try {
      frame = encodeFrame(message)
    } catch {
      // 出站帧超上限：不写出对端必然拒收的脏帧；与解码收口同构，失败在途并断开
      this.failAll()
      this.socket.destroy()
      return
    }
    this.socket.write(frame)
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
      try {
        this.dispatch(raw as unknown as OutboundMessage)
      } catch (err) {
        // 单条消息的派发失败不得中断后续消息、更不得冒成未捕获异常
        this.reportHandlerError(err)
      }
    }
  }

  private dispatch(message: OutboundMessage): void {
    if (message.kind === 'event') {
      const event = { impl: message.impl, topic: message.topic, payload: message.payload }
      for (const handler of this.eventHandlers) {
        try {
          handler(event)
        } catch (err) {
          // 用户 handler 抛错只影响自身：后续 handler 照常收到事件，进程不崩
          this.reportHandlerError(err)
        }
      }
      return
    }
    if (message.kind === 'result' && 'run' in message) {
      const waiter = this.runWaiters.get(message.run)
      if (waiter !== undefined) {
        this.runWaiters.delete(message.run)
        waiter(message)
      } else {
        // 有界暂存：超限淘汰最旧（Map 插入序），避免无人认领的结果无界堆积
        if (
          !this.bufferedResults.has(message.run) &&
          this.bufferedResults.size >= MAX_BUFFERED_RESULTS
        ) {
          const oldest = this.bufferedResults.keys().next().value
          if (oldest !== undefined) {
            this.bufferedResults.delete(oldest)
            // 淘汰不静默：被淘汰的 run 结果将无人认领（后续 awaitRun 只能超时），留痕便于诊断。
            console.error('[client] buffered result evicted (buffer full):', oldest)
          }
        }
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
    // 受理先记 id → run 关联：此后到达的 error{id}（如 startRun 兜底回的真实错误码）
    // 才能归位到该 run，而不是因 accepted 已消费 id 等待器被静默丢弃、最终误判 timeout。
    if (message.kind === 'accepted' && 'run' in message && typeof message.run === 'string') {
      this.submitRuns.set(message.id, message.run)
    }
    if (message.kind === 'error') {
      const run = this.submitRuns.get(message.id)
      if (run !== undefined) {
        this.submitRuns.delete(message.id)
        const waiter = this.runWaiters.get(run)
        if (waiter !== undefined) {
          this.runWaiters.delete(run)
          waiter(message)
        } else {
          // 等待者尚未注册（accepted 与 error 同批到达）：与早到结果同规暂存
          this.pendingRunErrors.set(run, new ClientError(message.code, message.message))
        }
        return
      }
    }
    if ('id' in message) {
      const waiter = this.idWaiters.get(message.id)
      if (waiter !== undefined) {
        this.idWaiters.delete(message.id)
        waiter(message)
      }
    }
  }

  /** 用户 handler / 单条派发的异常只记录，不向 socket 监听器冒泡。 */
  private reportHandlerError(err: unknown): void {
    console.error('[client] handler error:', err)
  }

  private failAll(): void {
    for (const waiter of this.idWaiters.values()) waiter(null)
    this.idWaiters.clear()
    for (const waiter of this.runWaiters.values()) waiter(null)
    this.runWaiters.clear()
    this.bufferedResults.clear()
    this.pendingRunErrors.clear()
    this.submitRuns.clear()
  }
}

/** 连接运行中的宿主；成功即返回客户端句柄。 */
export function connect(options: ClientOptions = {}): Promise<Client> {
  const root = resolveRoot(options.root)
  const address = socketPath(root)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // run 等待缺省回落请求超时：未显式区分时行为与既有调用方一致
  const runTimeoutMs = options.runTimeoutMs ?? timeoutMs
  return new Promise((resolve, reject) => {
    const socket = netConnect(address)
    const client = new HostClient(socket, timeoutMs, runTimeoutMs)
    // 建连超时：对端接受但不完成连接时不得永久挂起；连上后解除空闲超时
    socket.setTimeout(timeoutMs, () => {
      client.close()
      reject(new ClientError('connect_timeout'))
    })
    socket.once('connect', () => {
      socket.setTimeout(0)
      resolve(client)
    })
    socket.once('error', (err) => {
      socket.setTimeout(0)
      client.close()
      reject(err)
    })
  })
}
