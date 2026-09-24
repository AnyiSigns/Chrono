// 落账致命态：账本追加（`appendJournal`）失败后，内存世界已与磁盘账本分叉，
// 继续服务只会让分叉随每一轮提交持续放大（后续轮以内存为准，重启后回放却看不到这些写）。
// 故首个落账失败即标记进程级致命：本进程后续任何 run 入口都直接抛错，不再接受提交。
// 宿主应把该态视为停机信号（`fatalError()` 非空 → 停服）；在宿主接线前，本模块保证
// 致命态之后不再有任何一轮写能落账，避免分叉继续扩大。

/** 落账失败抛出的致命错误；`cause` 保留底层异常（如账本写失败的 IO 错误）。 */
export class PersistFatalError extends Error {
  readonly cause?: unknown
  constructor(cause?: unknown) {
    super('persist_failed: journal append failed, host must stop')
    this.name = 'PersistFatalError'
    this.cause = cause
  }
}

let fatal: PersistFatalError | null = null

/** 标记致命态：首个失败决定原因，后续调用返回同一错误（不覆盖首个现场）。 */
export function markFatal(cause: unknown): PersistFatalError {
  if (fatal === null) fatal = new PersistFatalError(cause)
  return fatal
}

/** 当前致命错误；null = 未进入致命态。 */
export function fatalError(): PersistFatalError | null {
  return fatal
}

/** run 入口卫语句：已进入致命态即抛错，拒绝一切后续提交。 */
export function assertNotFatal(): void {
  if (fatal !== null) throw fatal
}

/** 清除致命态：仅供测试隔离，生产不调用。 */
export function resetFatal(): void {
  fatal = null
}
