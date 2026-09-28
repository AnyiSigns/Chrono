// 结局构造：把 loop-policy 内部拒绝码包成契约 `TurnOutcome`（码不重命名，原样进 cause）。
// 结局层只从封闭小集里取 `code` 与 `attributableTo`；下游业务码逐字节留在 `cause.code`。

import { cancelled, causeOf, committed, isOutcomeCode, refused } from './contract/index.ts'
import type { AttributableTo, TurnOutcome } from './contract/index.ts'

/** 已知内部拒绝码 → 封闭归因维度；未知码按种子拒绝码表的 `attributable_to` 兜底。 */
const ATTRIBUTION: Record<string, AttributableTo> = {
  transport_failed: 'transport',
  budget: 'budget',
  denied: 'approval',
  needs_approval: 'approval',
  model_timeout: 'model',
  empty_output: 'model',
  owner_unavailable: 'owner',
  capability_mismatch: 'graph',
  downstream_refusal: 'graph',
  scope_mismatch: 'graph',
  pre_unsat: 'graph',
  when_unsat: 'graph',
  input_insufficient: 'graph',
}

function attributionFor(code: string, fallback: string | null): AttributableTo {
  const mapped = ATTRIBUTION[code]
  if (mapped !== undefined) return mapped
  if (fallback === 'budget') return 'budget'
  if (fallback === 'user') return 'approval'
  return 'graph'
}

/** 拒绝码 → 结局层封闭码：已是结局码即沿用，否则按类塌到结局小集。 */
function outcomeCodeFor(code: string): TurnOutcome['code'] {
  if (isOutcomeCode(code)) return code
  if (code === 'budget') return 'budget_exceeded'
  return 'downstream_refusal'
}

/** 由拒绝短路构造 `refused` 结局；`code` 原样进 `cause`。 */
export function refusedOutcome(
  code: string,
  message: string | null,
  retryable: boolean,
  fallbackAttribution: string | null,
): TurnOutcome {
  return refused({
    code: outcomeCodeFor(code),
    attributableTo: attributionFor(code, fallbackAttribution),
    retryable,
    cause: causeOf('loop-policy.interpret', code, message ?? undefined),
  })
}

/** 正常收口的 `committed` 结局；用户预算主动收口带 `stop_reason`（命名哪一维预算用尽）。 */
export function committedOutcome(stopReason: string | null = null): TurnOutcome {
  return stopReason === null ? committed() : committed({ stopReason })
}

/** 用户取消的 `cancelled` 结局；内容已落步记录，不回溯已落账。 */
export function cancelledOutcome(): TurnOutcome {
  return cancelled({ message: 'turn cancelled' })
}
