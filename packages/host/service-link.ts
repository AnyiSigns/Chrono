// 服务协议宿主侧：服务 = 宿主 spawn 的子进程，协议帧走其 stdin/stdout（日志走 stderr）。
// 本文件只做帧编解码、请求 / 响应按 id 配对与上行 event 转交；
// 形态校验、健康判定、重启与隔离在 assembly 运行时。

import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { createFrameDecoder, encodeFrame } from './wire.ts'
import type { Json } from '../kernel/index.ts'

/** 服务协议版本；与 `plugin.json.protocol` 同源口径，与入站协议版本独立。 */
export const SERVICE_PROTOCOL_VERSION = '1'

export interface ServiceManifest {
  v: string
  identity: string
  implements: string[]
  methods: Record<string, string[]>
  protocol: string
  state: string
}

export type ServiceChannelErrorCode = 'timeout' | 'closed' | 'protocol_error' | 'bad_manifest'

export class ServiceChannelError extends Error {
  readonly code: ServiceChannelErrorCode
  constructor(code: ServiceChannelErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ServiceChannelError'
    this.code = code
  }
}

interface Pending {
  expect: string
  resolve: (message: Json) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface ServiceLinkOptions {
  impl: string
  gen: string
  onEvent?: (topic: string, payload: Json) => void
  /** 对端关闭 / 帧损坏时回调一次（宿主主动 close 不触发）。 */
  onClosed?: (reason: string) => void
}

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: Json | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
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

/** 一条服务连接：宿主 → 服务写 stdin，服务 → 宿主读 stdout。 */
export class ServiceLink {
  readonly impl: string
  readonly gen: string
  private readonly child: ChildProcess
  private readonly decoder = createFrameDecoder()
  private readonly pending = new Map<string, Pending>()
  private readonly onEvent?: (topic: string, payload: Json) => void
  private readonly onClosed?: (reason: string) => void
  private closed = false

  constructor(child: ChildProcess, options: ServiceLinkOptions) {
    this.child = child
    this.impl = options.impl
    this.gen = options.gen
    this.onEvent = options.onEvent
    this.onClosed = options.onClosed
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stdout?.on('error', () => this.markClosed('channel_error'))
    child.stdout?.on('end', () => this.markClosed('channel_closed'))
    child.stdin?.on('error', () => {
      // 写失败由 request 的写回调归类；此处防止未处理的 stream error 打崩宿主
    })
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

  /** 排空：在途结束后服务回 bye。 */
  async drain(deadlineMs: number, timeoutMs: number): Promise<void> {
    await this.request('drain', { deadline_ms: deadlineMs }, 'bye', timeoutMs)
  }

  /** 宿主主动关闭通道（end stdin，触发服务「断连自退出」义务）。 */
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.failPending()
    }
    try {
      this.child.stdin?.end()
    } catch {
      // 通道可能已断；关闭是幂等的
    }
  }

  private request(
    kind: string,
    fields: { [k: string]: Json },
    expect: string,
    timeoutMs: number,
  ): Promise<Json> {
    const stdin = this.child.stdin
    if (this.closed || stdin === null || stdin === undefined || stdin.destroyed) {
      return Promise.reject(new ServiceChannelError('closed'))
    }
    const id = randomUUID()
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ServiceChannelError('timeout'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { expect, resolve, reject, timer })
      stdin.write(
        encodeFrame({ v: SERVICE_PROTOCOL_VERSION, id, kind, ...fields } as Json),
        (err) => {
          if (err) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(new ServiceChannelError('closed'))
          }
        },
      )
    })
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    let messages: Json[]
    try {
      messages = this.decoder.push(chunk)
    } catch {
      this.markClosed('protocol_error')
      return
    }
    for (const message of messages) this.onMessage(message)
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
    const id = message['id']
    if (typeof id !== 'string') {
      this.markClosed('protocol_error')
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message['kind'] !== pending.expect) {
      pending.reject(new ServiceChannelError('protocol_error'))
      return
    }
    pending.resolve(message)
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
      clearTimeout(pending.timer)
      pending.reject(new ServiceChannelError(code))
    }
    this.pending.clear()
  }
}
