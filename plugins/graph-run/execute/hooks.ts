// `turn-hook` 消费端：回合固定点逐成员索取中立上下文/状态增量（禁世界写）。
// 固定点 = before-assemble / after-step / before-settle / after-settle；成员按身份名码元序，
// 零成员合法（无增量）。增量合并确定性：标量后到覆盖，`extra_messages` 按序拼接。

import { isRecord } from './plan.ts'
import type { Json, PortCaller, Rec, RunState } from './types.ts'

/** 向所有 `turn-hook` 成员发一次固定点调用，合并各自的中立增量。 */
export async function callTurnHooks(
  port: PortCaller,
  providers: string[],
  point: string,
  payload: Rec,
): Promise<Rec> {
  const merged: Rec = {}
  for (const provider of providers) {
    const outcome = await port.call('turn-hook', point, payload, { provider })
    if (!outcome.ok) continue
    const value = isRecord(outcome.value) ? outcome.value : null
    const delta = value !== null && isRecord(value['delta']) ? value['delta'] : null
    if (delta === null) continue
    for (const [key, entry] of Object.entries(delta)) {
      if (key === 'extra_messages' && Array.isArray(entry)) {
        const previous = Array.isArray(merged[key]) ? (merged[key] as Json[]) : []
        merged[key] = [...previous, ...entry]
      } else {
        merged[key] = entry
      }
    }
  }
  return merged
}

/** 把中立增量落进回合状态：nudge 覆盖一次性提示，extra_messages 顺序追加。 */
export function applyDelta(rs: RunState, delta: Rec): void {
  if (typeof delta['nudge'] === 'string') rs.loopNudge = delta['nudge']
  if (Array.isArray(delta['extra_messages'])) {
    for (const message of delta['extra_messages']) rs.extraMessages.push(message)
  }
}
