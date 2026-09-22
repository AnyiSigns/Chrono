// 源码 watcher 的静默窗口：编辑器保存常产生多次事件、写临时文件再 rename，
// 窗口内的事件合并为一次重建（尾沿触发：窗口内再有事件则顺延），避免同一保存重建多次。

/** 缺省静默窗口（毫秒）：足够覆盖编辑器多事件与原子替换，又不至于让改动反馈明显延迟。 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 300

/** 静默窗口定时器；`schedule` 重置窗口，`dispose` 取消未触发的一次。 */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null
  // 不用 TS 参数属性：宿主入口以 `node main.ts` 直跑，Node 原生类型擦除不支持需代码生成的语法
  private readonly windowMs: number
  private readonly onFire: () => void

  constructor(windowMs: number, onFire: () => void) {
    this.windowMs = windowMs
    this.onFire = onFire
  }

  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.onFire()
    }, this.windowMs)
    // 不因待触发的窗口拖住进程退出：宿主停机时由 dispose 显式取消
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
