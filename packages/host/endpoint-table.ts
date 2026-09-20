// 端点表：逻辑能力（能力类 + 方法）→ 物理端点（服务进程 stdio），运行态、住宿主侧 ③。
// 键不含调用方：`impl+gen+cap+method`，由 assembly 写、effect 读。

import type { Hash, Json } from '../kernel/index.ts'

/** 一次能力调用的应答：有响应（成功值或错误）即数据，形态由 link 实现保证。 */
export type EndpointCallResult =
  { ok: true; value: Json } | { ok: false; code: string; message: string }

/**
 * 端点调用通道：服务（stdio）与宿主保留能力类（host）同形，`run-loop` 只依赖这个接口。
 * `ServiceLink` 天然满足它（同签名 / 同应答形态）。
 */
export interface EndpointLink {
  call(
    port: string,
    method: string,
    args: Json,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<EndpointCallResult>
}

export interface EndpointRow {
  impl: string
  gen: Hash
  cap: string
  method: string
  /** `stdio` = 子进程服务；`host` = 宿主保留能力类（无进程）。 */
  transport: 'stdio' | 'host'
  pid: number
  link: EndpointLink
}

function endpointKey(impl: string, gen: Hash, cap: string, method: string): string {
  return `${impl}\u0000${gen}\u0000${cap}\u0000${method}`
}

export class EndpointTable {
  private readonly rows = new Map<string, EndpointRow>()

  add(row: EndpointRow): void {
    this.rows.set(endpointKey(row.impl, row.gen, row.cap, row.method), row)
  }

  removeGeneration(impl: string, gen: Hash): void {
    for (const [key, row] of this.rows) {
      if (row.impl === impl && row.gen === gen) this.rows.delete(key)
    }
  }

  removeIdentity(impl: string): void {
    for (const [key, row] of this.rows) {
      if (row.impl === impl) this.rows.delete(key)
    }
  }

  get(impl: string, gen: Hash, cap: string, method: string): EndpointRow | null {
    return this.rows.get(endpointKey(impl, gen, cap, method)) ?? null
  }

  list(): EndpointRow[] {
    return [...this.rows.values()]
  }

  clear(): void {
    this.rows.clear()
  }
}
