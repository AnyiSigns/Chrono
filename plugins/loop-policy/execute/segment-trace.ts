// 段间计划累积：分段执行把整回合拆成多次 `interpret` 调用，trace 与 verdict 的落账在回合终态一次写出，
// 但段终态（stepping）已产出的节点计划需要驻留，供 settle 时统一出 trace 的 directives 摘要。
// 这是进程内协调，不是持久状态、不随段入世。

import type { Json } from './types.ts'

interface TurnDirectives {
  directives: Json[]
}

const turns = new Map<string, TurnDirectives>()

/** 段终态登记本段计划，供 settle 时统一出摘要。 */
export function accumulateDirectives(turnId: string | null, directives: Json[]): void {
  if (turnId === null) return
  const entry = turns.get(turnId) ?? { directives: [] }
  entry.directives.push(...directives)
  turns.set(turnId, entry)
}

/** settle 时的完整计划：本段计划前接已累积的段间计划（无累积时回本段计划）。 */
export function accumulatedDirectives(turnId: string | null, current: Json[]): Json[] {
  if (turnId === null) return current
  const entry = turns.get(turnId)
  return entry === undefined ? current : entry.directives
}

/** 回合终态 / 挂起后清除，不泄漏到复用同身份的后续回合。 */
export function clearTrace(turnId: string | null): void {
  if (turnId !== null) turns.delete(turnId)
}
