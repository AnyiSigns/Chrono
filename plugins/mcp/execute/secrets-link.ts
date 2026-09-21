// 反向调用（服务 → 宿主，docs/protocol.md §2.4）：本插件 `pins` 含 `{"secrets":"secrets"}`，
// 故可按逻辑端口 `secrets` 调 `resolve` 解析 `auth_ref`，把明文注入外部 MCP 子进程 env。
// 帧方向：服务发 `port.call`，宿主按发出者 pins 路由后回 `port.result` / `port.error`（按 id 配对）。
// 明文只活在调用方内存，绝不进日志 / 世界 / 计划。

import { randomUUID } from 'node:crypto'
import { writeFrame } from './frames.ts'
import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const SECRETS_CALL_TIMEOUT_MS = 30000

interface PendingCall {
  resolve: (result: { ok: true; value: Json } | { ok: false; code: string; message: string }) => void
  timer: ReturnType<typeof setTimeout>
}

/** `secrets.resolve` 的返回：成功给明文，失败给结构化码（作数据，不抛错、不断通道）。 */
export type SecretResult = { ok: true; value: string } | { ok: false; code: string; message: string }

/** 一条服务连接上的反向调用登记表；`main.ts` 收到 `port.result` / `port.error` 时调 `resolve`。 */
export class SecretsLink {
  private readonly pending = new Map<string, PendingCall>()

  /** 解析一条 `auth_ref`；失败作数据回结构化错误（不抛错）。 */
  async resolve(authRef: Rec): Promise<SecretResult> {
    const id = `mcp-pc-${randomUUID()}`
    const response = await new Promise<
      { ok: true; value: Json } | { ok: false; code: string; message: string }
    >((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: 'secrets call timeout' })
      }, SECRETS_CALL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      writeFrame({
        v: '1',
        id,
        kind: 'port.call',
        port: 'secrets',
        method: 'resolve',
        args: { auth_ref: authRef },
      })
    })
    if (!response.ok) return response
    if (typeof response.value !== 'string' || response.value.length === 0) {
      return { ok: false, code: 'secret_missing', message: 'secrets.resolve returned no value' }
    }
    return { ok: true, value: response.value }
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
        code: typeof message['error'] === 'string' ? message['error'] : 'error',
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

/** 把 env 值里的 auth_ref 形态解析出来；非引用返回 null。 */
export function authRefOf(value: Json): Rec | null {
  if (!isRecord(value)) return null
  const ref = value['auth_ref']
  return isRecord(ref) ? ref : null
}
