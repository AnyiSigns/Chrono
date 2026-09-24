// 入站桥：浏览器侧 HTTP 动词 ↔ 宿主入站协议帧（docs/protocol.md §三）。
// 本文件只做**纯构造 / 解析**：帧形状与回包解释可脱离 socket 单测；
// 实际收发由 `inbound.ts` 的 Transport 承担（自实现入站客户端，不 import 客户端包）。
// 本插件 pins 只有 `model` / `secrets`：命令 / 提交都按名走入站面，eff 由入口 term 发出。

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
  if (typeof options.thread === 'string' && options.thread.length > 0) frame['thread'] = options.thread
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

/** `secrets.put` 帧：把密钥本体直写宿主本地文件（不进世界、不进审计）。 */
export function secretsPutFrame(id: string, name: string, value: string): Rec {
  return { v: PROTOCOL_VERSION, id, kind: 'secrets.put', name, value }
}

/** `secrets.delete` 帧：删除宿主本地文件里的密钥。 */
export function secretsDeleteFrame(id: string, name: string): Rec {
  return { v: PROTOCOL_VERSION, id, kind: 'secrets.delete', name }
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

/**
 * 从命令 / submit 回帧取业务值。
 * 两种形态：① 普通 eval 观测的 `value`；② 计划值 `{$directives:[…]}`——
 * 命令入口 term 若返回计划（如 `model.profile` 的写计划），业务数据在最后一条
 * `extern` 条目里，写条目由宿主自动落账；此处取 extern 载荷作客户端可见值。
 */
export function extractValue(frame: Rec | null): Json {
  if (frame === null) return null
  const observations = frame['observations']
  if (!Array.isArray(observations)) return null
  for (const observation of observations) {
    if (!isRecord(observation)) continue
    if (observation['kind'] === 'eval' && observation['value'] !== undefined) {
      return unwrapPlan(observation['value'] as Json)
    }
    if (observation['kind'] === 'extern' && observation['payload'] !== undefined) {
      return observation['payload'] as Json
    }
  }
  return null
}

/**
 * 计划值取最后一条 `extern` 载荷；非计划值原样返回。
 * `$directives` 是入站协议的保留计划标记：命令入口 term 回写计划是统一契约，故按值形状解包，
 * 不按命令名收窄——收窄需要维护命令白名单，且新命令一旦回计划就会被漏解。
 */
export function unwrapPlan(value: Json): Json {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return value
  for (let index = value['$directives'].length - 1; index >= 0; index--) {
    const item = value['$directives'][index]
    if (isRecord(item) && item['kind'] === 'extern' && item['payload'] !== undefined) {
      return item['payload'] as Json
    }
  }
  return null
}

/** 新请求 id（帧按 id 配对）。 */
export function newRequestId(prefix = 'ui-settings'): string {
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

  secretsPut(name: string, value: string): Promise<InboundResult> {
    return this.send(secretsPutFrame(newRequestId(), name, value))
  }

  secretsDelete(name: string): Promise<InboundResult> {
    return this.send(secretsDeleteFrame(newRequestId(), name))
  }

  /** 命令回包取值（本插件全部只读命令共用）。 */
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
