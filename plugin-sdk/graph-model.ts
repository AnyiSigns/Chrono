// 图六类条目的机械读取与规范化：把随 bag / args 传入的图数据归一成可校验 / 可执行的模型。
// 服务不读投影：所有输入来自 bag / args。形状以图契约（六类条目）为准。
// 链式条目（{tail,count} + refs 闭包）与已解析数组两种形态都接受。
// 纯函数、零副作用、零内核零宿主依赖：graph-gate（语义 owner）/ loop-policy / graph-run / orchestration
// 共用同一读取口径，避免各处复刻漂移。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'
import { asStringArray, defHashOf, numberField } from './plan.ts'

/** 图六类条目 + 阈值的归一模型（服务不读投影：全部来自 bag / args）。 */
export interface GraphModel {
  contracts: Rec[]
  nodes: Rec[]
  prompts: Rec
  graph: Rec
  thresholds: Rec
  refusalCodes: Rec[]
}

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
    attributable_to: typeof attributable === 'string' ? attributable : 'graph',
  }
}

function readRefusalCodes(value: Json | undefined, refs: Rec): Rec[] {
  return readEntries(value, refs)
    .map(normalizeRefusal)
    .filter((entry) => entry['code'] !== '')
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

// ── 图拓扑（机械闸与解释器共用真源；纯函数、零副作用） ──────────────────────

export interface Topology {
  n: number
  succ: number[][]
  pred: number[][]
}

/** 取边两端 node_index（形态非法 / 越界回 null）。 */
export function edgeEndpoints(edge: Rec, n: number): [number, number] | null {
  const from = Array.isArray(edge['from']) ? edge['from'] : []
  const to = Array.isArray(edge['to']) ? edge['to'] : []
  if (from.length !== 2 || to.length !== 2) return null
  const u = from[0]
  const v = to[0]
  if (typeof u !== 'number' || typeof v !== 'number') return null
  if (!Number.isInteger(u) || !Number.isInteger(v)) return null
  if (u < 0 || u >= n || v < 0 || v >= n) return null
  return [u, v]
}

/** 一条边的规范键 `u:out->v:in`（diff 用；when 不参与结构差异）。 */
export function edgeKey(edge: Rec): string | null {
  const from = Array.isArray(edge['from']) ? edge['from'] : []
  const to = Array.isArray(edge['to']) ? edge['to'] : []
  if (from.length !== 2 || to.length !== 2) return null
  const [u, out] = from
  const [v, inp] = to
  if (typeof u !== 'number' || typeof out !== 'string') return null
  if (typeof v !== 'number' || typeof inp !== 'string') return null
  return `${u}:${out}->${v}:${inp}`
}

/** 由节点数与边表建拓扑；越界 / 畸形边不计入（闭合检查另报错）。 */
export function buildTopology(n: number, edges: Rec[]): Topology {
  const succ: number[][] = Array.from({ length: n }, () => [])
  const pred: number[][] = Array.from({ length: n }, () => [])
  for (const edge of edges) {
    const ends = edgeEndpoints(edge, n)
    if (ends === null) continue
    const [u, v] = ends
    succ[u].push(v)
    pred[v].push(u)
  }
  return { n, succ, pred }
}

/** 从 `from` 出发（含自身）的可达节点集合。 */
export function reachableSet(topo: Topology, from: number): Set<number> {
  const seen = new Set<number>()
  if (from < 0 || from >= topo.n) return seen
  const stack = [from]
  seen.add(from)
  while (stack.length > 0) {
    const node = stack.pop() as number
    for (const next of topo.succ[node]) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

/** `from` 是否能到达 `to`（含 from === to）。 */
export function reaches(topo: Topology, from: number, to: number): boolean {
  if (from === to) return from >= 0 && from < topo.n
  return reachableSet(topo, from).has(to)
}

/** 是否存在有向环（Kahn 拓扑序长度 < n 即存在）。 */
export function hasCycle(topo: Topology): boolean {
  const indeg = topo.pred.map((list) => list.length)
  const queue: number[] = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.pop() as number
    visited += 1
    for (const next of topo.succ[node]) {
      indeg[next] -= 1
      if (indeg[next] === 0) queue.push(next)
    }
  }
  return visited < topo.n
}

/** 拓扑序（DAG 时，稳定：入度 0 队列按升序）；有环时回落自然序（调用方已另行报环）。 */
export function topoOrder(topo: Topology): number[] {
  const indeg = topo.pred.map((list) => list.length)
  const queue: number[] = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  const order: number[] = []
  while (queue.length > 0) {
    queue.sort((a, b) => a - b)
    const node = queue.shift() as number
    order.push(node)
    for (const next of topo.succ[node]) {
      indeg[next] -= 1
      if (indeg[next] === 0) queue.push(next)
    }
  }
  if (order.length < topo.n) {
    for (let i = 0; i < topo.n; i++) if (!order.includes(i)) order.push(i)
  }
  return order
}

// ── Scope 实例选择（graph-gate 语义 owner 与 graph-run 共用真源） ─────────────

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
export function selectInstance(model: GraphModel, contract: Rec, ctx: ScopeCtx): ChosenInstance | null {
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
