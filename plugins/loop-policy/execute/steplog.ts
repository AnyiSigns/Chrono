// 回合步记录写入：先写意图再执行、记不下来就停。
// 追加失败（传输失败 / 结构化拒绝）一律回 `ok:false`，由调用方在下一步边界 fail-closed，
// 不把追加失败当成功、也不继续调模型与工具。

import { isRecord } from './plan.ts'
import type { PortCaller, Rec } from './types.ts'

export interface AppendStepResult {
  ok: boolean
  /** 属主回的结构化拒绝产物（`{code,...}`），供调用方原样透传进结局 cause。 */
  outcome: Rec | null
}

/** 追加一条步记录（intent / result / checkpoint），交给 `session` 属主落盘。 */
export async function appendStep(port: PortCaller, record: Rec): Promise<AppendStepResult> {
  const outcome = await port.call('session', 'step_append', record)
  if (!outcome.ok) return { ok: false, outcome: null }
  const value = outcome.value
  if (!isRecord(value) || value['ok'] !== true) {
    return { ok: false, outcome: isRecord(value) && isRecord(value['outcome']) ? (value['outcome'] as Rec) : null }
  }
  return { ok: true, outcome: null }
}

/** 工具调用（内部归一形状）→ 步记录契约的 `{id,name,arguments}`。 */
export function toolCallsForLog(calls: Rec[]): Rec[] {
  return calls.map((call, index) => ({
    id: typeof call['call_id'] === 'string' ? (call['call_id'] as string) : `call-${index}`,
    name: typeof call['tool'] === 'string' ? (call['tool'] as string) : '',
    arguments: isRecord(call['args']) ? (call['args'] as Rec) : {},
  }))
}
