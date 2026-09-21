// 有界 HTTP 客户端：node 内置 http / https，支持一次性读取与流式读取（SSE 用）。
// 非 2xx 由 classify 归成结构化错误；网络 / 超时 / 流断分别归 model_network_error / model_timeout / model_stream_broken。

import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { ModelError, classifyHttpStatus, parseRetryAfter } from './errors.ts'
import type { Rec } from './types.ts'

export interface HttpOptions {
  method: 'GET' | 'POST'
  url: string
  headers: Rec
  body?: string
  timeout_ms: number
  /** 宿主固定时钟（协议帧 `env.now`）：解析 HTTP 日期形式的 `Retry-After` 时作参照，不自取时间。 */
  now: number
  /** 非 2xx 归类；缺省按模型错误词表（429 带 Retry-After）。 */
  classify?: (status: number, headers: Rec, body: string) => Error
}

export interface HttpResult {
  status: number
  headers: Rec
  body: string
}

export interface HttpStream {
  status: number
  headers: Rec
  chunks: AsyncGenerator<string>
}

function normalizeHeaders(raw: http.IncomingHttpHeaders): Rec {
  const headers: Rec = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

function defaultClassify(status: number, headers: Rec, _body: string, now: number): Error {
  const retryAfterMs = parseRetryAfter(headers as Record<string, string>, now)
  return classifyHttpStatus(status, retryAfterMs) ?? new Error('unexpected status')
}

function toNetworkError(err: Error): ModelError {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ETIMEDOUT') return new ModelError('model_timeout', err.message, { retryable: true })
  return new ModelError('model_network_error', err.message, { retryable: true })
}

type ResponseHandler = (res: http.IncomingMessage) => void

function openRequest(options: HttpOptions, onResponse: ResponseHandler, onError: (err: Error) => void): void {
  const target = new URL(options.url)
  const client = target.protocol === 'https:' ? https : http
  const headers: http.OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(options.headers)) {
    if (typeof value === 'string') headers[key] = value
  }
  let settled = false
  const fail = (err: Error): void => {
    if (settled) return
    settled = true
    onError(err instanceof ModelError ? err : toNetworkError(err))
  }
  const request = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
    },
    (res) => {
      settled = true
      onResponse(res)
    },
  )
  request.setTimeout(options.timeout_ms, () => {
    request.destroy(new ModelError('model_timeout', 'request timed out', { retryable: true }))
  })
  request.on('error', fail)
  if (options.body !== undefined) request.write(options.body)
  request.end()
}

/** 一次性读取完整响应体；非 2xx 抛结构化错误。 */
export function httpRequest(options: HttpOptions): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const classify =
      options.classify ?? ((status, headers, body) => defaultClassify(status, headers, body, options.now))
    openRequest(
      options,
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', (err: Error) => reject(toNetworkError(err)))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const headers = normalizeHeaders(res.headers)
          const status = res.statusCode ?? 0
          const failure = status >= 200 && status < 300 ? null : classify(status, headers, body)
          if (failure !== null) reject(failure)
          else resolve({ status, headers, body })
        })
      },
      reject,
    )
  })
}

/** 打开流式响应；非 2xx 先收完整 body 再抛结构化错误。 */
export function httpStream(options: HttpOptions): Promise<HttpStream> {
  return new Promise<HttpStream>((resolve, reject) => {
    const classify =
      options.classify ?? ((status, headers, body) => defaultClassify(status, headers, body, options.now))
    openRequest(
      options,
      (res) => {
        const status = res.statusCode ?? 0
        const headers = normalizeHeaders(res.headers)
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => reject(classify(status, headers, Buffer.concat(chunks).toString('utf8'))))
          res.on('error', (err: Error) => reject(toNetworkError(err)))
          return
        }
        resolve({ status, headers, chunks: readStream(res) })
      },
      reject,
    )
  })
}

/** 把响应体转成文本分片异步生成器；提前断开抛 model_stream_broken。 */
async function* readStream(res: http.IncomingMessage): AsyncGenerator<string> {
  const queue: string[] = []
  let done = false
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const notify = (): void => {
    if (wake !== null) {
      wake()
      wake = null
    }
  }
  // 多字节字符可能跨 TCP 块：用 StringDecoder 按字节流解码，避免逐块 toString 截断字符
  const decoder = new StringDecoder('utf8')
  res.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk)
    if (text.length > 0) queue.push(text)
    notify()
  })
  res.on('end', () => {
    const tail = decoder.end()
    if (tail.length > 0) queue.push(tail)
    done = true
    notify()
  })
  res.on('close', () => {
    if (!done) {
      failure = new ModelError('model_stream_broken', 'stream closed early', { retryable: true })
      notify()
    }
  })
  res.on('error', (err: Error) => {
    failure = new ModelError('model_stream_broken', err.message, { retryable: true })
    notify()
  })
  for (;;) {
    if (queue.length > 0) {
      yield queue.shift() as string
      continue
    }
    if (failure !== null) throw failure
    if (done) return
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
}
