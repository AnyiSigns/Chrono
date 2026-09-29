// 机械闸反向调用：`orchestration.validate` / `propose` 经 `port.call graph-gate.validate` 消费机械闸提供方。
// 服务不再本地复刻机械闸；错误码 / 结果哈希由 `graph-gate` 权威给出（与拆分前逐字节一致）。

import { isRecord } from './plan.ts'
import type { Json, PortCaller, Rec } from 'plugin-sdk'

export interface ValidateResult {
  ok: boolean
  errors: Rec[]
  result_hash: string
}

/**
 * 机械闸入参规范化（与拆分前本插件的 `validateHashInput` 口径一致）：
 * `graph` 缺失为 null、`pins` 非对象回落空、`active_graph` 非对象回落 null、`runs_since_fork` 非数值回落 null。
 */
export function validateArgsOf(bag: Rec): Rec {
  return {
    graph: bag['graph'] === undefined ? null : bag['graph'],
    pins: isRecord(bag['pins']) ? bag['pins'] : {},
    active_graph: isRecord(bag['active_graph']) ? bag['active_graph'] : null,
    runs_since_fork: typeof bag['runs_since_fork'] === 'number' ? bag['runs_since_fork'] : null,
  }
}

/** 经 `graph-gate.validate` 跑机械闸；提供方不可用时结构化失败（不本地兜底）。 */
export async function validateViaGraphGate(port: PortCaller, bag: Rec): Promise<ValidateResult> {
  const outcome = await port.call('graph-gate', 'validate', validateArgsOf(bag))
  if (!outcome.ok) {
    return {
      ok: false,
      errors: [{ code: 'graph_gate_unavailable', path: 'graph-gate', message: outcome.message }],
      result_hash: '',
    }
  }
  const value = isRecord(outcome.value) ? (outcome.value as Rec) : null
  const errors =
    value !== null && Array.isArray(value['errors'])
      ? (value['errors'] as Json[]).filter(isRecord)
      : []
  const resultHash =
    value !== null && typeof value['result_hash'] === 'string'
      ? (value['result_hash'] as string)
      : ''
  return { ok: value !== null && value['ok'] === true, errors, result_hash: resultHash }
}
