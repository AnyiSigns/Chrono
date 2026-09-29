// loop-policy 测试本地假 `graph-gate`：只在测试进程内仿真反向 port.call 应答，不 import 任何兄弟插件
// （插件间不得直连，做法参照 compress/test/fakes.mjs）。契约形状与真实提供方一致：
//   - closure：运行期结构闭合（未知契约 + 闭合检查）；- validate：fork-only / 空图 + 四演化规则 + 结果哈希。
// 这里刻意只覆盖 loop-policy 测试实际消费的方法面（validate / closure），且实现保持与真实契约同形；
// 完整六不变量等真实机械闸行为由 plugins/graph-gate 自带测试与根 tests/contract 覆盖。
import { H } from '../execute/hash.ts'
import {
  contractIndex,
  contractInputs,
  graphDerivedFrom,
  graphEdges,
  graphEntrySupply,
  graphNodes,
  graphSink,
  numericThreshold,
  readGraphModel,
} from '../execute/model.ts'
import { buildTopology, hasCycle, topoOrder } from '../execute/graph.ts'
import { isRecord } from '../execute/plan.ts'

function gateError(code, path, message) {
  return { code, path, message }
}

function buildView(model) {
  const ids = graphNodes(model.graph)
  const topo = buildTopology(ids.length, graphEdges(model.graph))
  return {
    model,
    contracts: contractIndex(model),
    topo,
    n: ids.length,
    sink: graphSink(model.graph),
  }
}

function portType(port) {
  return port !== null && typeof port['type'] === 'string' ? port['type'] : null
}

/** 闭合：节点非空 / 边引用在界内 / 无环 / sink 合法 / 非首节点有入边 / 每节点可达 sink / sink 唯一 / required 入边全连。 */
function checkClosure(view) {
  const errors = []
  const { model, topo, n, sink } = view
  const ids = graphNodes(model.graph)
  const edges = graphEdges(model.graph)

  if (n < 1) {
    errors.push(gateError('no_nodes', 'graph.nodes', '图至少需要一个节点'))
    return errors
  }
  for (let i = 0; i < edges.length; i++) {
    const from = Array.isArray(edges[i]['from']) ? edges[i]['from'] : []
    const to = Array.isArray(edges[i]['to']) ? edges[i]['to'] : []
    const okFrom = from.length === 2 && typeof from[0] === 'number' && from[0] >= 0 && from[0] < n
    const okTo = to.length === 2 && typeof to[0] === 'number' && to[0] >= 0 && to[0] < n
    if (!okFrom || !okTo)
      errors.push(gateError('edge_ref', `graph.edges[${i}]`, '边端点越界或形态非法'))
  }
  if (hasCycle(topo)) errors.push(gateError('cycle', 'graph.edges', '图必须无环（DAG）'))
  if (sink < 0 || sink >= n)
    errors.push(gateError('sink', 'graph.sink', 'sink 必须是合法 node_index'))
  for (let i = 1; i < n; i++) {
    if (topo.pred[i].length === 0)
      errors.push(
        gateError('non_entry_isolated', `graph.nodes[${i}]`, '非首节点必须至少有一条入边'),
      )
  }
  if (sink >= 0 && sink < n) {
    const reverse = Array.from({ length: n }, () => [])
    for (let u = 0; u < n; u++) for (const v of topo.succ[u]) reverse[v].push(u)
    const toSink = new Set([sink])
    const stack = [sink]
    while (stack.length > 0) {
      const node = stack.pop()
      for (const prev of reverse[node]) {
        if (!toSink.has(prev)) {
          toSink.add(prev)
          stack.push(prev)
        }
      }
    }
    for (let i = 0; i < n; i++)
      if (!toSink.has(i))
        errors.push(
          gateError('no_path_to_sink', `graph.nodes[${i}]`, '每个节点必须有向路径到 sink'),
        )
    for (let i = 0; i < n; i++) {
      if (i !== sink && topo.succ[i].length === 0)
        errors.push(gateError('multiple_sinks', `graph.nodes[${i}]`, '除 sink 外不得有无出边节点'))
    }
  }
  const supplyTypes = new Set(
    graphEntrySupply(model.graph)
      .map((item) => item['type_id'])
      .filter((value) => typeof value === 'string'),
  )
  const wired = new Set()
  for (const edge of edges) {
    const to = Array.isArray(edge['to']) ? edge['to'] : []
    if (to.length === 2 && typeof to[0] === 'number' && typeof to[1] === 'string')
      wired.add(`${to[0]}:${to[1]}`)
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
      if (!wired.has(`${i}:${name}`) && !supplied)
        errors.push(
          gateError('unconnected_input', `graph.nodes[${i}].${name}`, 'required 输入端口未连'),
        )
    }
  }
  return errors
}

/** 运行期结构闭合：未知契约 + 闭合检查（与真实 `graph-gate.closure` 同形）。 */
export function runtimeClosure(graph, refs = {}) {
  const model = readGraphModel(graph, refs)
  if (model === null) {
    return {
      ok: false,
      errors: [gateError('graph_missing', 'graph', '缺图数据（bag.graph）')],
      view: null,
    }
  }
  const view = buildView(model)
  const errors = []
  for (const id of graphNodes(model.graph)) {
    if (!view.contracts.has(id))
      errors.push(gateError('unknown_contract', 'graph.nodes', `契约未声明：${id}`))
  }
  errors.push(...checkClosure(view))
  return {
    ok: errors.length === 0,
    errors,
    view: { n: view.n, sink: view.sink, order: topoOrder(view.topo) },
  }
}

/** 结构差异：节点按生成序逐位比较 + 边集合对称差。 */
function graphDiff(candidate, active) {
  const aNodes = graphNodes(candidate)
  const bNodes = graphNodes(active)
  let diff = Math.abs(aNodes.length - bNodes.length)
  for (let i = 0; i < Math.min(aNodes.length, bNodes.length); i++) {
    if (aNodes[i] !== bNodes[i]) diff += 1
  }
  const aEdges = new Set(
    graphEdges(candidate)
      .map(edgeKey)
      .filter((key) => key !== null),
  )
  const bEdges = new Set(
    graphEdges(active)
      .map(edgeKey)
      .filter((key) => key !== null),
  )
  for (const key of aEdges) if (!bEdges.has(key)) diff += 1
  for (const key of bEdges) if (!aEdges.has(key)) diff += 1
  return diff
}

function edgeKey(edge) {
  const from = Array.isArray(edge['from']) ? edge['from'] : []
  const to = Array.isArray(edge['to']) ? edge['to'] : []
  if (from.length !== 2 || to.length !== 2) return null
  const [u, out] = from
  const [v, inp] = to
  if (typeof u !== 'number' || typeof out !== 'string') return null
  if (typeof v !== 'number' || typeof inp !== 'string') return null
  return `${u}:${out}->${v}:${inp}`
}

/** 完整机械闸的最小子集：fork-only / 空图 / diff 上限 / min_runs_before_fork + 结果哈希。 */
export function validateGraphData(input) {
  const resultHash = H({
    graph: input.graph === undefined ? null : input.graph,
    pins: isRecord(input.pins) ? input.pins : {},
    active_graph: input.active_graph === null ? null : input.active_graph,
    runs_since_fork: input.runs_since_fork,
  })
  const model = readGraphModel(input.graph, input.refs ?? {})
  if (model === null) {
    return {
      ok: false,
      errors: [gateError('graph_missing', 'graph', '缺图数据（bag.graph）')],
      result_hash: resultHash,
    }
  }
  const errors = []
  const active = isRecord(input.active_graph) ? input.active_graph : null
  const derived = graphDerivedFrom(model.graph)
  if (derived === null) {
    errors.push(
      gateError('fork_only', 'graph.derived_from', '新图必须带 derived_from（fork-only）'),
    )
  } else if (active !== null && derived !== H(active)) {
    errors.push(gateError('fork_only', 'graph.derived_from', 'derived_from 必须指向当前 active 图'))
  }
  if (graphNodes(model.graph).length === 0) {
    errors.push(gateError('fork_only', 'graph.nodes', '禁空白整图'))
  }
  if (active !== null) {
    const maxDiff = numericThreshold(model.thresholds, 'max_graph_diff', 8)
    if (graphDiff(model.graph, active) > maxDiff) {
      errors.push(gateError('diff_exceeded', 'graph', `结构改动超过 max_graph_diff=${maxDiff}`))
    }
  }
  const runs = typeof input.runs_since_fork === 'number' ? input.runs_since_fork : null
  if (runs !== null) {
    const min = numericThreshold(model.thresholds, 'min_runs_before_fork', 3)
    if (runs < min) {
      errors.push(
        gateError('min_runs_before_fork', 'graph.derived_from', `攒够 ${min} 回合才能 fork`),
      )
    }
  }
  return { ok: errors.length === 0, errors, result_hash: resultHash }
}
