// 在途建引擎的同步硬杀句柄。
// 建引擎是异步的（惰性 import + 拉起浏览器），而进程 `exit` 里只能同步动作；故 `open` 在 await
// 之前先造一个句柄交给引擎工厂：工厂在拿到可同步终止的中间态（如已 spawn 的浏览器子进程）时
// 经 `register` 登记，`killAllSync` 在 `exit` 里同步触达——否则建引擎途中退出会留下孤儿浏览器。

import { log } from './frames.ts'

/** 可同步硬杀的句柄（浏览器子进程 / 引擎实例）。 */
export interface Killable {
  kill(): void
}

/**
 * 一次建引擎过程的硬杀句柄：登记中间态、记录 abort。
 * `kill()` 一旦调用即置 `aborted`；此后 `register` 的句柄立即被杀，`open` 落地后也不再入册。
 */
export class CreationHandle {
  private readonly killables = new Set<Killable>()
  private aborted = false

  /** 是否已被硬杀路径 abort。 */
  get isAborted(): boolean {
    return this.aborted
  }

  /** 登记一个可同步硬杀的中间句柄；若已 abort 则立即 kill（不再保留）。 */
  register(killable: Killable): void {
    if (this.aborted) {
      this.safeKill(killable)
      return
    }
    this.killables.add(killable)
  }

  /** 同步硬杀：abort 后已登记的中间句柄一律 kill，且不再接受新登记。 */
  kill(): void {
    this.aborted = true
    for (const killable of this.killables) this.safeKill(killable)
    this.killables.clear()
  }

  private safeKill(killable: Killable): void {
    try {
      killable.kill()
    } catch (err) {
      log(`kill in-flight engine failed: ${(err as Error).message}`)
    }
  }
}
