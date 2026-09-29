// 跨插件契约测试（根 tests/contract/ 允许多插件 import，插件内不得直连）：
// 机械闸已单源在 graph-gate——loop-policy 只负责造图（seed.ts），orchestration-admin 只负责委派
// （gate-call.ts → `port.call graph-gate.validate`）。原「两份实现对拍」前提消失，本文件改写为：
//   1. graph-gate.validate 对若干图产出的错误码 / 结果哈希符合拆分前口径（单源金标准）；
//   2. orchestration-admin.validate 委派到 graph-gate 后结果逐字节一致。
// 文件名沿用原名，内容已由「实现 parity」改为「单源契约 + 委派一致性」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateGraphData, validateHashInput } from '../../plugins/graph-gate/execute/gate.ts'
import { H } from '../../plugins/graph-gate/execute/hash.ts'
import { seedModel } from '../../plugins/loop-policy/execute/seed.ts'
import {
  validateArgsOf,
  validateViaGraphGate,
} from '../../plugins/orchestration/execute/gate-call.ts'

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

/** 图六类条目包装（与 bag.graph 同形）。 */
function wrapperOf(graph, model) {
  return {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
}

/** 机械闸入参 bag：graph = 六类条目包装，其余按场景。 */
function bagOf(graph, { pins = PINS, active = null, runs = null } = {}) {
  return { graph, pins, active_graph: active, runs_since_fork: runs }
}

/** 直接消费真实 graph-gate.validate（单源权威）。 */
function direct(bag) {
  return validateGraphData(validateArgsOf(bag))
}

/** 委派端口：graph-gate.validate 桥接到真实实现，其余能力类不可用。 */
function delegatingPort() {
  return {
    call: async (cap, method, args) => {
      if (cap === 'graph-gate' && method === 'validate') {
        return { ok: true, value: validateGraphData(args) }
      }
      return { ok: false, code: 'unresolved_cap', message: `${cap}.${method}` }
    },
  }
}

function assertHashFormula(bag, result) {
  assert.match(result.result_hash, /^[0-9a-f]{64}$/)
  assert.equal(result.result_hash, H(validateHashInput(validateArgsOf(bag))))
}

/** 种子图（缺 derived_from）：仅演化规则 1 触发 fork_only。 */
function seedScenario() {
  const model = seedModel()
  const bag = bagOf(wrapperOf(model.graph, model))
  return { bag, codes: ['fork_only'] }
}

/** 合法 fork（derived_from = H(active)，结构零差异，攒够回合）：全通过。 */
function forkScenario() {
  const model = seedModel()
  const candidate = clone(model.graph)
  candidate.derived_from = H(model.graph)
  const bag = bagOf(wrapperOf(candidate, model), { active: model.graph, runs: 10 })
  return { bag, codes: [] }
}

/** 高危端口无 guard→approval 段：approval_bypass（并伴随类型不匹配 / diff 超限，与拆分前同口径）。 */
function approvalBypassScenario() {
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
  const nodes = model.nodes.filter((node) => !['as-gate', 'as-approval'].includes(node.node_id))
  const bag = bagOf(wrapperOf(candidate, { ...model, nodes }), {
    active: model.graph,
    runs: 10,
  })
  return { bag, codes: ['type_mismatch', 'approval_bypass', 'diff_exceeded'] }
}

/** 端口 ⊄ pins + 缺 join 契约：port_not_pinned（多条）+ missing_join_contract。 */
function multiScenario() {
  const model = seedModel()
  const candidate = clone(model.graph)
  candidate.derived_from = H(model.graph)
  const contracts = model.contracts.filter((contract) => contract.contract_id !== 'join')
  const bag = bagOf(wrapperOf(candidate, { ...model, contracts }), {
    pins: { model: 'model-protocol' },
    active: model.graph,
    runs: 10,
  })
  return { bag }
}

const SCENARIOS = [
  ['种子图（缺 derived_from）', seedScenario],
  ['合法 fork（derived_from = H(active)，diff 0）', forkScenario],
  ['高危端口无 guard→approval 段', approvalBypassScenario],
  ['端口不在 pins / 缺 join', multiScenario],
]

test('单源口径：graph-gate.validate 对若干图产出稳定错误码 / 结果哈希', () => {
  for (const [label, build] of SCENARIOS) {
    const { bag, codes: expected } = build()
    const result = direct(bag)
    const codes = result.errors.map((error) => error.code)
    assertHashFormula(bag, result)
    if (expected !== undefined) {
      assert.deepEqual(codes, expected, `${label}：错误码应与拆分前口径一致`)
      assert.equal(result.ok, expected.length === 0, `${label}：ok 应与错误码一致`)
    } else {
      // 多错场景：只看结构断言（pins 缺 14 处 + 缺 join），避免把条数写死。
      assert.equal(codes[codes.length - 1], 'missing_join_contract', `${label}：缺 join 契约`)
      assert.equal(
        codes.filter((code) => code !== 'port_not_pinned').length,
        1,
        `${label}：除 port_not_pinned 外只应有 missing_join_contract`,
      )
      assert.ok(
        codes.filter((code) => code === 'port_not_pinned').length >= 2,
        `${label}：端口未 pin 应逐条列出`,
      )
    }
  }
})

test('委派一致性：orchestration-admin.validate 经 graph-gate.validate 结果逐字节一致', async () => {
  const port = delegatingPort()
  for (const [label, build] of SCENARIOS) {
    const { bag } = build()
    const expected = direct(bag)
    const actual = await validateViaGraphGate(port, bag)
    assert.equal(actual.ok, expected.ok, `${label}：ok 一致`)
    assert.deepEqual(actual.errors, expected.errors, `${label}：错误列表一致`)
    assert.equal(actual.result_hash, expected.result_hash, `${label}：结果哈希一致`)
  }
})

test('提供方不可用：orchestration-admin.validate 结构化失败（不本地兜底）', async () => {
  const port = { call: async () => ({ ok: false, message: 'graph-gate down' }) }
  const result = await validateViaGraphGate(port, bagOf(wrapperOf(seedModel().graph, seedModel())))
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'graph_gate_unavailable')
  assert.equal(result.result_hash, '')
})
