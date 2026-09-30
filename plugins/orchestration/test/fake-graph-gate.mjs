// orchestration 测试本地假 `graph-gate`：只在测试进程内仿真反向 port.call 应答，不 import 任何
// 兄弟插件（插件间不得直连，做法参照 context-window/test/fakes.mjs）。契约形状与真实提供方一致（同字段 /
// 同错误码 / 同结果哈希口径），用于支撑本插件「validate 委派 → 消费机械闸结果」的原断言；
// 真实机械闸行为由 plugins/graph-gate 自带测试与根 tests/contract 覆盖。
//
// 规则与 plugins/graph-gate/execute 同口径：闭合 / 类型 / publish 偏序 / 端口 ⊆ pins + 六不变量 + 四演化规则。
// 读取走本插件自己的 model.ts（与生产同一读取口径），哈希走本插件 hash.ts。

import { H } from '../execute/hash.ts'
import {
  asArray,
  contractId,
  contractIndex,
  contractInputs,
  contractOutputs,
  contractPublishes,
  edgeKey,
  effectsCaps,
  effectsPorts,
  graphDerivedFrom,
  graphEdges,
  graphEntrySupply,
  graphNodes,
  graphSink,
  isLlmContract,
  nodeContractId,
  nodeEntry,
  nodeImpl,
  nodeScope,
  nodeSubgraph,
  numericThreshold,
  readGraphModel,
  touchesEffects,
} from '../execute/model.ts'
import { isRecord } from '../execute/plan.ts'

// ── 拓扑（纯函数） ──────────────────────────────────────────────────────────

function edgeEndpoints(edge, n) {
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

function buildTopology(n, edges) {
  const succ = Array.from({ length: n }, () => [])
  const pred = Array.from({ length: n }, () => [])
  for (const edge of edges) {
    const ends = edgeEndpoints(edge, n)
    if (ends === null) continue
    const [u, v] = ends
    succ[u].push(v)
    pred[v].push(u)
  }
  return { n, succ, pred }
}

function reachableSet(topo, from) {
  const seen = new Set()
  if (from < 0 || from >= topo.n) return seen
  const stack = [from]
  seen.add(from)
  while (stack.length > 0) {
    const node = stack.pop()
    for (const next of topo.succ[node]) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

function reaches(topo, from, to) {
  if (from === to) return from >= 0 && from < topo.n
  return reachableSet(topo, from).has(to)
}

function hasCycle(topo) {
  const indeg = topo.pred.map((list) => list.length)
  const queue = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.pop()
    visited += 1
    for (const next of topo.succ[node]) {
      indeg[next] -= 1
      if (indeg[next] === 0) queue.push(next)
    }
  }
  return visited < topo.n
}

function topoOrder(topo) {
  const indeg = topo.pred.map((list) => list.length)
  const queue = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  const order = []
  while (queue.length > 0) {
    queue.sort((a, b) => a - b)
    const node = queue.shift()
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

// ── 闭合 / 类型 / 偏序 / 端口 ⊆ pins ────────────────────────────────────────

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

function findPort(contract, kind, name) {
  const ports = kind === 'inputs' ? contractInputs(contract) : contractOutputs(contract)
  for (const port of ports) {
    if (port['name'] === name) return port
  }
  return null
}

function portType(port) {
  return port !== null && typeof port['type'] === 'string' ? port['type'] : null
}

function typeCompatible(from, to) {
  if (from === null || to === null) return true
  if (from === to) return true
  return ['any', '*'].includes(from) || ['any', '*'].includes(to)
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
    const from = asArray(edges[i]['from'])
    const to = asArray(edges[i]['to'])
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
    const to = asArray(edge['to'])
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

function checkTypes(view) {
  const errors = []
  const ids = graphNodes(view.model.graph)
  const edges = graphEdges(view.model.graph)
  for (let i = 0; i < edges.length; i++) {
    const from = asArray(edges[i]['from'])
    const to = asArray(edges[i]['to'])
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
        gateError(
          'type_mismatch',
          `graph.edges[${i}]`,
          `类型不兼容：${portType(outPort)} → ${portType(inPort)}`,
        ),
      )
    }
  }
  return errors
}

function checkPublishOrder(view) {
  const errors = []
  const ids = graphNodes(view.model.graph)
  const publishers = new Map()
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
            gateError(
              'publish_order',
              `shared:${key}`,
              `同键发布者无拓扑偏序：node ${u} / node ${v}`,
            ),
          )
        }
      }
    }
  }
  return errors
}

function checkPortsPinned(view, pins) {
  const errors = []
  const has = (name) => Object.prototype.hasOwnProperty.call(pins, name)
  for (const contract of view.model.contracts) {
    const id = contract['contract_id']
    for (const port of effectsPorts(contract)) {
      if (!has(port))
        errors.push(
          gateError(
            'port_not_pinned',
            `contract:${String(id)}.${port}`,
            'effects.ports 不在 pins 里',
          ),
        )
    }
  }
  for (const node of view.model.nodes) {
    const entry = nodeEntry(node)
    if (entry === null) continue
    const cap = entry['cap']
    if (typeof cap === 'string' && !has(cap)) {
      errors.push(
        gateError(
          'port_not_pinned',
          `scope:${String(node['node_id'])}`,
          `entry.cap 不在 pins 里：${cap}`,
        ),
      )
    }
  }
  return errors
}

// ── 六不变量 ────────────────────────────────────────────────────────────────

const HIGH_RISK_PORTS = new Set(['exec', 'plugin-admin', 'orchestration-admin'])

function instanceContracts(view, contractIdValue) {
  return view.model.nodes.filter((node) => nodeContractId(node) === contractIdValue)
}

function fsWrites(contract) {
  const fs = effectsCaps(contract)['fs']
  const fsRec = isRecord(fs) ? fs : {}
  return typeof fsRec['write'] === 'string' && fsRec['write'] !== 'none'
}

function riskPorts(view, contractIdValue, depth) {
  const out = []
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

function isGuard(view, contractIdValue) {
  const contract = view.contracts.get(contractIdValue)
  return (
    (contract !== undefined && effectsPorts(contract).includes('guard')) ||
    contractIdValue === 'tool.gate'
  )
}

function isApproval(view, contractIdValue) {
  const contract = view.contracts.get(contractIdValue)
  return (
    (contract !== undefined && effectsPorts(contract).includes('approval')) ||
    contractIdValue === 'approval.wait'
  )
}

/** 不变量 1：池中始终保留一个只依赖 entry_supply 的 touches_effects:false 契约。 */
function checkFallbackEntry(view) {
  const supplyTypes = new Set(
    graphEntrySupply(view.model.graph)
      .map((item) => item['type_id'])
      .filter((value) => typeof value === 'string'),
  )
  for (const contract of view.model.contracts) {
    if (touchesEffects(contract)) continue
    const required = contractInputs(contract).filter((item) => item['required'] === true)
    const satisfied = required.every(
      (item) => typeof item['type'] === 'string' && supplyTypes.has(item['type']),
    )
    if (satisfied) return []
  }
  return [
    gateError(
      'missing_fallback_entry',
      'contracts',
      '池中缺一个只依赖 entry_supply 的 touches_effects:false 契约',
    ),
  ]
}

/** 不变量 4：声明高危端口的 Scope，其可达路径上必须存在 guard → approval 段。 */
function checkApprovalSegment(view) {
  const errors = []
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
      errors.push(
        gateError(
          'approval_bypass',
          `graph.nodes[${i}]`,
          '高危端口节点的可达路径上缺 guard→approval 段',
        ),
      )
    }
  }
  return errors
}

function nodeWeight(view, contractIdValue, depth) {
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

function maxLlmChain(view, depth) {
  const ids = graphNodes(view.model.graph)
  const dp = new Array(view.n).fill(0)
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
function checkGlobalInstance(view) {
  const errors = []
  for (const id of new Set(graphNodes(view.model.graph))) {
    if (!view.contracts.has(id)) {
      errors.push(gateError('unknown_contract', 'graph.nodes', `契约未声明：${id}`))
      continue
    }
    const hasGlobal = view.model.nodes.some(
      (node) => nodeContractId(node) === id && nodeScope(node)['kind'] === 'global',
    )
    if (!hasGlobal) {
      errors.push(
        gateError('last_global_instance', `contract:${id}`, '契约必须至少有一个 scope:global 实例'),
      )
    }
  }
  return errors
}

function checkInvariants(view) {
  const errors = []
  errors.push(...checkFallbackEntry(view))
  const hasContract = (id) => view.model.contracts.some((c) => contractId(c) === id)
  if (!hasContract('join'))
    errors.push(gateError('missing_join_contract', 'contracts', '缺 join 契约'))
  if (!hasContract('subagent'))
    errors.push(gateError('missing_subagent_contract', 'contracts', '缺 subagent 契约'))
  errors.push(...checkApprovalSegment(view))
  const max = numericThreshold(view.model.thresholds, 'llm_chain_max', 2)
  if (maxLlmChain(view, 0) > max) {
    errors.push(gateError('llm_chain_max', 'graph', `连续 LLM Scope 数超过 llm_chain_max=${max}`))
  }
  errors.push(...checkGlobalInstance(view))
  return errors
}

// ── 四演化规则 ──────────────────────────────────────────────────────────────

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

function checkEvolution(view, activeGraph, runsSinceFork) {
  const errors = []
  const derived = graphDerivedFrom(view.model.graph)
  if (derived === null) {
    errors.push(
      gateError('fork_only', 'graph.derived_from', '新图必须带 derived_from（fork-only）'),
    )
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
      errors.push(
        gateError('diff_exceeded', 'graph', `结构改动 ${diff} 超过 max_graph_diff=${maxDiff}`),
      )
    }
  }
  if (runsSinceFork !== null) {
    const min = numericThreshold(view.model.thresholds, 'min_runs_before_fork', 3)
    if (runsSinceFork < min) {
      errors.push(
        gateError('min_runs_before_fork', 'graph.derived_from', `攒够 ${min} 回合才能作为 fork 基`),
      )
    }
  }
  return errors
}

// ── 机械闸入口 ──────────────────────────────────────────────────────────────

/** 校验输入的规范化哈希口径：对 `{graph, pins, active_graph, runs_since_fork}` 做内核口径 H。 */
export function validateHashInput(input) {
  return {
    graph: input.graph === undefined ? null : input.graph,
    pins: isRecord(input.pins) ? input.pins : {},
    active_graph: input.active_graph === null ? null : input.active_graph,
    runs_since_fork: input.runs_since_fork,
  }
}

/** 对入参跑完整机械闸；返回错误列表与结果哈希（与真实 `graph-gate.validate` 同形）。 */
export function validateGraphData(input) {
  const resultHash = H(validateHashInput(input))
  const model = readGraphModel(input.graph)
  if (model === null) {
    return {
      ok: false,
      errors: [gateError('graph_missing', 'graph', '缺图数据（bag.graph）')],
      result_hash: resultHash,
    }
  }
  const view = buildView(model)
  const errors = [
    ...checkClosure(view),
    ...checkTypes(view),
    ...checkPublishOrder(view),
    ...checkPortsPinned(view, isRecord(input.pins) ? input.pins : {}),
    ...checkInvariants(view),
    ...checkEvolution(
      view,
      isRecord(input.active_graph) ? input.active_graph : null,
      input.runs_since_fork ?? null,
    ),
  ]
  return { ok: errors.length === 0, errors, result_hash: resultHash }
}
