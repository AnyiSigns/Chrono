// 模型后端抽象：生产环境经 SDK 反向调用通道发 `port.call model.complete`（非流式、不发 model.delta），
// 单测注入假后端。失败作数据（BackendError），不抛未捕获错误、不断通道。
// 单次调用超时由本插件按 `timeout_ms` 收口：超时作结构化失败，在途帧的迟到应答被忽略。

import { isRecord } from 'plugin-sdk'
import type { Json, PortCaller, PortOutcome, Rec } from 'plugin-sdk'

/** 反向调用后端失败：带结构化码，调用方据此兜底或作数据回灌。 */
export class BackendError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** 模型后端抽象：生产环境是反向调用 `model.complete`，单测注入假后端。 */
export interface ModelBackend {
  complete(config: Rec, messages: Json[], maxTokens: number, timeoutMs: number): Promise<Rec>
}

/** 从模型服务回包里取结构化错误码（`{ok:false, error:{code}}`）。 */
function modelErrorCode(value: Rec): string {
  const error = value['error']
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'] as string
  return 'model_call_failed'
}

/** 单次调用超时：超时作结构化失败（在途帧不取消，迟到应答被忽略）。 */
function withTimeout(pending: Promise<PortOutcome>, timeoutMs: number): Promise<PortOutcome> {
  return new Promise<PortOutcome>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, code: 'transport_failed', message: 'model.complete timeout' })
    }, timeoutMs)
    timer.unref?.()
    void pending.then((outcome) => {
      clearTimeout(timer)
      resolve(outcome)
    })
  })
}

/** `model.complete` 的反向调用后端：成功回回包，失败抛结构化 BackendError。 */
export class RemoteModel implements ModelBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async complete(config: Rec, messages: Json[], maxTokens: number, timeoutMs: number): Promise<Rec> {
    const outcome = await withTimeout(
      this.link.call('model', 'complete', { config, messages, max_tokens: maxTokens }),
      timeoutMs,
    )
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new BackendError('model_call_failed', 'model.complete returned a non-object')
    if (outcome.value['ok'] === false) {
      throw new BackendError(modelErrorCode(outcome.value), 'model.complete reported failure')
    }
    return outcome.value
  }
}
