// 段间 trace 累积：分段执行把整回合拆成多次 `run` 调用，但每回合只写一个 evolution 世代。
// 同一回合的 trace 记录器在段间驻留本服务进程内存，段终态（stepping）不落账、不清除；
// 回合终态 / 挂起时由 turn-ledger 一次写出并清除。这是进程内协调（同 `cancel.ts`），
// 不是持久状态、不随段入世。

import { TraceRecorder } from './trace.ts'

const turns = new Map<string, TraceRecorder>()

/** 取本回合的 trace 记录器：同回合跨段复用（续写 step 序号），无 `turn_id` 时新建。 */
export function traceFor(turnId: string | null): TraceRecorder {
  if (turnId === null) return new TraceRecorder()
  let recorder = turns.get(turnId)
  if (recorder === undefined) {
    recorder = new TraceRecorder()
    turns.set(turnId, recorder)
  }
  return recorder
}

/** 回合终态 / 挂起后清除，不泄漏到复用同身份的后续回合。 */
export function clearTrace(turnId: string | null): void {
  if (turnId !== null) turns.delete(turnId)
}
