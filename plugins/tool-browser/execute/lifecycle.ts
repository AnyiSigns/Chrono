// 进程生命周期：SIGTERM / SIGINT 优雅停机 + `exit` 同步硬杀兜底（关闭全部会话，不泄漏浏览器进程）。
// 抽成纯函数便于单测：注入进程对象（生产传 process），断言信号 / 退出各自触发对应停机动作。

import { log } from './frames.ts'

/** 停机目标：优雅停机 + 同步硬杀兜底。 */
export interface ShutdownTarget {
  shutdown(): void
  killAllSync(): void
}

/** 需要监听的进程事件（生产 = Node `process`）。 */
export interface ProcessLike {
  on(event: 'SIGTERM' | 'SIGINT' | 'exit', listener: () => void): unknown
}

/**
 * 注册信号处理与退出兜底：
 * - `SIGTERM` / `SIGINT` → 优雅停机（关闭会话后退出）；
 * - `exit` → 同步 `killAllSync` 兜底（覆盖 `process.exit` 与硬杀路径，尽力杀浏览器子进程）。
 */
export function installShutdownHandlers(proc: ProcessLike, target: ShutdownTarget): void {
  proc.on('SIGTERM', () => {
    log('received SIGTERM; shutting down')
    target.shutdown()
  })
  proc.on('SIGINT', () => {
    log('received SIGINT; shutting down')
    target.shutdown()
  })
  proc.on('exit', () => target.killAllSync())
}
