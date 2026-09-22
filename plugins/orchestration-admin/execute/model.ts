// 图六类条目 / pins / 台账的机械读取与规范化：把随 bag 传入的图数据归一成可校验的模型。
// 服务不读投影：所有输入来自 bag / args（由 #33 装配）。形状以 #33 契约为准。

import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

export interface GraphModel {
  contracts: Rec[]
  nodes: Rec[]
  graph: Rec
  thresholds: Rec
  refusalCodes: string[]
  prompts: Rec
}

export function asArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : []
}

export function asStringArray(value: Json | undefined): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string')
}

function fromNameValue(items: Json[]): Rec {
  const out: Rec = {}
  for (const item of items) {
    if (isRecord(item) && typeof item['name'] === 'string') {
      out[item['name']] = item['value'] === undefined ? null : item['value']
    }
  }
  return out
}

/** 阈值表：接受 `{name:value}` 映射、`{entries:[{name,value}]}` 或 `[{name,value}]` 数组。 */
export function readThresholds(raw: Json | undefined): Rec {
  if (isRecord(raw)) {
    if (Array.isArray(raw['entries'])) return fromNameValue(raw['entries'])
    return raw
  }
  if (Array.isArray(raw)) return fromNameValue(raw)
  return {}
}

function readRefusalCodes(raw: Json | undefined): string[] {
  const out: string[] = []
  for (const item of asArray(raw)) {
    if (typeof item === 'string') out.push(item)
    else if (isRecord(item) && typeof item['code'] === 'string') out.push(item['code'])
  }
  return out
}

function readPrompts(raw: Json | undefined): Rec {
  if (isRecord(raw)) return raw
  const out: Rec = {}
  for (const item of asArray(raw)) {
    if (isRecord(item) && typeof item['id'] === 'string') out[item['id']] = item
  }
  return out
}

/** 读 `bag.graph`（六类条目包装）为模型；缺 `graph` 单值 → null。 */
export function readGraphModel(raw: Json | undefined): GraphModel | null {
  if (!isRecord(raw)) return null
  const graph = isRecord(raw['graph']) ? raw['graph'] : null
  if (graph === null) return null
  return {
    contracts: asArray(raw['contracts']).filter(isRecord),
    nodes: asArray(raw['nodes']).filter(isRecord),
    graph,
    thresholds: readThresholds(raw['thresholds']),
    refusalCodes: readRefusalCodes(raw['refusal_codes']),
    prompts: readPrompts(raw['prompts']),
  }
}

export function numericThreshold(thresholds: Rec, name: string, fallback: number): number {
  const value = thresholds[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
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

export function effectsCaps(contract: Rec): Rec {
  return isRecord(contractEffects(contract)['caps']) ? (contractEffects(contract)['caps'] as Rec) : {}
}

export function contractInputs(contract: Rec): Rec[] {
  return asArray(contract['inputs']).filter(isRecord)
}

export function contractOutputs(contract: Rec): Rec[] {
  return asArray(contract['outputs']).filter(isRecord)
}

export function contractPublishes(contract: Rec): string[] {
  return asStringArray(contract['publishes'])
}

export function touchesEffects(contract: Rec): boolean {
  return contract['touches_effects'] === true
}

export function isLlmContract(contract: Rec): boolean {
  return effectsPorts(contract).includes('model')
}

/** 按 contract_id 建索引（同 id 只留首个；写期应保证唯一）。 */
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

// ── 图 ──────────────────────────────────────────────────────────────────────

export function graphNodes(graph: Rec): string[] {
  return asStringArray(graph['nodes'])
}

export function graphEdges(graph: Rec): Rec[] {
  return asArray(graph['edges']).filter(isRecord)
}

export function graphSink(graph: Rec): number {
  return typeof graph['sink'] === 'number' && Number.isInteger(graph['sink']) ? graph['sink'] : -1
}

export function graphDerivedFrom(graph: Rec): string | null {
  return typeof graph['derived_from'] === 'string' && graph['derived_from'].length > 0
    ? graph['derived_from']
    : null
}

export function graphEntrySupply(graph: Rec): Rec[] {
  return asArray(graph['entry_supply']).filter(isRecord)
}

/** 一条边的规范键 `u:out->v:in`（diff 用；when 不参与结构差异）。 */
export function edgeKey(edge: Rec): string | null {
  const from = asArray(edge['from'])
  const to = asArray(edge['to'])
  if (from.length !== 2 || to.length !== 2) return null
  const [u, out] = from
  const [v, inp] = to
  if (typeof u !== 'number' || typeof out !== 'string') return null
  if (typeof v !== 'number' || typeof inp !== 'string') return null
  return `${u}:${out}->${v}:${inp}`
}
