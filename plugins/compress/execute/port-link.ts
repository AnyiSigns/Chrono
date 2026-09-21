// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与模型 / 向量化后端抽象。
// 本插件 `pins` 含 `model` → model-protocol、`embedding` → embedding：
// semantic 模式经 `port.call model.chat` 出摘要；summarize / extract 去重经 `port.call embedding.embed` 取向量。
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
    const id = `compress-${this.seq}`
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

/** 模型后端抽象：生产环境是反向调用 `model.chat`，单测注入假后端。 */
export interface ModelBackend {
  chat(config: Rec, messages: Json[]): Promise<Rec>
}

/** 向量化后端抽象：生产环境是反向调用 `embedding.embed`，单测注入假后端。 */
export interface EmbeddingBackend {
  embed(texts: string[], model: string): Promise<number[][]>
}

/** 从模型服务回包里取结构化错误码（`{ok:false, error:{code}}`）。 */
function modelErrorCode(value: Rec): string {
  const error = value['error']
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'] as string
  return 'model_call_failed'
}

/** `model.chat` 的反向调用后端：成功回最终值，失败抛结构化 BackendError。 */
export class RemoteModel implements ModelBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
  }

  async chat(config: Rec, messages: Json[]): Promise<Rec> {
    const outcome = await this.link.call('model', 'chat', { config, messages })
    if (!outcome.ok) throw new BackendError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) throw new BackendError('model_call_failed', 'model.chat returned a non-object')
    if (outcome.value['ok'] === false) {
      throw new BackendError(modelErrorCode(outcome.value), 'model.chat reported failure')
    }
    return outcome.value
  }
}

/** `embedding.embed` 的反向调用后端：成功回向量数组（已 L2 归一）。 */
export class RemoteEmbedding implements EmbeddingBackend {
  private readonly link: PortLink

  constructor(link: PortLink) {
    this.link = link
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
