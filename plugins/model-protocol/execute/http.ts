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
  /**
   * `httpStream` 未消费兜底 TTL（毫秒）：resolve 后调用方迟迟不迭代时，到点销毁上游 socket。
   * 缺省 {@link UNCONSUMED_STREAM_TTL_MS}；首次迭代即解除兜底。
   */
  unconsumed_ttl_ms?: number
}

/** 未消费流兜底 TTL 缺省值：足够调用方排队迭代，又不至于让遗弃的流长期占用 socket。 */
export const UNCONSUMED_STREAM_TTL_MS = 30_000

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
      // 不在响应头处封死错误通道：body 阶段的 socket 超时 / 断连仍须经 onError 结算（结算方幂等）。
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
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof ModelError ? err : toNetworkError(err as Error))
    }
    const succeed = (result: HttpResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    openRequest(
      options,
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', fail)
        // 响应体读完前连接关闭（未 complete）即明确失败，避免 body 阶段悬挂。
        res.on('close', () => {
          if (!res.complete) {
            fail(new ModelError('model_network_error', 'response closed before completion', { retryable: true }))
          }
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const headers = normalizeHeaders(res.headers)
          const status = res.statusCode ?? 0
          const failure = status >= 200 && status < 300 ? null : classify(status, headers, body)
          if (failure !== null) fail(failure)
          else succeed({ status, headers, body })
        })
      },
      fail,
    )
  })
}

/** 打开流式响应；非 2xx 先收完整 body 再抛结构化错误。 */
export function httpStream(options: HttpOptions): Promise<HttpStream> {
  return new Promise<HttpStream>((resolve, reject) => {
    const classify =
      options.classify ?? ((status, headers, body) => defaultClassify(status, headers, body, options.now))
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof ModelError ? err : toNetworkError(err as Error))
    }
    openRequest(
      options,
      (res) => {
        const status = res.statusCode ?? 0
        const headers = normalizeHeaders(res.headers)
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => fail(classify(status, headers, Buffer.concat(chunks).toString('utf8'))))
          res.on('error', fail)
          res.on('close', () => {
            if (!res.complete) {
              fail(new ModelError('model_network_error', 'response closed before completion', { retryable: true }))
            }
          })
          return
        }
        settled = true
        // 迭代前 error 监听：否则响应在调用方迭代前出错会因无监听者冒成未捕获异常（已销毁状态由 readStream 起始判定兜住）。
        res.on('error', () => {})
        // 未消费兜底：调用方拿到流后若从不迭代，readStream 的 finally 永不执行，socket 会一直挂着；
        // 到点销毁上游，迭代一旦开始即解除兜底（正常结束 / 提前退出由 close 或 finally 清理）。
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          res.destroy()
        }, options.unconsumed_ttl_ms ?? UNCONSUMED_STREAM_TTL_MS)
        timer.unref?.()
        res.once('close', () => {
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
        })
        resolve({
          status,
          headers,
          chunks: readStream(res, () => {
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
          }),
        })
      },
      fail,
    )
  })
}

/** 把响应体转成文本分片异步生成器；提前断开抛 model_stream_broken。`onStart` 在首次迭代时回调。 */
async function* readStream(res: http.IncomingMessage, onStart?: () => void): AsyncGenerator<string> {
  onStart?.()
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
  // 生成器惰性执行：监听器挂上之前响应可能已结束 / 断开，先按流状态补齐，避免永久等待。
  if (res.readableEnded) done = true
  else if (res.destroyed) failure = new ModelError('model_stream_broken', 'stream closed early', { retryable: true })
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
  try {
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
  } finally {
    // 消费方提前退出（break / 抛错 / 生成器被弃）时销毁响应，释放 socket，避免重试期间多路流并存。
    if (!done) res.destroy()
  }
}
