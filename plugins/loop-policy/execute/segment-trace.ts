// 段间 trace 累积：分段执行把整回合拆成多次 `interpret` 调用，但每回合只写一个 evolution 世代。
// 同一回合的 trace 记录器与已产计划在段间驻留进程内存，段终态（stepping）不落账、不清除；
// 回合终态 / 挂起时一次写出并清除。这是进程内协调（同 `cancel.ts`），不是持久状态、不随段入世。

import { TraceRecorder } from './trace.ts'
import type { Json } from './types.ts'

interface TurnTrace {
  trace: TraceRecorder
  directives: Json[]
}

const turns = new Map<string, TurnTrace>()

/** 取本回合的 trace 记录器：同回合跨段复用（续写 step 序号），无 `turn_id` 时新建。 */
export function traceFor(turnId: string | null): TraceRecorder {
  if (turnId === null) return new TraceRecorder()
  let entry = turns.get(turnId)
  if (entry === undefined) {
    entry = { trace: new TraceRecorder(), directives: [] }
    turns.set(turnId, entry)
  }
  return entry.trace
}

/** 段终态登记本段计划，供 settile 时统一出摘要。 */
export function accumulateDirectives(turnId: string | null, directives: Json[]): void {
  if (turnId === null) return
  const entry = turns.get(turnId)
  if (entry !== undefined) entry.directives.push(...directives)
}

/** settle 时的完整计划：本段计划前接已累积的段间计划。 */
export function accumulatedDirectives(turnId: string | null, current: Json[]): Json[] {
  if (turnId === null) return current
  const entry = turns.get(turnId)
  return entry === undefined ? current : entry.directives
}

/** 回合终态 / 挂起后清除，不泄漏到复用同身份的后续回合。 */
export function clearTrace(turnId: string | null): void {
  if (turnId !== null) turns.delete(turnId)
}
