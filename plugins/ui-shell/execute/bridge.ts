// 入站桥：浏览器侧 HTTP 动词 ↔ 宿主入站协议帧（docs/protocol.md §三）。
// 本文件只做**纯构造 / 解析**：帧形状与回包解释可脱离 socket 单测；
// 实际收发由 `inbound.ts` 的 Transport 承担（自实现入站客户端，不 import packages/client）。

import { randomUUID } from 'node:crypto'
import { deriveBootMode } from './web/lib/boot-mode.js'
import { identityActive, identityBody, identityDataGen } from './web/lib/identity-shape.js'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

export { deriveBootMode }

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
  return withOptions(
    { v: PROTOCOL_VERSION, id, kind: 'submit', directives },
    options,
  )
}

/** `command` 帧：按名调用插件声明的命令。 */
export function commandFrame(id: string, name: string, args: Json, options?: RequestOptions): Rec {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'command', name, args }, options)
}

/** `forward` 帧：插件入站转发（壳把 `/p/<id>/*` 表外路径转成此帧）。 */
export function forwardFrame(
  id: string,
  identity: string,
  command: string,
  args: Json,
  options?: RequestOptions,
): Rec {
  return withOptions({ v: PROTOCOL_VERSION, id, kind: 'forward', identity, command, args }, options)
}

/** `asset.put` 帧：字节直写宿主资产区（base64 规范编码）。 */
export function assetPutFrame(id: string, mime: string, bytes: string): Rec {
  return { v: PROTOCOL_VERSION, id, kind: 'asset.put', mime, bytes }
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
 * 从命令 / submit 回帧取业务值：eval 观测的 value，或 extern 观测的 payload。
 * 命令入口 term 返回写计划（`{$directives:[…]}`）时，业务数据在最后一条 `extern` 条目里，
 * 写条目由宿主自动落账；此处取 extern 载荷作客户端可见值（与插件服务侧 bridge 口径一致）。
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
 * 计划值取最后一条 `extern` 载荷；非计划值原样返回（无 extern 条目回 null）。
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
export function newRequestId(prefix = 'ui-shell'): string {
  return `${prefix}-${randomUUID()}`
}

/**
 * 无配置判据：`config.read` 返回值里存在至少一个已启用模型条目（`providers.*.models.*` 且
 * `enabled !== false`）⇒ 引导完成（`ready`），否则 `onboarding`。
 * 壳自身不读投影，判据只来自命令返回值。实现与浏览器侧共用 `web/lib/boot-mode.js`。
 */

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

  forward(identity: string, command: string, args: Json, options?: RequestOptions): Promise<InboundResult> {
    return this.send(forwardFrame(newRequestId(), identity, command, args, options))
  }

  assetPut(mime: string, bytes: string): Promise<InboundResult> {
    return this.send(assetPutFrame(newRequestId(), mime, bytes))
  }

  assetGet(sha256: string): Promise<InboundResult> {
    return this.send(assetGetFrame(newRequestId(), sha256))
  }

  cancel(run: string): Promise<InboundResult> {
    return this.send(cancelFrame(newRequestId(), run))
  }

  /**
   * 读 config（`config.read` 命令）：命令返回整份 config 身份视图，
   * 这里拆出 `body`（配置本体，无配置判据 / 主题读改写的共同数据源）与 `active`
   * （写 `add_gen` 的 `expect_active`）。
   */
  async configRead(): Promise<{
    ok: boolean
    value: Json
    active: string | null | undefined
    dataGen: Json
    code: string
    message: string
  }> {
    const result = await this.command('config.read', null)
    const raw = result.ok ? extractValue(result.frame) : null
    return {
      ok: result.ok,
      value: identityBody(raw),
      active: identityActive(raw),
      dataGen: identityDataGen(raw) ?? null,
      code: result.code,
      message: result.message,
    }
  }
}
