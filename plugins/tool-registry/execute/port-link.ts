// argsSchema / caps 校验后端：生产环境经 SDK 反向调用通道发 `port.call tool-schema.*`，
// 单测注入假后端。校验失败（含通道失败）作数据回结构化原因，不抛未捕获错误、不断通道。
// 多一跳须严格嵌套超时：按下游方法声明抬高单次反向等待。

import { isRecord } from 'plugin-sdk'
import type { Json, PortLink, Rec } from 'plugin-sdk'
import type { CapsOutcome, DeclOutcome, SchemaBackend } from './directory.ts'

/** `tool-registry` → `tool-schema.*` 的等待上限；须 ≥ 下游方法声明（2000）。 */
export const SCHEMA_TIMEOUT_MS = 10_000

/** `tool-schema` 的反向调用后端：严格 / 宽松 schema 校验与 caps 归一。 */
export class RemoteToolSchema implements SchemaBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async normalizeDecl(schema: Json | undefined, lenient: boolean): Promise<DeclOutcome> {
    const outcome = await this.link.call(
      'tool-schema',
      'normalize-decl',
      { schema: schema ?? null, lenient },
      { timeoutMs: SCHEMA_TIMEOUT_MS },
    )
    if (!outcome.ok) return { ok: false, message: outcome.message, schema: null }
    const value = isRecord(outcome.value) ? outcome.value : {}
    return {
      ok: value['ok'] === true,
      message: typeof value['message'] === 'string' ? value['message'] : '',
      schema: (value['schema'] ?? null) as Json,
    }
  }

  async normalizeCaps(caps: Json | undefined, lenient: boolean): Promise<CapsOutcome> {
    const outcome = await this.link.call(
      'tool-schema',
      'normalize-caps',
      { caps: caps ?? null, lenient },
      { timeoutMs: SCHEMA_TIMEOUT_MS },
    )
    if (!outcome.ok) return { ok: false, message: outcome.message, caps: null }
    const value = isRecord(outcome.value) ? outcome.value : {}
    return {
      ok: value['ok'] === true,
      message: typeof value['message'] === 'string' ? value['message'] : '',
      caps: isRecord(value['caps']) ? (value['caps'] as Rec) : null,
    }
  }
}
