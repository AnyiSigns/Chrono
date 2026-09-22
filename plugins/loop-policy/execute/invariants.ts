// 机械闸之二：六条图不变量 + 四条演化规则（**权威实现**；#45 的 validate 是本地复刻，规则换代以本文件为准）。
// 规则来源：plugins/loop-policy/DESIGN.md「三、图与六条不变量」「九、演化口径」。

import { H } from './hash.ts'
import {
  contractId,
  contractInputs,
  effectsCaps,
  effectsPorts,
  graphDerivedFrom,
  graphEdges,
  graphEntrySupply,
  graphNodes,
  isLlmContract,
  nodeContractId,
  nodeImpl,
  nodeScope,
  nodeSubgraph,
  numericThreshold,
  touchesEffects,
  type GraphModel,
} from './model.ts'
import { isRecord } from './plan.ts'
import { edgeKey, reachableSet, reaches, topoOrder, type Topology } from './graph.ts'
import { buildView, gateError, type GateError, type GraphView } from './gate.ts'
import type { Rec } from './types.ts'

/** 高危端口（写期只能按端口粒度机械近似；实际判据 = (port, 工具名)，更精确判据归运行时）。 */
const HIGH_RISK_PORTS = new Set(['exec', 'plugin-admin', 'orchestration-admin'])

function instanceContracts(view: GraphView, contractIdValue: string): Rec[] {
  return view.model.nodes.filter((node) => nodeContractId(node) === contractIdValue)
}

function fsWrites(contract: Rec): boolean {
  const fs = effectsCaps(contract)['fs']
  const fsRec = isRecord(fs) ? fs : {}
  // 声明式：显式声明 caps.fs.write 为非 'none' 才算写档（契约必须声明 caps；运行时由 #25 强制）。
  return typeof fsRec['write'] === 'string' && fsRec['write'] !== 'none'
}

function riskPorts(view: GraphView, contractIdValue: string, depth: number): string[] {
  const out: string[] = []
  const contract = view.contracts.get(contractIdValue)
  if (contract !== undefined) {
    for (const port of effectsPorts(contract)) {
      if (HIGH_RISK_PORTS.has(port)) out.push(port)
      else if (port === 'fs' && fsWrites(contract)) out.push(port)
    }
    if (fsWrites(contract)) out.push('fs')
  }
  if (depth < 8) {
    for (const node of instanceContracts(view, contractIdValue)) {
      if (nodeImpl(node) !== 'composite') continue
      const sub = nodeSubgraph(node)
      if (sub === null) continue
      const subView = buildView({ ...view.model, graph: sub })
      for (const subId of graphNodes(sub)) out.push(...riskPorts(subView, subId, depth + 1))
    }
  }
  return out
}

function isGuard(view: GraphView, contractIdValue: string): boolean {
  const contract = view.contracts.get(contractIdValue)
  return (contract !== undefined && effectsPorts(contract).includes('guard')) || contractIdValue === 'tool.gate'
}

function isApproval(view: GraphView, contractIdValue: string): boolean {
  const contract = view.contracts.get(contractIdValue)
  return (contract !== undefined && effectsPorts(contract).includes('approval')) || contractIdValue === 'approval.wait'
}

/** 不变量 1：池中始终保留一个只依赖 entry_supply 的 touches_effects:false 契约。 */
function checkFallbackEntry(view: GraphView): GateError[] {
  const supplyTypes = new Set(
    graphEntrySupply(view.model.graph)
      .map((item) => item['type_id'])
      .filter((value): value is string => typeof value === 'string'),
  )
  for (const contract of view.model.contracts) {
    if (touchesEffects(contract)) continue
    const required = contractInputs(contract).filter((item) => item['required'] === true)
    const satisfied = required.every(
      (item) => typeof item['type'] === 'string' && supplyTypes.has(item['type'] as string),
    )
    if (satisfied) return []
  }
  return [gateError('missing_fallback_entry', 'contracts', '池中缺一个只依赖 entry_supply 的 touches_effects:false 契约')]
}

/** 不变量 4：声明高危端口的 Scope，其可达路径上必须存在 guard → approval 段。 */
function checkApprovalSegment(view: GraphView): GateError[] {
  const errors: GateError[] = []
  const ids = graphNodes(view.model.graph)
  const entryReach = reachableSet(view.topo, 0)
  for (let i = 0; i < view.n; i++) {
    if (riskPorts(view, ids[i], 0).length === 0) continue
    let ok = false
    if (entryReach.has(i)) {
      for (let g = 0; g < view.n && !ok; g++) {
        if (!entryReach.has(g) || !isGuard(view, ids[g]) || !reaches(view.topo, g, i)) continue
        for (const a of view.topo.succ[g]) {
          if (isApproval(view, ids[a]) && reaches(view.topo, a, i)) {
            ok = true
            break
          }
        }
      }
    }
    if (!ok) {
      errors.push(gateError('approval_bypass', `graph.nodes[${i}]`, '高危端口节点的可达路径上缺 guard→approval 段'))
    }
  }
  return errors
}

function nodeWeight(view: GraphView, contractIdValue: string, depth: number): number {
  const contract = view.contracts.get(contractIdValue)
  let weight = contract !== undefined && isLlmContract(contract) ? 1 : 0
  if (depth < 8) {
    for (const node of instanceContracts(view, contractIdValue)) {
      if (nodeImpl(node) !== 'composite') continue
      const sub = nodeSubgraph(node)
      if (sub === null) continue
      const subView = buildView({ ...view.model, graph: sub })
      weight = Math.max(weight, maxLlmChain(subView, depth + 1))
    }
  }
  return weight
}

/** 子图最长连续 LLM 链（composite 按此折算，不按 1 计）。 */
function maxLlmChain(view: GraphView, depth: number): number {
  const ids = graphNodes(view.model.graph)
  const dp = new Array<number>(view.n).fill(0)
  for (const i of topoOrder(view.topo)) {
    const weight = nodeWeight(view, ids[i], depth)
    if (weight === 0) {
      dp[i] = 0
      continue
    }
    let best = 0
    for (const pred of view.topo.pred[i]) best = Math.max(best, dp[pred])
    dp[i] = best + weight
  }
  return dp.length === 0 ? 0 : Math.max(...dp)
}

/** 不变量 6：图内出现的每个契约至少有一个 scope:global 实例；并校验契约存在。 */
function checkGlobalInstance(view: GraphView): GateError[] {
  const errors: GateError[] = []
  for (const id of new Set(graphNodes(view.model.graph))) {
    if (!view.contracts.has(id)) {
      errors.push(gateError('unknown_contract', 'graph.nodes', `契约未声明：${id}`))
      continue
    }
    const hasGlobal = view.model.nodes.some(
      (node) => nodeContractId(node) === id && nodeScope(node)['kind'] === 'global',
    )
    if (!hasGlobal) {
      errors.push(gateError('last_global_instance', `contract:${id}`, '契约必须至少有一个 scope:global 实例'))
    }
  }
  return errors
}

/** 六条图不变量（1–6）。 */
export function checkInvariants(view: GraphView): GateError[] {
  const errors: GateError[] = []
  errors.push(...checkFallbackEntry(view))
  const hasContract = (id: string): boolean => view.model.contracts.some((c) => contractId(c) === id)
  if (!hasContract('join')) errors.push(gateError('missing_join_contract', 'contracts', '缺 join 契约'))
  if (!hasContract('subagent')) errors.push(gateError('missing_subagent_contract', 'contracts', '缺 subagent 契约'))
  errors.push(...checkApprovalSegment(view))
  const max = numericThreshold(view.model.thresholds, 'llm_chain_max', 2)
  if (maxLlmChain(view, 0) > max) {
    errors.push(gateError('llm_chain_max', 'graph', `连续 LLM Scope 数超过 llm_chain_max=${max}`))
  }
  errors.push(...checkGlobalInstance(view))
  return errors
}

/** 结构差异：节点按生成序逐位比较 + 边集合对称差。 */
export function graphDiff(candidate: Rec, active: Rec): number {
  const aNodes = graphNodes(candidate)
  const bNodes = graphNodes(active)
  let diff = Math.abs(aNodes.length - bNodes.length)
  for (let i = 0; i < Math.min(aNodes.length, bNodes.length); i++) {
    if (aNodes[i] !== bNodes[i]) diff += 1
  }
  const aEdges = new Set(graphEdges(candidate).map(edgeKey).filter((key): key is string => key !== null))
  const bEdges = new Set(graphEdges(active).map(edgeKey).filter((key): key is string => key !== null))
  for (const key of aEdges) if (!bEdges.has(key)) diff += 1
  for (const key of bEdges) if (!aEdges.has(key)) diff += 1
  return diff
}

/** 四条演化规则（fork-only / diff 上限 / min_runs_before_fork / llm_chain_max 并入不变量 5）。 */
export function checkEvolution(
  view: GraphView,
  activeGraph: Rec | null,
  runsSinceFork: number | null,
): GateError[] {
  const errors: GateError[] = []
  const derived = graphDerivedFrom(view.model.graph)
  if (derived === null) {
    errors.push(gateError('fork_only', 'graph.derived_from', '新图必须带 derived_from（fork-only，禁空白整图）'))
  } else if (activeGraph !== null && derived !== H(activeGraph)) {
    errors.push(gateError('fork_only', 'graph.derived_from', 'derived_from 必须指向当前 active 图'))
  }
  if (graphNodes(view.model.graph).length === 0) {
    errors.push(gateError('fork_only', 'graph.nodes', '禁空白整图'))
  }
  if (activeGraph !== null) {
    const maxDiff = numericThreshold(view.model.thresholds, 'max_graph_diff', 8)
    const diff = graphDiff(view.model.graph, activeGraph)
    if (diff > maxDiff) {
      errors.push(gateError('diff_exceeded', 'graph', `结构改动 ${diff} 超过 max_graph_diff=${maxDiff}`))
    }
  }
  if (runsSinceFork !== null) {
    const min = numericThreshold(view.model.thresholds, 'min_runs_before_fork', 3)
    if (runsSinceFork < min) {
      errors.push(gateError('min_runs_before_fork', 'graph.derived_from', `攒够 ${min} 回合才能作为下次 fork 的基`))
    }
  }
  return errors
}

/** 供 #45 对拍用：导出一份规则清单与错误码（README 对拍表）。 */
export const INVARIANT_CODES = [
  'missing_fallback_entry',
  'missing_join_contract',
  'missing_subagent_contract',
  'approval_bypass',
  'llm_chain_max',
  'last_global_instance',
  'unknown_contract',
] as const

export const EVOLUTION_CODES = ['fork_only', 'diff_exceeded', 'min_runs_before_fork'] as const
