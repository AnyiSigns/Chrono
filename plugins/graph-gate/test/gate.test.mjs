// 机械闸（**权威实现**）测试：六条图不变量 + 四条演化规则的正 / 反例；错误码 / 哈希口径对拍。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildView,
  checkClosure,
  checkPortsPinned,
  checkPublishOrder,
  checkTypes,
  validateGraphData,
} from '../execute/gate.ts'
import { checkEvolution, checkInvariants } from '../execute/invariants.ts'
import { seedModel } from './fixtures.mjs'

const PINS = {
  session: 'session',
  model: 'model-protocol',
  context: 'context-window',
  guard: 'guard',
  approval: 'approval',
  tools: 'tools',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
}

function clone(model) {
  return JSON.parse(JSON.stringify(model))
}

test('种子图：闭合 / 类型 / publish / 端口 ⊆ pins / 六不变量 全通过', () => {
  const model = seedModel()
  const view = buildView(model)
  assert.deepEqual(checkClosure(view), [])
  assert.deepEqual(checkTypes(view), [])
  assert.deepEqual(checkPublishOrder(view), [])
  assert.deepEqual(checkPortsPinned(view, PINS), [])
  assert.deepEqual(checkInvariants(view), [])
})

test('不变量 1：删掉全部只依赖 entry_supply 的纯契约 ⇒ missing_fallback_entry', () => {
  const model = clone(seedModel())
  const drop = new Set(['context.assemble', 'join', 'turn.commit'])
  model.contracts = model.contracts.filter((c) => !drop.has(c.contract_id))
  const codes = checkInvariants(buildView(model)).map((e) => e.code)
  assert.ok(codes.includes('missing_fallback_entry'), codes.join(','))
})

test('不变量 2 / 3：缺 join / subagent ⇒ 对应码', () => {
  const model = clone(seedModel())
  model.contracts = model.contracts.filter(
    (c) => c.contract_id !== 'join' && c.contract_id !== 'subagent',
  )
  const codes = checkInvariants(buildView(model)).map((e) => e.code)
  assert.ok(codes.includes('missing_join_contract'))
  assert.ok(codes.includes('missing_subagent_contract'))
})

test('不变量 4：高危端口无 guard→approval 段 ⇒ approval_bypass', () => {
  const model = clone(seedModel())
  // 删掉 gate / approval 节点，dispatch 直接从 step 接 verdict。
  model.nodes = model.nodes.filter((n) => !['as-gate', 'as-approval'].includes(n.node_id))
  model.graph.nodes = ['context.assemble', 'agent.step', 'tool.dispatch', 'turn.commit']
  model.graph.edges = [
    { from: [0, 'messages'], to: [1, 'messages'] },
    { from: [1, 'tool_calls'], to: [2, 'verdict'], when: 'nonempty(tool_calls)' },
    { from: [1, 'message'], to: [3, 'message'], when: 'empty(tool_calls)' },
    { from: [2, 'results'], to: [3, 'results'] },
  ]
  model.graph.sink = 3
  const codes = checkInvariants(buildView(model)).map((e) => e.code)
  assert.ok(codes.includes('approval_bypass'), codes.join(','))
})

test('不变量 5：三连 LLM ⇒ llm_chain_max', () => {
  const model = clone(seedModel())
  model.graph.nodes = [
    'context.assemble',
    'agent.step',
    'subagent',
    'evolve.propose',
    'turn.commit',
  ]
  model.graph.edges = [
    { from: [0, 'messages'], to: [1, 'messages'] },
    { from: [1, 'message'], to: [2, 'messages'] },
    { from: [2, 'message'], to: [3, 'task'] },
    { from: [3, 'proposal'], to: [4, 'results'] },
  ]
  model.graph.sink = 4
  const codes = checkInvariants(buildView(model)).map((e) => e.code)
  assert.ok(codes.includes('llm_chain_max'), codes.join(','))
})

test('不变量 6：图内契约无 global 实例 ⇒ last_global_instance', () => {
  const model = clone(seedModel())
  model.nodes = model.nodes.map((n) =>
    n.contract_id === 'agent.step' ? { ...n, scope: { kind: 'workspace', workspace_id: 'w1' } } : n,
  )
  const codes = checkInvariants(buildView(model)).map((e) => e.code)
  assert.ok(codes.includes('last_global_instance'), codes.join(','))
})

test('演化 1：derived_from 缺失 / 不指向 active ⇒ fork_only', () => {
  const model = seedModel()
  const view = buildView(model)
  assert.ok(checkEvolution(view, null, null).some((e) => e.code === 'fork_only'))
  const withDerived = clone(model)
  withDerived.graph.derived_from = 'a'.repeat(64)
  assert.ok(
    checkEvolution(buildView(withDerived), { nodes: [] }, null).some((e) => e.code === 'fork_only'),
  )
})

test('演化 2：diff 超 max_graph_diff ⇒ diff_exceeded', () => {
  const model = clone(seedModel())
  const candidate = clone(model.graph)
  candidate.nodes = [...candidate.nodes, 'join', 'subagent', 'evolve.propose']
  const withDerived = {
    ...model,
    graph: candidate,
    thresholds: { ...model.thresholds, max_graph_diff: 2 },
  }
  const codes = checkEvolution(buildView(withDerived), model.graph, null).map((e) => e.code)
  assert.ok(codes.includes('diff_exceeded'), codes.join(','))
})

test('演化 3：runs_since_fork 不足 ⇒ min_runs_before_fork', () => {
  const model = clone(seedModel())
  model.graph.derived_from = 'b'.repeat(64)
  const codes = checkEvolution(buildView(model), model.graph, 0).map((e) => e.code)
  assert.ok(codes.includes('min_runs_before_fork'), codes.join(','))
})

test('validateGraphData：错误码 / 结果哈希口径稳定（对拍）', () => {
  const model = seedModel()
  const wrapper = {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph: model.graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
  const result = validateGraphData({
    graph: wrapper,
    pins: PINS,
    active_graph: null,
    runs_since_fork: null,
  })
  assert.match(result.result_hash, /^[0-9a-f]{64}$/)
  // 种子图缺 derived_from ⇒ fork_only（演化 1），其余通过。
  assert.deepEqual(
    result.errors.map((e) => e.code),
    ['fork_only'],
  )
  const missing = validateGraphData({
    graph: null,
    pins: PINS,
    active_graph: null,
    runs_since_fork: null,
  })
  assert.equal(missing.errors[0].code, 'graph_missing')
})

test('闭合反例：环 / sink / 未连 required 输入', () => {
  const model = clone(seedModel())
  model.graph.edges = [...model.graph.edges, { from: [6, 'plan'], to: [0, 'task'] }]
  assert.ok(checkClosure(buildView(model)).some((e) => e.code === 'cycle'))
})

test('G7：unconnected_input 只约束 required 输入；optional 未连不报', () => {
  const base = () => {
    const model = clone(seedModel())
    model.contracts.push({
      contract_id: 'opt.only',
      role_tag: 'opt',
      inputs: [
        { name: 'x', type: 'any', required: false, cardinality: 1, binding_mode: 'all' },
        { name: 'y', type: 'any', required: false, cardinality: 1, binding_mode: 'all' },
      ],
      outputs: [{ name: 'out', type: 'any', cardinality: 1 }],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: [], methods: [] },
      idempotent: true,
      touches_effects: false,
      can_delegate: false,
      cost: {},
    })
    model.nodes.push({
      node_id: 'opt-node',
      contract_id: 'opt.only',
      impl: 'atomic',
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    })
    model.graph = {
      nodes: ['context.assemble', 'opt.only'],
      edges: [{ from: [0, 'messages'], to: [1, 'y'] }],
      entry_supply: [{ type_id: 'task' }],
      loop: { when: '' },
      sink: 1,
    }
    return model
  }
  // optional 的 x 未连：不报 unconnected_input。
  assert.equal(
    checkClosure(buildView(base())).some((e) => e.code === 'unconnected_input'),
    false,
  )
  // required 的 x 未连：报 unconnected_input（节点仍有 y 入边，不触发 non_entry_isolated）。
  const req = base()
  req.contracts = req.contracts.map((c) =>
    c.contract_id === 'opt.only'
      ? {
          ...c,
          inputs: c.inputs.map((port) => (port.name === 'x' ? { ...port, required: true } : port)),
        }
      : c,
  )
  assert.ok(checkClosure(buildView(req)).some((e) => e.code === 'unconnected_input'))
})
