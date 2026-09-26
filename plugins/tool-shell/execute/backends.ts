// 反向调用后端（服务 → 宿主，docs/protocol.md §2.4）与执行 / 密钥抽象。
// 通道由 plugin-sdk 的 PortLink 提供；本模块只保留插件域语义：按声明 caps 推导的反向等待预算，
// 以及 `sandbox.exec` / `secrets.resolve` 的后端适配。失败作数据（ToolError），不抛未捕获错误、不断通道。

import { PortLink, isRecord } from 'plugin-sdk'
import type { Json, Rec } from 'plugin-sdk'
import { ToolError } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30000

/** 反向等待在声明执行超时之上的固定余量：保证「宿主调用超时 > 反向等待 > 执行超时」。 */
export const REVERSE_TIMEOUT_MARGIN_MS = 5000

/** 宿主 `tool-shell.invoke` 的调用超时（与 schema/tool-shell.json 的 method_timeouts 一致）。 */
export const HOST_METHOD_TIMEOUT_MS = 130000

/**
 * 执行预算 / 反向等待上界：宿主预算减固定余量再留 1ms，
 * 保证 host > reverse > exec 严格成立——声明再大也不击穿宿主正向超时。
 */
export const MAX_CAPS_TIMEOUT_MS = HOST_METHOD_TIMEOUT_MS - REVERSE_TIMEOUT_MARGIN_MS - 1

/** Node 定时器可接受的最大延时；超过会溢出为 1ms（反向等待必须 clamp 在此之下）。 */
export const TIMER_MAX_MS = 2 ** 31 - 1

/** 通道兜底：逐次等待由调用方经 `PortLink.call` 的 `timeoutMs` 覆盖，通道缺省设在上界。 */
export function createLink(write: (message: Json) => void): PortLink {
  return new PortLink({ write, idPrefix: 'tool-shell', timeoutMs: HOST_METHOD_TIMEOUT_MS })
}

/** 执行后端抽象：生产环境是反向调用 `sandbox.exec`，单测注入假后端。 */
export interface ExecBackend {
  exec(args: Rec, timeoutMs?: number): Promise<Rec>
}

/** 密钥后端抽象：生产环境是反向调用 `secrets.resolve`，单测注入假后端。 */
export interface SecretsBackend {
  resolve(authRef: Rec): Promise<string>
}

/** `sandbox.exec` 的反向调用后端：成功回执行结果值，前置失败抛结构化错误。 */
export class RemoteExec implements ExecBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async exec(args: Rec, timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<Rec> {
    const outcome = await this.link.call('sandbox', 'exec', args, { timeoutMs })
    if (!outcome.ok) throw new ToolError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new ToolError('tool_failed', 'sandbox.exec returned a non-object')
    return outcome.value
  }
}

/** `secrets.resolve` 的反向调用后端：成功回明文（仅存调用方内存）。 */
export class RemoteSecrets implements SecretsBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async resolve(authRef: Rec): Promise<string> {
    const outcome = await this.link.call('secrets', 'resolve', { auth_ref: authRef }, {
      timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new ToolError(outcome.code, outcome.message)
    if (typeof outcome.value !== 'string' || outcome.value.length === 0) {
      throw new ToolError('secret_missing', 'secrets.resolve returned no value')
    }
    return outcome.value
  }
}
