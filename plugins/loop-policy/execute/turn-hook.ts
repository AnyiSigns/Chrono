// `turn-hook` 拥有方 loop-policy 的默认提供方：回合固定点钩子给出中立上下文/状态增量。
// 队列语义（轮次边界是否因排队输入挂起）与空转 nudge 文案由此提供，不再住 graph-run 解释器；
// 钩子只回增量、不写世界，也不改会话存储（session 的持久化方法照旧）。

import { isRecord } from './plan.ts'
import { ServiceError } from './types.ts'
import type { Json, PortCaller, Rec } from './types.ts'

/** 空转 nudge 文案：升级阶梯的第一步——先提示模型换策略，再次命中才收口。 */
export const LOOP_NUDGE =
  '检测到连续无进展（相同调用/结果重复、或短周期来回）。请停止重复同一操作：换用不同策略，或直接给出结论并结束本轮。'

/**
 * 客户端在本回合轮次边界是否有排队输入：据此请求挂起，等其由 `resume` 提升为 `step.user` 再恢复。
 * 读取失败（端口不支持 / 回合未知）一律按无输入处理（fail-open 到原行为，不误挂起）。
 */
async function hasPendingInput(port: PortCaller, turnId: string): Promise<boolean> {
  try {
    const res = await port.call('session', 'turn_has_pending_input', { turn_id: turnId })
    return res.ok && isRecord(res.value) && res.value['pending'] === true
  } catch {
    return false
  }
}

export interface TurnHookDeps {
  port: PortCaller
}

/** `before-settle`：有排队输入即请求解释器按 `input` 挂起（中立增量，不含世界写）。 */
export async function beforeSettle(args: Json, deps: TurnHookDeps): Promise<Rec> {
  const input = isRecord(args) ? args : {}
  const turnId =
    typeof input['turn_id'] === 'string' && (input['turn_id'] as string).length > 0
      ? (input['turn_id'] as string)
      : null
  if (turnId === null) return { delta: {} }
  const pending = await hasPendingInput(deps.port, turnId)
  return pending ? { delta: { suspend: { kind: 'input' } } } : { delta: {} }
}

/** `after-step`：命中空转即给出 nudge 文案（是否升级由解释器按自身阶梯决定）。 */
export function afterStep(args: Json): Rec {
  const input = isRecord(args) ? args : {}
  const stall = isRecord(input['stall']) ? input['stall'] : null
  return stall !== null ? { delta: { nudge: LOOP_NUDGE } } : { delta: {} }
}

/**
 * 队列写口 `note-input`：把回合进行中收到的用户输入记入会话待发队列。
 * 队列词汇归本提供方，session 只作持久存储；传输失败上报 `session_unavailable` 由调用方分码。
 */
export async function noteInput(args: Json, deps: TurnHookDeps): Promise<Rec> {
  const outcome = await deps.port.call('session', 'turn_note_input', isRecord(args) ? args : {})
  if (!outcome.ok) throw new ServiceError('session_unavailable', outcome.message)
  return isRecord(outcome.value) ? outcome.value : { ok: false, reason: 'bad_args' }
}

/**
 * 队列写口 `promote-input`：把待发输入按序提升为 `step.user`（进入流与后续上下文）。
 * 失败由调用方按 best-effort 处理，不在此吞并语义。
 */
export async function promoteInput(args: Json, deps: TurnHookDeps): Promise<Rec> {
  const outcome = await deps.port.call('session', 'turn_promote_input', isRecord(args) ? args : {})
  if (!outcome.ok) throw new ServiceError('session_unavailable', outcome.message)
  return isRecord(outcome.value) ? outcome.value : { ok: false, reason: 'bad_args' }
}
