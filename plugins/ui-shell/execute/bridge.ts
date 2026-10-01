// ui-shell 专属入站桥：通用帧构造 / 回包解释复用 `plugin-sdk/web`，本文件只加壳自身的
// `config.read` 拆解（配置本体 / active / 数据世代）并转发 `deriveBootMode`。
// 纯构造 / 解析，不 import packages/client。

import { Bridge as BaseBridge, extractValue } from 'plugin-sdk/web'
import { deriveBootMode } from './web/lib/boot-mode.js'
import { identityActive, identityBody, identityDataGen } from './web/lib/identity-shape.js'
import type { Json } from './types.ts'

export {
  PROTOCOL_VERSION,
  assetGetFrame,
  assetPutFrame,
  cancelFrame,
  commandFrame,
  extractValue,
  forwardFrame,
  interpretResponse,
  newRequestId,
  submitFrame,
  unwrapPlan,
} from 'plugin-sdk/web'
export type { InboundResult, RequestOptions, Transport } from 'plugin-sdk/web'
export { deriveBootMode }

/**
 * 在共享桥之上加壳专属的配置读：命令返回整份 config 身份视图，
 * 这里拆出 `body`（配置本体，无配置判据 / 主题读改写的共同数据源）与 `active`（写 `add_gen` 的 `expect_active`）。
 */
export class Bridge extends BaseBridge {
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
