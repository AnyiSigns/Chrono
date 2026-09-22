// 入站桥：浏览器侧 HTTP 动词 ↔ 宿主入站协议帧（docs/protocol.md §三）。
// 本文件只做**纯构造 / 解析**：帧形状与回包解释可脱离 socket 单测；
// 实际收发由 `inbound.ts` 的 Transport 承担（自实现入站客户端，不跨包 import）。
// 本插件无 pins：命令 / 提交都按名走入站面，不需要反向调用。

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
  caps?: Rec
  limits?: Rec
  thread?: string | null
}

function withOptions(frame: Rec, options: RequestOptions | undefined): Rec {
  if (options === undefined) return frame
  if (options.caps !== undefined) frame['caps'] = options.caps
  if (options.limits !== undefined) frame['limits'] = options.limits
  if (typeof options.thread === 'string' && options.thread.length > 0)
    frame['thread'] = options.thread
  return frame
}

/** `submit` 帧：提交 directives（写类指令 / eval）。 */
export function submitFrame(id: string, directives: Json, options?: RequestOptions): Rec {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'submit', directives }, options)
}

/** `command` 帧：按名调用插件声明的命令。 */
export function commandFrame(id: string, name: string, args: Json, options?: RequestOptions): Rec {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'command', name, args }, options)
}

/** `asset.get` 帧：按 sha256 取回资产字节。 */
export function assetGetFrame(id: string, sha256: string): Rec {
  return { v: PROTOCOL_VERSION, id, kind: 'asset.get', sha256 }
}

/** `cancel` 帧：真取消指定 run（≠ stop 停宿主）。 */
export function cancelFrame(id: string, run: string): Rec {
  return { v: PROTOCOL_VERSION, id, kind: 'cancel', run }
}

/** 解释一条宿主回帧：通道失败 / `error` 帧 / 正常回帧三态。 */
export function interpretResponse(result: InboundResult): InboundResult {
  if (!result.ok) {
    return {
      ok: false,
      frame: null,
      code: result.code || 'ui_unreachable',
      message: result.message,
    }
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

/** 从命令 / submit 回帧取业务值：eval 观测的 value，或 extern 观测的 payload。 */
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
export function newRequestId(prefix = 'ui-composer'): string {
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

  private async send(frame: Rec): Promise<InboundResult> {
    return interpretResponse(await this.transport.request(frame, this.timeoutMs))
  }

  submit(directives: Json, options?: RequestOptions): Promise<InboundResult> {
    return this.send(submitFrame(newRequestId(), directives, options))
  }

  command(name: string, args: Json, options?: RequestOptions): Promise<InboundResult> {
    return this.send(commandFrame(newRequestId(), name, args, options))
  }

  assetGet(sha256: string): Promise<InboundResult> {
    return this.send(assetGetFrame(newRequestId(), sha256))
  }

  cancel(run: string): Promise<InboundResult> {
    return this.send(cancelFrame(newRequestId(), run))
  }

  /** 命令回包取值（`input.read` / `config.read` / `chat.send` / `model.profile` 共用）。 */
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
