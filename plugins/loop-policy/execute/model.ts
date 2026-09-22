// 图六类条目的机械读取与规范化：把随 bag 传入的图数据归一成可执行的模型。
// 服务不读投影：所有输入来自 bag / args（由调用方入口 term 装配）。形状以本插件契约为准。
// 链式条目（{tail,count} + refs 闭包）与已解析数组两种形态都接受。

import { asStringArray, defHashOf, isRecord, numberField } from './plan.ts'
import type { GraphModel, Json, Rec } from './types.ts'

/** 链遍历硬上限（防坏数据成环）。 */
export const MAX_CHAIN = 10000

function asArrayOfRecords(value: Json | undefined): Rec[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

/** 沿 `prev` 从 tail 回溯，返回 newest→oldest 的条目 body 数组；坏引用 / 成环即停。 */
export function chainEntries(container: Rec, refs: Rec): Rec[] {
  const out: Rec[] = []
  let hash = defHashOf(container['tail'])
  let guard = 0
  while (hash !== null && guard < MAX_CHAIN) {
    guard += 1
    const body = refs[hash]
    if (!isRecord(body)) break
    out.push(body)
    hash = defHashOf(body['prev'])
  }
  return out
}

/** 条目容器 → 数组：已解析数组直接用；链式经 refs 回溯。 */
export function readEntries(value: Json | undefined, refs: Rec): Rec[] {
  if (Array.isArray(value)) return asArrayOfRecords(value)
  if (!isRecord(value)) return []
  if (Object.hasOwn(value, 'tail')) return chainEntries(value, refs)
  return [value]
}

function fromNameValue(items: Rec[]): Rec {
  const out: Rec = {}
  for (const item of items) {
    const name = item['name']
    if (typeof name === 'string') out[name] = item['value'] === undefined ? null : item['value']
  }
  return out
}

/** 阈值表：扁平 map / {entries:[…]} / [{name,value}] / 链式 tail。 */
export function readThresholds(value: Json | undefined, refs: Rec): Rec {
  if (isRecord(value)) {
    if (Object.hasOwn(value, 'tail')) return fromNameValue([...chainEntries(value, refs)].reverse())
    if (Array.isArray(value['entries'])) return fromNameValue(asArrayOfRecords(value['entries']))
    return value
  }
  if (Array.isArray(value)) return fromNameValue(asArrayOfRecords(value))
  return {}
}

/** 提示词表：对象映射 / [{id,text}] / 链式 tail（后写覆盖先写）。 */
export function readPrompts(value: Json | undefined, refs: Rec): Rec {
  if (isRecord(value) && !Object.hasOwn(value, 'tail')) {
    if (Array.isArray(value['entries'])) return readPrompts(value['entries'], refs)
    return value
  }
  const out: Rec = {}
  for (const entry of [...readEntries(value, refs)].reverse()) {
    const id = entry['id']
    if (typeof id === 'string') out[id] = entry
  }
  return out
}

function normalizeRefusal(entry: Rec): Rec {
  const code = entry['code']
  const attributable = entry['attributable_to']
  return {
    code: typeof code === 'string' ? code : '',
    retriable: entry['retriable'] === true,
    attributable_to:
      typeof attributable === 'string' ? attributable : 'graph',
  }
}

function readRefusalCodes(value: Json | undefined, refs: Rec): Rec[] {
  return readEntries(value, refs).map(normalizeRefusal).filter((entry) => entry['code'] !== '')
}

/** 读 `bag.graph`（六类条目包装 + refs 闭包）为模型；缺 `graph` 单值 → null。 */
export function readGraphModel(raw: Json | undefined, refs: Rec = {}): GraphModel | null {
  if (!isRecord(raw)) return null
  const slot = raw['graph']
  let graph: Rec | null = null
  if (isRecord(slot) && Array.isArray(slot['nodes'])) graph = slot
  else {
    const hash = defHashOf(slot)
    if (hash !== null && isRecord(refs[hash])) graph = refs[hash]
  }
  if (graph === null) return null
  return {
    contracts: readEntries(raw['contracts'], refs),
    nodes: readEntries(raw['nodes'], refs),
    prompts: readPrompts(raw['prompts'], refs),
    graph,
    thresholds: readThresholds(raw['thresholds'], refs),
    refusalCodes: readRefusalCodes(raw['refusal_codes'], refs),
  }
}

/** 数值阈值（缺省 / 非法回落 fallback）。 */
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
