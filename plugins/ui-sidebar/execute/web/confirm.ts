// 就地二次确认状态机（纯逻辑，时钟可注入）：3s 内再次确认才生效，超时自动收回。
// 用于「终止运行中的 run」与「删除会话」两处破坏性动作。

export interface ConfirmState {
  key: string | null
  until: number
}

/** 二次确认时限（毫秒），与审批停靠带口径一致。 */
export const CONFIRM_MS = 3000

/** 初始态：无待确认动作。 */
export function createConfirmState(): ConfirmState {
  return { key: null, until: 0 }
}

/** 发起一次二次确认（返回新态；同一 key 重复发起即续期）。 */
export function beginConfirm(state: ConfirmState, key: unknown, now: number): ConfirmState {
  if (typeof key !== 'string' || key.length === 0) return state
  return { key, until: now + CONFIRM_MS }
}

/** 该 key 是否仍在确认窗口内。 */
export function isConfirming(state: ConfirmState, key: string, now: unknown): boolean {
  return state.key === key && typeof now === 'number' && now < state.until
}

/** 确认窗口是否已过期（需要收回 UI 上的确认态）。 */
export function confirmExpired(state: ConfirmState, now: unknown): boolean {
  return state.key !== null && typeof now === 'number' && now >= state.until
}

/** 收回确认态。 */
export function clearConfirm(): ConfirmState {
  return createConfirmState()
}
