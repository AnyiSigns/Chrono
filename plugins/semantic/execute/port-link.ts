// 模型后端抽象：生产环境经 SDK 反向调用通道发 `port.call model.chat`，单测注入假后端。
// 失败作数据（BackendError），不抛未捕获错误、不断通道。
// 语义摘要是长调用：单次反向调用等待上限取 `model.chat` 的声明超时，严格小于本服务 `semantic.summarize`。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

/** `model.chat` 的反向调用等待上限（与 model-protocol 的 `model.chat` 声明一致）。 */
export const MODEL_TIMEOUT_MS = 3600000

/** 反向调用后端失败：带结构化码，调用方据此作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 模型后端抽象：生产环境是反向调用 `model.chat`，单测注入假后端。 */
export interface ModelBackend {
  chat(config: Rec, messages: Json[]): Promise<Rec>
}

/** 从模型服务回包里取结构化错误码（`{ok:false, error:{code}}`）。 */
function modelErrorCode(value: Rec): string {
  const error = value['error']
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'] as string
  return 'model_call_failed'
}

/** `model.chat` 的反向调用后端：成功回最终值，失败抛结构化 BackendError。 */
export class RemoteModel implements ModelBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async chat(config: Rec, messages: Json[]): Promise<Rec> {
    const outcome = await this.link.call(
      'model',
      'chat',
      { config, messages },
      { timeoutMs: MODEL_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value))
      throw new BackendError('model_call_failed', 'model.chat returned a non-object')
    if (outcome.value['ok'] === false) {
      throw new BackendError(modelErrorCode(outcome.value), 'model.chat reported failure')
    }
    return outcome.value
  }
}
