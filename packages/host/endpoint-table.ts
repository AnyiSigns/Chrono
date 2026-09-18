// 端点表：逻辑能力（能力类 + 方法）→ 物理端点（服务进程 stdio），运行态、住宿主侧 ③。
// 键不含调用方：`impl+gen+cap+method`，由 assembly 写、effect 读。

import type { Hash } from '../kernel/index.ts'
import type { ServiceLink } from './service-link.ts'

export interface EndpointRow {
  impl: string
  gen: Hash
  cap: string
  method: string
  transport: 'stdio'
  pid: number
  link: ServiceLink
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
