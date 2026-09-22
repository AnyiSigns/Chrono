// 实例选择：先按 `scope` 过滤候选集，再按确定性 tie-break 取首。
// 强制点在实例选择（机械、不可绕过）：`scope.kind='workspace'` 且 workspace_id 不匹配 ⇒ 不进候选集。
// tie-break 字典序 = (隔离升序, 成功率下界降序, cost 升序, node_id 升序)；隔离升序 = 越专门越靠前。

import { contractCost, nodeBindings, nodeContractId, nodeId, nodeScope, type GraphModel } from './model.ts'
import { isRecord, numberField } from './plan.ts'
import type { Rec } from './types.ts'

export interface ScopeCtx {
  workspace_id: string | null
  session_id: string | null
}

export interface ChosenInstance {
  node: Rec
  contract: Rec
  chosen_instance: string
  chosen_agent: string | null
  candidates: string[]
}

/** 隔离度：session(0) < workspace(1) < global(2)。越专门越靠前。 */
export function isolationRank(scope: Rec): number {
  const kind = scope['kind']
  if (kind === 'session') return 0
  if (kind === 'workspace') return 1
  return 2
}

/** 候选过滤：workspace / session 实例必须 id 匹配；global 恒可见。 */
export function scopeMatches(scope: Rec, ctx: ScopeCtx): boolean {
  const kind = scope['kind']
  if (kind === 'workspace') {
    const ws = scope['workspace_id']
    return typeof ws === 'string' && ws.length > 0 && ws === ctx.workspace_id
  }
  if (kind === 'session') {
    const sid = scope['session_id']
    return typeof sid === 'string' && sid.length > 0 && sid === ctx.session_id
  }
  return true
}

function successLower(node: Rec): number {
  return numberField(node['success_lower']) ?? numberField(node['success_rate']) ?? 0
}

function costOf(node: Rec, contract: Rec): number {
  return numberField(node['cost']) ?? contractCost(contract)
}

function agentOf(node: Rec): string | null {
  const bindings = nodeBindings(node)
  const agent = bindings['agent']
  if (typeof agent === 'string') return agent
  if (isRecord(agent)) {
    if (typeof agent['def'] === 'string') return agent['def']
    if (typeof agent['id'] === 'string') return agent['id']
  }
  return null
}

/** 同契约多实例选择；无候选回 null（调用方据此拒 `scope_mismatch`）。 */
export function selectInstance(
  model: GraphModel,
  contract: Rec,
  ctx: ScopeCtx,
): ChosenInstance | null {
  const contractId = contract['contract_id']
  if (typeof contractId !== 'string') return null
  const all = model.nodes.filter((node) => nodeContractId(node) === contractId)
  const candidates = all.filter((node) => scopeMatches(nodeScope(node), ctx))
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => {
    const rank = isolationRank(nodeScope(a)) - isolationRank(nodeScope(b))
    if (rank !== 0) return rank
    const success = successLower(b) - successLower(a)
    if (success !== 0) return success
    const cost = costOf(a, contract) - costOf(b, contract)
    if (cost !== 0) return cost
    return String(nodeId(a) ?? '').localeCompare(String(nodeId(b) ?? ''))
  })
  const node = sorted[0]
  return {
    node,
    contract,
    chosen_instance: nodeId(node) ?? '',
    chosen_agent: agentOf(node),
    candidates: candidates.map((item) => nodeId(item) ?? ''),
  }
}
