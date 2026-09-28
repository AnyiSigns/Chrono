// 接缝契约：loop-policy 的写期机械闸与 orchestration-admin 的 validate 预检逐项对拍。
// 权威 = loop-policy 写期机械闸；orchestration-admin 的 validate 只是预检。两处实现若漂移，本测试即失败。
// 该断言同时引用两个插件，属跨插件测试，故住根 tests/contract/。
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateGraphData } from '../../plugins/loop-policy/execute/gate.ts'
import { seedModel } from '../../plugins/loop-policy/execute/seed.ts'
import { H } from '../../plugins/loop-policy/execute/hash.ts'
import { validateBag } from '../../plugins/orchestration-admin/execute/gate.ts'

const PINS = {
  session: 'session',
  model: 'model-protocol',
  context: 'context-window',
  retrieval: 'memory-retrieval',
  guard: 'guard',
  approval: 'approval',
  tools: 'tools',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function wrapper(graph) {
  const model = seedModel()
  return {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
}

function compare(label, bag) {
  const mine = validateGraphData({
    graph: bag.graph,
    pins: bag.pins,
    active_graph: bag.active_graph ?? null,
    runs_since_fork: bag.runs_since_fork ?? null,
  })
  const theirs = validateBag(bag)
  assert.deepEqual(
    mine.errors.map((e) => e.code),
    theirs.errors.map((e) => e.code),
    `${label}：错误码应一致`,
  )
  assert.equal(mine.result_hash, theirs.result_hash, `${label}：结果哈希应一致`)
  assert.equal(mine.ok, theirs.ok, `${label}：ok 应一致`)
}

test('对拍：种子图（缺 derived_from）', () => {
  const model = seedModel()
  compare('seed', { graph: wrapper(model.graph), pins: PINS, active_graph: null, runs_since_fork: null })
})

test('对拍：fork-only 候选图（带 derived_from，diff 0）', () => {
  const model = seedModel()
  const candidate = clone(model.graph)
  candidate.derived_from = H(model.graph)
  compare('fork', { graph: wrapper(candidate), pins: PINS, active_graph: model.graph, runs_since_fork: 10 })
})

test('对拍：高危端口无 guard→approval 段', () => {
  const model = seedModel()
  const candidate = clone(model.graph)
  candidate.nodes = ['context.assemble', 'agent.step', 'tool.dispatch', 'turn.commit']
  candidate.edges = [
    { from: [0, 'messages'], to: [1, 'messages'] },
    { from: [1, 'tool_calls'], to: [2, 'verdict'], when: 'nonempty(tool_calls)' },
    { from: [1, 'message'], to: [3, 'message'], when: 'empty(tool_calls)' },
    { from: [2, 'results'], to: [3, 'results'] },
  ]
  candidate.sink = 3
  candidate.derived_from = H(model.graph)
  const nodes = model.nodes.filter((n) => !['as-gate', 'as-approval'].includes(n.node_id))
  const w = wrapper(candidate)
  w.nodes = nodes
  compare('approval_bypass', { graph: w, pins: PINS, active_graph: model.graph, runs_since_fork: 10 })
})

test('对拍：端口不在 pins / 类型不匹配 / 缺 join', () => {
  const model = seedModel()
  const candidate = clone(model.graph)
  candidate.derived_from = H(model.graph)
  const w = wrapper(candidate)
  w.contracts = w.contracts.filter((c) => c.contract_id !== 'join')
  compare('multi', { graph: w, pins: { model: 'model-protocol' }, active_graph: model.graph, runs_since_fork: 10 })
})
