// 世界写者：把「追加 journal + 推进世界 / 链头」收拢进一条串行段。
// run 级并发下多个 run 可并行 eval / 等待效果，但落账必须串行：段内不做 await 服务调用，
// 因此各次 commit 之间不会交错，`expect_pos` 单链头 CAS 恒成立——锁只在落账那一刻持有。

import type { Head, World } from '../kernel/index.ts'

/** 写者持有的当前世界与链头；串行段内对它的修改即成为新的当前值。 */
export interface WorldState {
  world: World
  head: Head
}

/** thenable 判定：段回调返回 Promise 即视为违反「段内禁 await」。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** 段回调的同步返回值：`T` 为 thenable 时归 `never`，编译期即拒 async 回调。 */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T

export class WorldWriter {
  private state: WorldState
  private tail: Promise<unknown> = Promise.resolve()

  constructor(initial: WorldState) {
    this.state = { world: initial.world, head: initial.head }
  }

  /** 当前世界 / 链头快照；仅供串行段内或近似读使用（不保证读后不被并发落账推进）。 */
  snapshot(): WorldState {
    return { world: this.state.world, head: this.state.head }
  }

  /**
   * 串行执行 fn：同一时刻至多一段，前一段落定后才开始下一段。
   * fn 必须**同步**：段内出现 await 会让段与段交错，`expect_pos` 单链头 CAS 不再成立；
   * 运行时护栏在 fn 返回 thenable 时立即抛错（不静默把 await 引入落账段）。
   * fn 对 `state` 的修改即成为新的当前世界 / 链头；fn 抛错只让本次 run 落定失败，
   * 不阻塞后续段（互斥链始终向前）。
   */
  run<T>(fn: (state: WorldState) => SyncResult<T>): Promise<T> {
    const next = this.tail.then(() => {
      const result = fn(this.state) as T
      if (isThenable(result)) {
        throw new Error('WorldWriter.run: fn must be synchronous (thenable returned)')
      }
      return result
    })
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}
