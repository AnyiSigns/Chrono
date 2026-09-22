// 机械闸之一（**权威实现**）：闭合 / 类型 / publish 偏序 / 端口 ⊆ pins；并汇总六条不变量与四条演化规则。
// 与 #45 orchestration-admin 的本地复刻对拍：错误码 / 哈希口径一致；规则换代以本文件为准。

import {
  contractIndex,
  contractInputs,
  contractOutputs,
  contractPublishes,
  effectsPorts,
  graphEdges,
  graphEntrySupply,
  graphNodes,
  graphSink,
  nodeEntry,
  readGraphModel,
  type GraphModel,
} from './model.ts'
import { buildTopology, hasCycle, reaches, type Topology } from './graph.ts'
import { checkEvolution, checkInvariants } from './invariants.ts'
import { H } from './hash.ts'
import { asArray, isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

export interface GateError {
  code: string
  path: string
  message: string
}

export function gateError(code: string, path: string, message: string): GateError {
  return { code, path, message }
}

export interface GraphView {
  model: GraphModel
  contracts: Map<string, Rec>
  topo: Topology
  n: number
  sink: number
}

export function buildView(model: GraphModel): GraphView {
  const ids = graphNodes(model.graph)
  const topo = buildTopology(ids.length, graphEdges(model.graph))
  return { model, contracts: contractIndex(model), topo, n: ids.length, sink: graphSink(model.graph) }
}

function findPort(contract: Rec, kind: 'inputs' | 'outputs', name: string): Rec | null {
  const ports = kind === 'inputs' ? contractInputs(contract) : contractOutputs(contract)
  for (const port of ports) {
    if (port['name'] === name) return port
  }
  return null
}

function portType(port: Rec | null): string | null {
  return port !== null && typeof port['type'] === 'string' ? (port['type'] as string) : null
}

/** 名义类型兼容：相等、任一侧为通配（any/*）或无法判定即通过。 */
export function typeCompatible(from: string | null, to: string | null): boolean {
  if (from === null || to === null) return true
  if (from === to) return true
  return ['any', '*'].includes(from) || ['any', '*'].includes(to)
}

/** 闭合：节点非空 / 边引用在界内 / 无环 / sink 合法 / 非首节点有入边 / 每节点可达 sink / sink 唯一 / required 入边全连。 */
export function checkClosure(view: GraphView): GateError[] {
  const errors: GateError[] = []
  const { model, topo, n, sink } = view
  const ids = graphNodes(model.graph)
  const edges = graphEdges(model.graph)

  if (n < 1) {
    errors.push(gateError('no_nodes', 'graph.nodes', '图至少需要一个节点'))
    return errors
  }
  for (let i = 0; i < edges.length; i++) {
    const from = asArray(edges[i]['from']) ?? []
    const to = asArray(edges[i]['to']) ?? []
    const okFrom = from.length === 2 && typeof from[0] === 'number' && from[0] >= 0 && from[0] < n
    const okTo = to.length === 2 && typeof to[0] === 'number' && to[0] >= 0 && to[0] < n
    if (!okFrom || !okTo) errors.push(gateError('edge_ref', `graph.edges[${i}]`, '边端点越界或形态非法'))
  }
  if (hasCycle(topo)) errors.push(gateError('cycle', 'graph.edges', '图必须无环（DAG）'))
  if (sink < 0 || sink >= n) errors.push(gateError('sink', 'graph.sink', 'sink 必须是合法 node_index'))
  for (let i = 1; i < n; i++) {
    if (topo.pred[i].length === 0) errors.push(gateError('non_entry_isolated', `graph.nodes[${i}]`, '非首节点必须至少有一条入边'))
  }
  if (sink >= 0 && sink < n) {
    const reverse: number[][] = Array.from({ length: n }, () => [])
    for (let u = 0; u < n; u++) for (const v of topo.succ[u]) reverse[v].push(u)
    const toSink = new Set<number>([sink])
    const stack = [sink]
    while (stack.length > 0) {
      const node = stack.pop() as number
      for (const prev of reverse[node]) {
        if (!toSink.has(prev)) {
          toSink.add(prev)
          stack.push(prev)
        }
      }
    }
    for (let i = 0; i < n; i++) if (!toSink.has(i)) errors.push(gateError('no_path_to_sink', `graph.nodes[${i}]`, '每个节点必须有向路径到 sink'))
    for (let i = 0; i < n; i++) {
      if (i !== sink && topo.succ[i].length === 0) errors.push(gateError('multiple_sinks', `graph.nodes[${i}]`, '除 sink 外不得有无出边节点'))
    }
  }
  const supplyTypes = new Set(
    graphEntrySupply(model.graph).map((item) => item['type_id']).filter((value): value is string => typeof value === 'string'),
  )
  const wired = new Set<string>()
  for (const edge of edges) {
    const to = asArray(edge['to']) ?? []
    if (to.length === 2 && typeof to[0] === 'number' && typeof to[1] === 'string') wired.add(`${to[0]}:${to[1]}`)
  }
  for (let i = 0; i < n; i++) {
    const contract = view.contracts.get(ids[i])
    if (contract === undefined) continue
    for (const input of contractInputs(contract)) {
      if (input['required'] !== true) continue
      const name = input['name']
      if (typeof name !== 'string') continue
      const type = portType(input)
      const supplied = i === 0 && type !== null && supplyTypes.has(type)
      if (!wired.has(`${i}:${name}`) && !supplied) {
        errors.push(gateError('unconnected_input', `graph.nodes[${i}].${name}`, 'required 输入端口未连'))
      }
    }
  }
  return errors
}

/** 类型兼容：每条边的源输出类型须兼容目标输入类型。 */
export function checkTypes(view: GraphView): GateError[] {
  const errors: GateError[] = []
  const ids = graphNodes(view.model.graph)
  const edges = graphEdges(view.model.graph)
  for (let i = 0; i < edges.length; i++) {
    const from = asArray(edges[i]['from']) ?? []
    const to = asArray(edges[i]['to']) ?? []
    if (from.length !== 2 || to.length !== 2) continue
    const [u, out] = from
    const [v, inp] = to
    if (typeof u !== 'number' || typeof v !== 'number' || typeof out !== 'string' || typeof inp !== 'string') continue
    const src = view.contracts.get(ids[u])
    const dst = view.contracts.get(ids[v])
    if (src === undefined || dst === undefined) continue
    const outPort = findPort(src, 'outputs', out)
    const inPort = findPort(dst, 'inputs', inp)
    if (outPort === null) {
      errors.push(gateError('unknown_port', `graph.edges[${i}]`, `源端口不存在：${out}`))
      continue
    }
    if (inPort === null) {
      errors.push(gateError('unknown_port', `graph.edges[${i}]`, `目标端口不存在：${inp}`))
      continue
    }
    if (!typeCompatible(portType(outPort), portType(inPort))) {
      errors.push(gateError('type_mismatch', `graph.edges[${i}]`, `类型不兼容：${portType(outPort)} → ${portType(inPort)}`))
    }
  }
  return errors
}

/** publish 偏序：同一 SharedRef 的发布者两两必须有拓扑偏序（保守拒）。 */
export function checkPublishOrder(view: GraphView): GateError[] {
  const errors: GateError[] = []
  const ids = graphNodes(view.model.graph)
  const publishers = new Map<string, number[]>()
  for (let i = 0; i < ids.length; i++) {
    const contract = view.contracts.get(ids[i])
    if (contract === undefined) continue
    for (const key of contractPublishes(contract)) {
      const list = publishers.get(key) ?? []
      list.push(i)
      publishers.set(key, list)
    }
  }
  for (const [key, nodes] of publishers) {
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const u = nodes[a]
        const v = nodes[b]
        if (!reaches(view.topo, u, v) && !reaches(view.topo, v, u)) {
          errors.push(gateError('publish_order', `shared:${key}`, `同键发布者无拓扑偏序：node ${u} / node ${v}`))
        }
      }
    }
  }
  return errors
}

/** 端口 ⊆ pins：契约 effects.ports 与 atomic 节点 entry.cap 都必须能在 pins 里解析。 */
export function checkPortsPinned(view: GraphView, pins: Rec): GateError[] {
  const errors: GateError[] = []
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(pins, name)
  for (const contract of view.model.contracts) {
    const id = contract['contract_id']
    for (const port of effectsPorts(contract)) {
      if (!has(port)) errors.push(gateError('port_not_pinned', `contract:${String(id)}.${port}`, 'effects.ports 不在 pins 里'))
    }
  }
  for (const node of view.model.nodes) {
    const entry = nodeEntry(node)
    if (entry === null) continue
    const cap = entry['cap']
    if (typeof cap === 'string' && !has(cap)) {
      errors.push(gateError('port_not_pinned', `scope:${String(node['node_id'])}`, `entry.cap 不在 pins 里：${cap}`))
    }
  }
  return errors
}

export interface ValidateInput {
  graph: Json
  pins: Rec
  active_graph: Rec | null
  runs_since_fork: number | null
  refs?: Rec
}

/** 校验输入的规范化哈希口径（与 #45 同）：对 `{graph, pins, active_graph, runs_since_fork}` 做内核口径 H。 */
export function validateHashInput(input: ValidateInput): Json {
  return {
    graph: input.graph === undefined ? null : input.graph,
    pins: isRecord(input.pins) ? input.pins : {},
    active_graph: input.active_graph === null ? null : input.active_graph,
    runs_since_fork: input.runs_since_fork,
  }
}

/** 对一个图数据 bag 跑完整机械闸；返回错误列表与结果哈希。 */
export function validateGraphData(input: ValidateInput): { ok: boolean; errors: GateError[]; result_hash: string } {
  const resultHash = H(validateHashInput(input))
  const model = readGraphModel(input.graph, input.refs ?? {})
  if (model === null) {
    return { ok: false, errors: [gateError('graph_missing', 'graph', '缺图数据（bag.graph）')], result_hash: resultHash }
  }
  const view = buildView(model)
  const errors: GateError[] = [
    ...checkClosure(view),
    ...checkTypes(view),
    ...checkPublishOrder(view),
    ...checkPortsPinned(view, isRecord(input.pins) ? input.pins : {}),
    ...checkInvariants(view),
    ...checkEvolution(view, input.active_graph, input.runs_since_fork),
  ]
  return { ok: errors.length === 0, errors, result_hash: resultHash }
}
