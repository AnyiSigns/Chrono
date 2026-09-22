// 机械闸之一：闭合 / 类型 / publish 偏序 / 端口 ⊆ pins。
// 规则以 #33 契约（图与六条不变量 / 状态通信与隔离）为准。

import {
  asArray,
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
  type GraphModel,
} from './model.ts'
import { buildTopology, hasCycle, reaches, type Topology } from './topology.ts'
import type { Rec } from './types.ts'

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

/** 名义类型兼容：相等、任一侧为通配（`any`/`*`）或无法判定（缺 type）即通过。 */
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

  if (n < 1) {
    errors.push(gateError('no_nodes', 'graph.nodes', '图至少需要一个节点'))
    return errors
  }

  for (let i = 0; i < graphEdges(model.graph).length; i++) {
    const edge = graphEdges(model.graph)[i]
    const from = asArray(edge['from'])
    const to = asArray(edge['to'])
    const okFrom = from.length === 2 && typeof from[0] === 'number' && from[0] >= 0 && from[0] < n
    const okTo = to.length === 2 && typeof to[0] === 'number' && to[0] >= 0 && to[0] < n
    if (!okFrom || !okTo) {
      errors.push(gateError('edge_ref', `graph.edges[${i}]`, '边端点越界或形态非法'))
    }
  }

  if (hasCycle(topo)) errors.push(gateError('cycle', 'graph.edges', '图必须无环（DAG）'))

  if (sink < 0 || sink >= n) {
    errors.push(gateError('sink', 'graph.sink', 'sink 必须是合法 node_index'))
  }

  for (let i = 1; i < n; i++) {
    if (topo.pred[i].length === 0) {
      errors.push(gateError('non_entry_isolated', `graph.nodes[${i}]`, '非首节点必须至少有一条入边'))
    }
  }

  if (sink >= 0 && sink < n) {
    const toSink = new Set<number>()
    // 反向：从 sink 反查可达者
    const reverse: number[][] = Array.from({ length: n }, () => [])
    for (let u = 0; u < n; u++) for (const v of topo.succ[u]) reverse[v].push(u)
    const stack = [sink]
    toSink.add(sink)
    while (stack.length > 0) {
      const node = stack.pop() as number
      for (const prev of reverse[node]) {
        if (!toSink.has(prev)) {
          toSink.add(prev)
          stack.push(prev)
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!toSink.has(i)) {
        errors.push(gateError('no_path_to_sink', `graph.nodes[${i}]`, '每个节点必须有向路径到 sink'))
      }
    }
    for (let i = 0; i < n; i++) {
      if (i !== sink && topo.succ[i].length === 0) {
        errors.push(gateError('multiple_sinks', `graph.nodes[${i}]`, '除 sink 外不得有无出边节点'))
      }
    }
  }

  // required 入边全连：入口节点可由 entry_supply 满足
  const supplyTypes = new Set(
    graphEntrySupply(model.graph)
      .map((item) => item['type_id'])
      .filter((value): value is string => typeof value === 'string'),
  )
  const wired = new Set<string>()
  for (const edge of graphEdges(model.graph)) {
    const to = asArray(edge['to'])
    if (to.length === 2 && typeof to[0] === 'number' && typeof to[1] === 'string') {
      wired.add(`${to[0]}:${to[1]}`)
    }
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
  for (let i = 0; i < graphEdges(view.model.graph).length; i++) {
    const edge = graphEdges(view.model.graph)[i]
    const from = asArray(edge['from'])
    const to = asArray(edge['to'])
    if (from.length !== 2 || to.length !== 2) continue
    const [u, out] = from
    const [v, inp] = to
    if (typeof u !== 'number' || typeof v !== 'number') continue
    if (typeof out !== 'string' || typeof inp !== 'string') continue
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
      errors.push(
        gateError('type_mismatch', `graph.edges[${i}]`, `类型不兼容：${portType(outPort)} → ${portType(inPort)}`),
      )
    }
  }
  return errors
}

/** publish 偏序：同一 SharedRef 的发布者两两必须有拓扑偏序（互斥判据充分不必要 ⇒ 保守拒）。 */
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
          errors.push(
            gateError('publish_order', `shared:${key}`, `同键发布者无拓扑偏序：node ${u} / node ${v}`),
          )
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
      if (!has(port)) {
        errors.push(gateError('port_not_pinned', `contract:${String(id)}.${port}`, 'effects.ports 不在 pins 里'))
      }
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
