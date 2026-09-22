// 入站桥：浏览器侧 HTTP 动词 ↔ 宿主入站协议帧（docs/protocol.md §三）。
// 本文件只做**纯构造 / 解析**：帧形状与回包解释可脱离 socket 单测；
// 实际收发由 `inbound.ts` 的 Transport 承担（自实现入站客户端，不 import 客户端库）。
// 本插件无 pins、不写世界：只按名调只读命令 `threads.state`。

import { randomUUID } from 'node:crypto'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 入站协议版本（与服务协议 `protocol` 独立）。 */
export const PROTOCOL_VERSION = '1'

/** 一条入站请求的应答：`ok:false` 表示通道 / 协议层失败，`frame` 为宿主回帧。 */
export interface InboundResult {
  ok: boolean
  frame: Rec | null
  code: string
  message: string
}

/** 入站传输抽象：InboundClient 实现之；单测可用假 Transport 驱动。 */
export interface Transport {
  request(frame: Rec, timeoutMs?: number): Promise<InboundResult>
  isConnected(): boolean
}

export interface RequestOptions {
  thread?: string | null
}

function withOptions(frame: Rec, options: RequestOptions | undefined): Rec {
  if (options === undefined) return frame
  if (typeof options.thread === 'string' && options.thread.length > 0) frame['thread'] = options.thread
  return frame
}

/** `command` 帧：按名调用插件声明的命令。 */
export function commandFrame(id: string, name: string, args: Json, options?: RequestOptions): Rec {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'command', name, args }, options)
}

/** 解释一条宿主回帧：通道失败 / `error` 帧 / 正常回帧三态。 */
export function interpretResponse(result: InboundResult): InboundResult {
  if (!result.ok) {
    return { ok: false, frame: null, code: result.code || 'ui_unreachable', message: result.message }
  }
  const frame = result.frame
  if (frame !== null && frame['kind'] === 'error') {
    return {
      ok: false,
      frame,
      code: typeof frame['code'] === 'string' ? frame['code'] : 'internal',
      message: typeof frame['message'] === 'string' ? frame['message'] : '',
    }
  }
  return { ok: true, frame, code: '', message: '' }
}

/** 从命令回帧取业务值：eval 观测的 value，或 extern 观测的 payload。 */
export function extractValue(frame: Rec | null): Json {
  if (frame === null) return null
  const observations = frame['observations']
  if (!Array.isArray(observations)) return null
  for (const observation of observations) {
    if (!isRecord(observation)) continue
    if (observation['kind'] === 'eval' && observation['value'] !== undefined) {
      return observation['value'] as Json
    }
    if (observation['kind'] === 'extern' && observation['payload'] !== undefined) {
      return observation['payload'] as Json
    }
  }
  return null
}

/** 新请求 id（帧按 id 配对）。 */
export function newRequestId(prefix = 'ui-threads'): string {
  return `${prefix}-${randomUUID()}`
}

/** 高层入站操作：只负责构造帧、发请求、解释回帧。 */
export class Bridge {
  private readonly transport: Transport
  private readonly timeoutMs: number

  constructor(transport: Transport, timeoutMs = 15000) {
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  connected(): boolean {
    return this.transport.isConnected()
  }

  async command(name: string, args: Json, options?: RequestOptions): Promise<InboundResult> {
    return interpretResponse(
      await this.transport.request(commandFrame(newRequestId(), name, args, options), this.timeoutMs),
    )
  }

  /** 命令回包取值（`threads.state` 用）。 */
  async commandValue(
    name: string,
    args: Json,
    options?: RequestOptions,
  ): Promise<{ ok: boolean; value: Json; code: string; message: string; frame: Rec | null }> {
    const result = await this.command(name, args, options)
    return {
      ok: result.ok,
      value: result.ok ? extractValue(result.frame) : null,
      code: result.code,
      message: result.message,
      frame: result.frame,
    }
  }
}
