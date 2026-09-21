// 结构化错误：模型 IO 的失败以数据回灌调用方（协议帧仍 result、value 为 {ok:false,error}）。
// 错误码取固定词表，机械可测；retryable 决定韧性层是否重试。

import type { Json } from './types.ts'

export type ModelErrorCode =
  | 'model_auth_failed'
  | 'model_rate_limited'
  | 'model_bad_request'
  | 'model_server_error'
  | 'model_timeout'
  | 'model_stream_broken'
  | 'model_network_error'
  | 'model_unsupported'

export interface ModelErrorOptions {
  retryable?: boolean
  retryAfterMs?: number
}

/** 模型调用失败：携带错误码与是否可重试。 */
export class ModelError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(code: string, message: string, options: ModelErrorOptions = {}) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs
  }
}

/** 失败值形状：调用方据 `error.code` 分支（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Json {
  return { ok: false, error: { code, message } }
}

/**
 * 解析 `Retry-After`（秒数或 HTTP 日期）；无法解析返回 null。
 * `now` 由调用方传入（协议帧 `env.now`）——HTTP 日期形式需要参照当前时刻，服务不自取时钟。
 */
export function parseRetryAfter(headers: Record<string, string>, now: number): number | null {
  const raw = headers['retry-after']
  if (raw === undefined) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}

/** 按 HTTP 状态码归类为模型错误；2xx 返回 null。 */
export function classifyHttpStatus(status: number, retryAfterMs: number | null): ModelError | null {
  if (status >= 200 && status < 300) return null
  const detail = `http ${status}`
  if (status === 401 || status === 403) return new ModelError('model_auth_failed', detail)
  if (status === 429) {
    return new ModelError('model_rate_limited', detail, {
      retryable: true,
      retryAfterMs: retryAfterMs ?? undefined,
    })
  }
  if (status >= 400 && status < 500) return new ModelError('model_bad_request', detail)
  if (status >= 500) return new ModelError('model_server_error', detail, { retryable: true })
  return new ModelError('model_unsupported', detail)
}
