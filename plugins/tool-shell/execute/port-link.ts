// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与执行 / 密钥后端抽象。
// 本插件所有执行经 `port.call` 到 `sandbox.exec`、所有密钥解析经 `port.call` 到 `secrets.resolve`；
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）。
// 失败作数据（ToolError），不抛错、不断通道；单测用可注入的假后端替换真实通道。

import { ToolError, isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30000

type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

interface PendingCall {
  resolve: (outcome: PortOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一条服务连接上的反向调用登记表：`call` 发 `port.call` 并等待应答，
 * 帧循环收到 `port.result` / `port.error` 时调 `settle` 结算。
 */
export class PortLink {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private readonly write: (message: Json) => void
  private readonly timeoutMs: number

  constructor(write: (message: Json) => void, timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS) {
    this.write = write
    this.timeoutMs = timeoutMs
  }

  /** 发一条 `port.call` 并等待应答；超时 / 写失败作结构化错误。 */
  call(port: string, method: string, args: Rec): Promise<Json> {
    const id = `tool-shell-${this.seq}`
    this.seq += 1
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ToolError('tool_timeout', `${port}.${method} did not answer in time`))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (outcome) => {
          if (outcome.ok) resolve(outcome.value)
          else reject(new ToolError(outcome.code, outcome.message))
        },
        timer,
      })
      try {
        this.write({ v: '1', id, kind: 'port.call', port, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ToolError('transport_failed', (err as Error).message))
      }
    })
  }

  /** 宿主侧应答入口：`port.result` / `port.error` 按 id 结算；返回是否已消费该帧。 */
  settle(message: Rec): boolean {
    const kind = message['kind']
    if (kind !== 'port.result' && kind !== 'port.error') return false
    const id = message['id']
    if (typeof id !== 'string') return true
    const entry = this.pending.get(id)
    if (entry === undefined) return true
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (kind === 'port.result') {
      entry.resolve({ ok: true, value: (message['value'] ?? null) as Json })
    } else {
      entry.resolve({
        ok: false,
        code: typeof message['error'] === 'string' ? message['error'] : 'tool_failed',
        message: typeof message['message'] === 'string' ? message['message'] : '',
      })
    }
    return true
  }

  /** 断连 / 退出：未结算的调用全部作数据失败。 */
  failAll(code = 'transport_failed'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, code, message: 'link closed' })
    }
    this.pending.clear()
  }
}

/** 执行后端抽象：生产环境是反向调用 `sandbox.exec`，单测注入假后端。 */
export interface ExecBackend {
  exec(args: Rec): Promise<Rec>
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

  async exec(args: Rec): Promise<Rec> {
    const value = await this.link.call('sandbox', 'exec', args)
    if (!isRecord(value)) throw new ToolError('tool_failed', 'sandbox.exec returned a non-object')
    return value
  }
}

/** `secrets.resolve` 的反向调用后端：成功回明文（仅存调用方内存）。 */
export class RemoteSecrets implements SecretsBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async resolve(authRef: Rec): Promise<string> {
    const value = await this.link.call('secrets', 'resolve', { auth_ref: authRef })
    if (typeof value !== 'string' || value.length === 0) {
      throw new ToolError('secret_missing', 'secrets.resolve returned no value')
    }
    return value
  }
}
