// 服务协议宿主侧：服务经 ServiceChannel 收发协议帧（stdio / inproc / worker 三种形态同协议）。
// 本文件只做请求 / 响应按 id 配对与上行 event 转交；通道实现（帧编解码 / 直调 / worker 消息）
// 在 assembly/service-host.ts，形态校验、健康判定、重启与隔离在 assembly 运行时。

import { randomUUID } from 'node:crypto'
import type { CallEnv } from './wire.ts'
import { isRecord, isStringArray } from './common/json.ts'
import type { Json } from '../kernel/index.ts'

/** 服务协议版本；与 `plugin.json.protocol` 同源口径，与入站协议版本独立。 */
export const SERVICE_PROTOCOL_VERSION = '1'

/** 服务传输形态：由 `plugin.json.transport` 声明；未声明 = `stdio`。 */
export type ServiceTransport = 'stdio' | 'inproc' | 'worker'

/**
 * 一条服务通道：只负责把 Json 协议帧送达对端 / 从对端接收，不解释协议语义。
 * stdio 形态编解码 4 字节长度前缀帧；inproc / worker 直传对象（结构化克隆）。
 */
export interface ServiceChannel {
  /** 发一帧；通道已关闭时抛错（调用方按「没执行」收口）。 */
  write(frame: Json): void
  /** 注册消息回调（单消费者：ServiceLink）。 */
  onMessage(cb: (message: Json) => void): void
  /** 注册对端关闭 / 帧损坏回调（宿主主动 `close()` 不触发）。 */
  onClose(cb: (reason: string) => void): void
  /** 主动关闭通道（stdio 关 stdin 触发服务自退出；inproc / worker 关闭其执行体）。 */
  close(): void
  /** 物理进程 pid；inproc / worker 无独立进程，为 `undefined`。 */
  readonly pid?: number
}

/**
 * 单次调用等待上限的硬上限（毫秒）：`setTimeout` 超过 2^31-1 会溢出成立即触发（1ms），
 * 故任何超时声明 / 选项都必须 ≤ 此值；超限按非法处理，不落到计时器。
 */
export const MAX_CALL_TIMEOUT_MS = 2 ** 31 - 1

export interface ServiceManifest {
  v: string
  identity: string
  implements: string[]
  methods: Record<string, string[]>
  protocol: string
  state: string
}

/** 一次能力调用的应答：服务侧有响应（result / error）即数据，形态不合按协议损坏。 */
export type CallResponse = { ok: true; value: Json } | { ok: false; code: string; message: string }

export type ServiceChannelErrorCode =
  'timeout' | 'closed' | 'protocol_error' | 'bad_manifest' | 'cancelled'

export class ServiceChannelError extends Error {
  readonly code: ServiceChannelErrorCode
  constructor(code: ServiceChannelErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ServiceChannelError'
    this.code = code
  }
}

interface Pending {
  expect: string | readonly string[]
  resolve: (message: Json) => void
  reject: (err: Error) => void
  /** 结算清理：清计时器、摘 abort 监听；结算路径（响应 / 超时 / 取消 / 断连）各调一次。 */
  cleanup: () => void
}

export interface ServiceLinkOptions {
  impl: string
  gen: string
  onEvent?: (topic: string, payload: Json) => void
  /**
   * 反向调用（protocol §2.4）：服务发 `port.call` 时由宿主按发出者身份 `pins` 路由后转发；
   * 返回值一律是数据（成功值或错误码），不抛错。`env` 取该连接上最近一条在途正向调用的
   * 回合信息（`undefined` 表示无在途调用，由调用方补宿主时钟）。
   */
  onPortCall?: (
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
  /** 对端关闭 / 帧损坏时回调一次（宿主主动 close 不触发）。 */
  onClosed?: (reason: string) => void
}

function isStringArrayMap(value: Json | undefined): value is Record<string, string[]> {
  if (!isRecord(value)) return false
  return Object.values(value).every(isStringArray)
}

/** manifest 形态解析；不合返回 null（语义覆盖校验在调用方）。 */
function parseManifest(value: Json): ServiceManifest | null {
  if (!isRecord(value)) return null
  if (typeof value['v'] !== 'string') return null
  if (typeof value['identity'] !== 'string' || value['identity'].length === 0) return null
  if (!isStringArray(value['implements'])) return null
  if (!isStringArrayMap(value['methods'])) return null
  if (typeof value['protocol'] !== 'string') return null
  if (typeof value['state'] !== 'string') return null
  return {
    v: value['v'] as string,
    identity: value['identity'] as string,
    implements: value['implements'] as string[],
    methods: value['methods'] as Record<string, string[]>,
    protocol: value['protocol'] as string,
    state: value['state'] as string,
  }
}

/** 一条服务连接：宿主经 `ServiceChannel` 收发帧，本类只做协议配对。 */
export class ServiceLink {
  readonly impl: string
  readonly gen: string
  private readonly channel: ServiceChannel
  private readonly pending = new Map<string, Pending>()
  private readonly onEvent?: (topic: string, payload: Json) => void
  private readonly onPortCall?: (
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
  private readonly onClosed?: (reason: string) => void
  /**
   * 在途正向调用的回合信息：帧 id → env。反向调用自带 `call_id`（= 该正向帧 id）时精确配对；
   * 未带时回落「最早已登记未结算」的 best-effort（Map 保插入序，队首即最早在途）。
   * 响应到达时在 `onMessage` 内同步摘除（处理同 chunk 后续消息之前）；超时 / 取消 / 断连同样摘除。
   */
  private readonly inflightEnvs = new Map<string, CallEnv>()
  /** 在途正向调用 / 控制请求计数：健康探针据此暂停（probe 会被服务排在在途请求之后，忙时必超时）。 */
  private inflightCalls = 0
  private closed = false

  constructor(channel: ServiceChannel, options: ServiceLinkOptions) {
    this.channel = channel
    this.impl = options.impl
    this.gen = options.gen
    this.onEvent = options.onEvent
    this.onPortCall = options.onPortCall
    this.onClosed = options.onClosed
    channel.onMessage((message) => this.onMessage(message))
    channel.onClose((reason) => this.markClosed(reason))
  }

  /** 发 hello 收 manifest；manifest 形态不合抛 `bad_manifest`。 */
  async handshake(timeoutMs: number): Promise<ServiceManifest> {
    const message = await this.request(
      'hello',
      { impl: this.impl, gen: this.gen },
      'manifest',
      timeoutMs,
    )
    const manifest = parseManifest(message)
    if (manifest === null) throw new ServiceChannelError('bad_manifest')
    return manifest
  }

  /** 控制探针；`ok:false` 视为不健康。 */
  async probe(timeoutMs: number): Promise<boolean> {
    const message = await this.request('probe', {}, 'pong', timeoutMs)
    return isRecord(message) && message['ok'] === true
  }

  /** 是否有在途正向调用 / 控制请求：忙时健康探针应暂停（probe 会被服务排在在途请求之后）。 */
  hasInflightCall(): boolean {
    return this.inflightCalls > 0
  }

  /**
   * 能力调用（protocol §2.2）：服务回 `result` / `error` 均为「有响应」。
   * `result` 的 `ok` 必须是 `true`、`error` 的 `ok` 必须是 `false`；形态不合抛协议损坏。
   * `signal` 中止（真取消）：不再等待（pending 摘除，晚到响应忽略），抛 `cancelled`——
   * 服务协议无取消消息，宿主侧「尽力 abort」即停止等待，不杀服务进程。
   */
  async call(
    port: string,
    method: string,
    args: Json,
    timeoutMs: number,
    signal?: AbortSignal,
    env?: CallEnv,
  ): Promise<CallResponse> {
    // 帧上填 `env`（不改 args 语义）；同时在途登记，供本连接的反向调用按帧 id 回带同一回合
    const fields: { [k: string]: Json } = { port, method, args }
    if (env !== undefined) fields['env'] = env as unknown as Json
    this.inflightCalls += 1
    try {
      const message = await this.request(
        'call',
        fields,
        ['result', 'error'],
        timeoutMs,
        signal,
        env,
      )
      const record = message as { [k: string]: Json }
      if (record['kind'] === 'error') {
        if (record['ok'] !== false) throw new ServiceChannelError('protocol_error')
        const code = typeof record['code'] === 'string' ? record['code'] : 'error'
        const text = typeof record['message'] === 'string' ? record['message'] : ''
        return { ok: false, code, message: text }
      }
      if (record['ok'] !== true) throw new ServiceChannelError('protocol_error')
      return { ok: true, value: (record['value'] ?? null) as Json }
    } finally {
      this.inflightCalls -= 1
    }
  }

  /** 数据换代热生效：通知服务新世代，服务回 ack（进程不动）。 */
  async reload(gen: string, timeoutMs: number): Promise<void> {
    // 计入在途：长 reload 期间健康探针须暂停（probe 排在 reload 之后，否则误判空闲 / 超时误杀）
    this.inflightCalls += 1
    try {
      await this.request('reload', { gen }, 'ack', timeoutMs)
    } finally {
      this.inflightCalls -= 1
    }
  }

  /** 排空：在途结束后服务回 bye。 */
  async drain(deadlineMs: number, timeoutMs: number): Promise<void> {
    this.inflightCalls += 1
    try {
      await this.request('drain', { deadline_ms: deadlineMs }, 'bye', timeoutMs)
    } finally {
      this.inflightCalls -= 1
    }
  }

  /** 宿主主动关闭通道（stdio end stdin，触发服务「断连自退出」义务；inproc / worker 关执行体）。 */
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.failPending()
    }
    this.channel.close()
  }

  private request(
    kind: string,
    fields: { [k: string]: Json },
    expect: string | readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    env?: CallEnv,
  ): Promise<Json> {
    if (this.closed) {
      return Promise.reject(new ServiceChannelError('closed'))
    }
    const id = randomUUID()
    return new Promise<Json>((resolve, reject) => {
      // settle 只生效一次：清计时器、摘 abort 监听、摘反向回带 env（防同一 signal 跨多次调用累积监听）
      let settled = false
      const cleanup = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.inflightEnvs.delete(id)
      }
      const onAbort = (): void => {
        if (settled) return
        this.pending.delete(id)
        cleanup()
        reject(new ServiceChannelError('cancelled'))
      }
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          cleanup()
          reject(new ServiceChannelError('timeout'))
        },
        Math.min(timeoutMs, MAX_CALL_TIMEOUT_MS),
      )
      timer.unref?.()
      if (signal !== undefined) {
        if (signal.aborted) {
          // 已取消：不发帧、不登记
          cleanup()
          reject(new ServiceChannelError('cancelled'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, { expect, resolve, reject, cleanup })
      // 按帧 id 登记反向回带 env：登记先于写帧，服务在同一 chunk 内先发 port.call 也能命中
      if (env !== undefined) this.inflightEnvs.set(id, env)
      try {
        this.channel.write({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields } as Json)
      } catch {
        this.pending.delete(id)
        cleanup()
        reject(new ServiceChannelError('closed'))
      }
    })
  }

  private onMessage(message: Json): void {
    if (!isRecord(message)) return
    if (message['kind'] === 'event') {
      const topic = message['topic']
      if (typeof topic === 'string') {
        this.onEvent?.(topic, (message['payload'] ?? null) as Json)
      }
      return
    }
    // 反向调用（服务 → 宿主）：宿主按发出者 pins 路由后转发，结果按原 id 回 port.result / port.error
    if (message['kind'] === 'port.call') {
      void this.handlePortCall(message)
      return
    }
    const id = message['id']
    if (typeof id !== 'string') {
      this.markClosed('protocol_error')
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    // 同步摘除该帧的 env：处理同 chunk 后续消息（含 port.call）之前，本调用已不再「在途」
    pending.cleanup()
    const expected = Array.isArray(pending.expect)
      ? pending.expect.includes(message['kind'] as string)
      : message['kind'] === pending.expect
    if (!expected) {
      pending.reject(new ServiceChannelError('protocol_error'))
      return
    }
    pending.resolve(message)
  }

  /** 反向调用：校验形态 → 交宿主路由转发 → 按原 id 回帧；失败一律作数据，不断通道。 */
  private async handlePortCall(message: { [k: string]: Json }): Promise<void> {
    const id = message['id']
    if (typeof id !== 'string') {
      this.markClosed('protocol_error')
      return
    }
    const port = message['port']
    const method = message['method']
    if (this.onPortCall === undefined || typeof port !== 'string' || typeof method !== 'string') {
      this.writePortResponse(id, {
        ok: false,
        code: 'not_loaded',
        message: 'port.call unavailable',
      })
      return
    }
    // env 精确配对：服务回带 `call_id`（= 该正向帧 id）时只认精确命中——命中用其 env，
    // 未命中返回 undefined 交宿主补时钟，不回落队首（否则并发在途会串台）。
    // 仅当完全不带 `call_id`（旧服务）才回落「最早已登记未结算」的 best-effort。
    const callId = message['call_id']
    const env =
      typeof callId === 'string' ? this.inflightEnvs.get(callId) : this.earliestInflightEnv()
    let response: CallResponse
    try {
      response = await this.onPortCall(port, method, (message['args'] ?? null) as Json, env)
    } catch {
      response = { ok: false, code: 'transport_failed', message: 'port.call failed' }
    }
    this.writePortResponse(id, response)
  }

  /** 最早已登记未结算的正向调用 env（Map 保插入序）；无在途 → undefined。 */
  private earliestInflightEnv(): CallEnv | undefined {
    for (const env of this.inflightEnvs.values()) return env
    return undefined
  }

  private writePortResponse(id: string, response: CallResponse): void {
    if (this.closed) return
    const frame: { [k: string]: Json } = response.ok
      ? { v: SERVICE_PROTOCOL_VERSION, id, kind: 'port.result', ok: true, value: response.value }
      : {
          // 反向 PortLink 属服务协议族（按 `ok` 判别），错误码字段沿用 `error`；
          // 入站与服务正向错误帧一律用 `code`。
          v: SERVICE_PROTOCOL_VERSION,
          id,
          kind: 'port.error',
          ok: false,
          error: response.code,
          message: response.message,
        }
    try {
      this.channel.write(frame as Json)
    } catch {
      // 通道已断：晚到的反向应答无处可回，忽略
    }
  }

  private markClosed(reason: string): void {
    if (this.closed) return
    this.closed = true
    // 协议损坏（帧内 JSON 非法）保留 protocol_error，供上层归 handshake.failed；其余通道断开归 closed
    this.failPending(reason === 'protocol_error' ? 'protocol_error' : 'closed')
    this.onClosed?.(reason)
  }

  private failPending(code: ServiceChannelErrorCode = 'closed'): void {
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(new ServiceChannelError(code))
    }
    this.pending.clear()
  }
}
