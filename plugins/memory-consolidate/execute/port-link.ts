// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与向量化 / 摘要后端抽象。
// 本插件 `pins` 含 `embedding` → embedding、`compress` → compress：
// 去重 / 切块经 `port.call embedding.chunk` + `embedding.embed`；需要摘要时经 `port.call compress.summarize`。
// 宿主按发出者 `pins` 路由后回 `port.result` / `port.error`（按 id 配对）。
// 失败作数据（BackendError），不抛未捕获错误、不断通道；单测用可注入的假后端替换真实通道。

import { writeFrame } from './frames.ts'
import { isRecord } from './plan.ts'
import { BackendError } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 反向调用等待上限；宿主自身另有调用超时（缺省 30s），此处作通道兜底。 */
export const PORT_CALL_TIMEOUT_MS = 30000

export type PortOutcome = { ok: true; value: Json } | { ok: false; code: string; message: string }

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

  constructor(write: (message: Json) => void = writeFrame, timeoutMs: number = PORT_CALL_TIMEOUT_MS) {
    this.write = write
    this.timeoutMs = timeoutMs
  }

  /** 发一条 `port.call` 并等待应答；超时 / 写失败作结构化失败。 */
  call(port: string, method: string, args: Rec): Promise<PortOutcome> {
    this.seq += 1
    const id = `memory-consolidate-${this.seq}`
    return new Promise<PortOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: `${port}.${method} timeout` })
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      try {
        this.write({ v: '1', id, kind: 'port.call', port, method, args })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, code: 'transport_failed', message: (err as Error).message })
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
        code: typeof message['error'] === 'string' ? message['error'] : 'backend_failed',
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

/** 一个切块（偏移按 Unicode 码点计）。 */
export interface Chunk {
  index: number
  start: number
  end: number
  text: string
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.chunk` / `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  chunk(text: string): Promise<Chunk[]>
  embed(texts: string[], model: string): Promise<number[][]>
}

/** 摘要后端抽象：生产环境是反向调用 `compress.summarize`，单测注入假后端。 */
export interface CompressBackend {
  summarize(args: Rec): Promise<Rec>
}

function parseChunks(value: Json): Chunk[] {
  if (!Array.isArray(value)) throw new BackendError('embedding_bad_result', 'embedding.chunk returned no chunks')
  const chunks: Chunk[] = []
  for (const item of value) {
    if (!isRecord(item)) throw new BackendError('embedding_bad_result', 'embedding.chunk returned a malformed chunk')
    const index = typeof item['index'] === 'number' ? item['index'] : chunks.length
    const start = typeof item['start'] === 'number' ? item['start'] : 0
    const end = typeof item['end'] === 'number' ? item['end'] : 0
    const text = typeof item['text'] === 'string' ? (item['text'] as string) : ''
    chunks.push({ index, start, end, text })
  }
  return chunks
}

/** `embedding.chunk` 的反向调用后端。 */
export class RemoteEmbedding implements EmbeddingBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async chunk(text: string): Promise<Chunk[]> {
    const outcome = await this.link.call('embedding', 'chunk', { text })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    return parseChunks(outcome.value)
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const outcome = await this.link.call('embedding', 'embed', { texts, model })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value) || !Array.isArray(outcome.value['vectors'])) {
      throw new BackendError('embedding_bad_result', 'embedding.embed returned no vectors')
    }
    const vectors: number[][] = []
    for (const vector of outcome.value['vectors'] as Json[]) {
      if (!Array.isArray(vector) || vector.some((item) => typeof item !== 'number')) {
        throw new BackendError('embedding_bad_result', 'embedding.embed returned a malformed vector')
      }
      vectors.push(vector as number[])
    }
    if (vectors.length !== texts.length) {
      throw new BackendError('embedding_bad_result', 'embedding.embed vector count mismatch')
    }
    return vectors
  }
}

/** 从计划值里取 extern 载荷（`compress.*` 回计划值，摘要住 extern.payload）。 */
function externPayload(value: Json): Rec {
  if (isRecord(value) && Array.isArray(value['$directives'])) {
    for (const directive of value['$directives'] as Json[]) {
      if (isRecord(directive) && directive['kind'] === 'extern' && isRecord(directive['payload'])) {
        return directive['payload'] as Rec
      }
    }
  }
  if (isRecord(value)) return value
  throw new BackendError('compress_bad_result', 'compress.summarize returned no payload')
}

/** `compress.summarize` 的反向调用后端：成功回 extern 载荷（含结构化 summary）。 */
export class RemoteCompress implements CompressBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async summarize(args: Rec): Promise<Rec> {
    const outcome = await this.link.call('compress', 'summarize', args)
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    return externPayload(outcome.value)
  }
}
