// 进程内结果缓存：只缓存 `idempotent:true` 的工具结果，摊平同批 / 同进程内的重复只读调用。
// 写类 / 模型 chat / 有会话类工具 `idempotent:false`，永不进缓存。键 = canonicalJson({tool, workspace_root, args})。
// 单飞（single-flight）：同键并发调用共享同一次加载，避免同批重复只读扇出。

import type { Json } from './types.ts'

export class ResultCache {
  private readonly entries = new Map<string, Promise<Json>>()
  private readonly maxEntries: number
  private readonly enabled: boolean

  constructor(maxEntries: number, enabled: boolean) {
    this.maxEntries = maxEntries
    this.enabled = enabled
  }

  /** 命中即返回；未命中则加载并登记（同键并发共享同一 promise）。未启用直接加载。 */
  run(key: string, loader: () => Promise<Json>): Promise<Json> {
    if (!this.enabled) return loader()
    const existing = this.entries.get(key)
    if (existing !== undefined) return existing
    const promise = loader().catch((err: unknown) => {
      this.entries.delete(key)
      throw err
    })
    this.entries.set(key, promise)
    this.evict()
    return promise
  }

  /** 只读条目数（诊断 / 测试用）。 */
  size(): number {
    return this.entries.size
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
