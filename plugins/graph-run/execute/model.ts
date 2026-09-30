// 图六类条目的机械读取：把调用方随 args 传入的**已解析模型**归一为可执行的访问。服务不读投影。

import { asStringArray, isRecord, numberField } from './plan.ts'
import type { GraphModel, Rec } from './types.ts'

function asArrayOfRecords(value: unknown): Rec[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

/** 数值阈值（缺省 / 非法回落 fallback）。 */
export function numericThreshold(thresholds: Rec, name: string, fallback: number): number {
  const value = thresholds[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 拒绝码 → 归因（全局表查不到时回落 graph）。 */
export function attributionOf(model: GraphModel, code: string): string {
  for (const entry of model.refusalCodes) {
    if (entry['code'] === code)
      return typeof entry['attributable_to'] === 'string' ? entry['attributable_to'] : 'graph'
  }
  return 'graph'
}

/** 拒绝码是否可重试。 */
export function retriableOf(model: GraphModel, code: string): boolean {
  for (const entry of model.refusalCodes) {
    if (entry['code'] === code) return entry['retriable'] === true
  }
  return false
}

// ── 契约 ────────────────────────────────────────────────────────────────────

export function contractId(contract: Rec): string | null {
  return typeof contract['contract_id'] === 'string' ? contract['contract_id'] : null
}

export function contractEffects(contract: Rec): Rec {
  return isRecord(contract['effects']) ? contract['effects'] : {}
}

export function effectsPorts(contract: Rec): string[] {
  return asStringArray(contractEffects(contract)['ports'])
}

export function effectsMethods(contract: Rec): string[] {
  return asStringArray(contractEffects(contract)['methods'])
}

export function effectsCaps(contract: Rec): Rec {
  const caps = contractEffects(contract)['caps']
  return isRecord(caps) ? caps : {}
}

export function contractInputs(contract: Rec): Rec[] {
  return asArrayOfRecords(contract['inputs'])
}

export function contractOutputs(contract: Rec): Rec[] {
  return asArrayOfRecords(contract['outputs'])
}

export function contractReads(contract: Rec): Rec[] {
  return asArrayOfRecords(contract['reads'])
}

export function contractPublishes(contract: Rec): string[] {
  return asStringArray(contract['publishes'])
}

export function contractPre(contract: Rec): string {
  const value = contract['pre']
  return typeof value === 'string' && value.length > 0 ? value : 'always'
}

export function contractPost(contract: Rec): string {
  const value = contract['post']
  return typeof value === 'string' && value.length > 0 ? value : 'always'
}

export function touchesEffects(contract: Rec): boolean {
  return contract['touches_effects'] === true
}

export function isLlmContract(contract: Rec): boolean {
  return effectsPorts(contract).includes('model')
}

/** 按 contract_id 建索引（同 id 只留首个）。 */
export function contractIndex(model: GraphModel): Map<string, Rec> {
  const map = new Map<string, Rec>()
  for (const contract of model.contracts) {
    const id = contractId(contract)
    if (id !== null && !map.has(id)) map.set(id, contract)
  }
  return map
}

// ── Scope 实例 ──────────────────────────────────────────────────────────────

export function nodeId(node: Rec): string | null {
  return typeof node['node_id'] === 'string' ? node['node_id'] : null
}

export function nodeContractId(node: Rec): string | null {
  return typeof node['contract_id'] === 'string' ? node['contract_id'] : null
}

export function nodeImpl(node: Rec): string | null {
  return typeof node['impl'] === 'string' ? node['impl'] : null
}

export function nodeScope(node: Rec): Rec {
  return isRecord(node['scope']) ? node['scope'] : {}
}

export function nodeLinks(node: Rec): string[] {
  return asStringArray(node['links'])
}

export function nodeEntry(node: Rec): Rec | null {
  return isRecord(node['entry']) ? node['entry'] : null
}

export function nodeSubgraph(node: Rec): Rec | null {
  return isRecord(node['subgraph']) ? node['subgraph'] : null
}

export function nodeBindings(node: Rec): Rec {
  return isRecord(node['bindings']) ? node['bindings'] : {}
}

export function nodeAutonomy(node: Rec): string {
  const value = node['autonomy']
  return typeof value === 'string' ? value : 'L0'
}

// ── 图 ──────────────────────────────────────────────────────────────────────

export function graphNodes(graph: Rec): string[] {
  return asStringArray(graph['nodes'])
}

export function graphEdges(graph: Rec): Rec[] {
  return asArrayOfRecords(graph['edges'])
}

export function graphSink(graph: Rec): number {
  const sink = graph['sink']
  return typeof sink === 'number' && Number.isInteger(sink) ? sink : -1
}

export function graphDerivedFrom(graph: Rec): string | null {
  const value = graph['derived_from']
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function graphEntrySupply(graph: Rec): Rec[] {
  return asArrayOfRecords(graph['entry_supply'])
}

export function graphLoop(graph: Rec): Rec {
  return isRecord(graph['loop']) ? graph['loop'] : {}
}

/** 一条边的 when 表达式（缺省空串 = 无条件）。 */
export function edgeWhen(edge: Rec): string {
  const value = edge['when']
  return typeof value === 'string' ? value : ''
}

/** 边的端点端口名。 */
export function edgePorts(edge: Rec): { from: [number, string]; to: [number, string] } | null {
  const from = Array.isArray(edge['from']) ? edge['from'] : []
  const to = Array.isArray(edge['to']) ? edge['to'] : []
  if (from.length !== 2 || to.length !== 2) return null
  const [u, out] = from
  const [v, inp] = to
  if (typeof u !== 'number' || typeof out !== 'string') return null
  if (typeof v !== 'number' || typeof inp !== 'string') return null
  return { from: [u, out], to: [v, inp] }
}

/** 契约 cost 的先验数值（缺失回落 0）。 */
export function contractCost(contract: Rec): number {
  const cost = contract['cost']
  if (!isRecord(cost)) return 0
  const calls = numberField(cost['calls'])
  const toolCalls = numberField(cost['tool_calls'])
  const tokens = numberField(cost['tokens'])
  return (calls ?? 0) + (toolCalls ?? 0) + (tokens ?? 0) / 1000
}
