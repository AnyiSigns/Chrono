// 目录 / args 校验后端：生产环境经 SDK 反向调用通道发 `port.call tool-registry.list` /
// `tool-schema.validate-args`，单测注入假后端。失败作数据（结构化错误 / 拒绝原因），
// 不抛未捕获错误、不断通道；目录服务不可用按 fail-closed 抛 ServiceError。
// 多一跳须严格嵌套超时：按下游方法声明抬高单次反向等待。

import { ServiceError, isRecord } from 'plugin-sdk'
import type { Json, PortLink, Rec } from 'plugin-sdk'
import {
  indexDirectory,
  type Directory,
  type RegistryBackend,
  type SchemaBackend,
} from './dispatch.ts'

/** `tool-dispatch` → `tool-registry.list` 的等待上限；须 ≥ 下游声明（120000）。 */
export const REGISTRY_LIST_TIMEOUT_MS = 130_000

/** `tool-dispatch` → `tool-schema.validate-args` 的等待上限；须 ≥ 下游声明（2000）。 */
export const SCHEMA_TIMEOUT_MS = 10_000

/** `tool-registry.list` 的反向调用后端：回目录索引（含 byName）。 */
export class RemoteRegistry implements RegistryBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async list(bag: Rec): Promise<Directory> {
    const outcome = await this.link.call('tool-registry', 'list', bag, {
      timeoutMs: REGISTRY_LIST_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    return indexDirectory(outcome.value)
  }
}

/** `tool-schema.validate-args` 的反向调用后端：回 `{ok, message}`。 */
export class RemoteSchema implements SchemaBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async validateArgs(schema: Json, value: Json): Promise<{ ok: boolean; message: string }> {
    const outcome = await this.link.call(
      'tool-schema',
      'validate-args',
      { schema: schema ?? null, value },
      { timeoutMs: SCHEMA_TIMEOUT_MS },
    )
    if (!outcome.ok) return { ok: false, message: outcome.message }
    const record = isRecord(outcome.value) ? outcome.value : {}
    return {
      ok: record['ok'] === true,
      message: typeof record['message'] === 'string' ? record['message'] : '',
    }
  }
}
