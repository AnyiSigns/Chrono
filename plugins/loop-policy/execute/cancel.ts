// 取消意图的进程内登记：`cancel(turn_id)` 置标志，运行中的 interpret 在派发前查标志、命中即停。
// 标志按回合键；解释器在每次派发边界查，回合收口后清除，不泄漏到后续回合。

const cancelledTurns = new Set<string>()

/** 置取消标志（幂等）。 */
export function requestCancel(turnId: string): void {
  cancelledTurns.add(turnId)
}

/** 该回合是否已被请求取消；无回合身份（单测直调等）恒 false。 */
export function isCancelled(turnId: string | null): boolean {
  return turnId !== null && cancelledTurns.has(turnId)
}

/** 清除标志：回合收口 / 解释器返回后调用，避免状态复用。 */
export function clearCancel(turnId: string | null): void {
  if (turnId !== null) cancelledTurns.delete(turnId)
}
