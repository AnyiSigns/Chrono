// 种子图 / 默认阈值 / 回落解析的单元测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLDS, SEED_CONTRACTS, SEED_GRAPH, SEED_NODES, resolveModel, seedModel } from '../execute/seed.ts'
import { nodeContractId, nodeScope } from '../execute/model.ts'

test('种子契约十一个且含 join / subagent / evolve.propose / recall 词汇', () => {
  const ids = SEED_CONTRACTS.map((c) => c.contract_id)
  assert.equal(ids.length, 11)
  for (const required of ['recall', 'context.assemble', 'agent.step', 'tool.gate', 'approval.wait', 'tool.dispatch', 'verify', 'join', 'subagent', 'evolve.propose', 'turn.commit']) {
    assert.ok(ids.includes(required), `缺契约 ${required}`)
  }
})

test('池词汇完整：每个契约至少一个 scope:global 实例', () => {
  const contracts = new Set(SEED_CONTRACTS.map((c) => c.contract_id))
  for (const id of contracts) {
    const hasGlobal = SEED_NODES.some((n) => nodeContractId(n) === id && nodeScope(n)['kind'] === 'global')
    assert.ok(hasGlobal, `契约 ${id} 缺 global 实例`)
  }
})

test('种子图七节点、sink = turn.commit', () => {
  assert.equal(SEED_GRAPH.nodes.length, 7)
  assert.equal(SEED_GRAPH.sink, 6)
  assert.equal(SEED_GRAPH.nodes[6], 'turn.commit')
})

test('默认阈值覆盖 evolve-metrics 阈值契约字段名', () => {
  for (const name of [
    'failure_cluster_n',
    'post_failure_ratio',
    'post_failure_min',
    'cost_anomaly_multiple',
    'drift_margin',
    'drift_min_samples',
    'fold_k',
    'no_progress_n',
    'verify_failure_n',
    'verify_cluster_ratio',
    'min_workspaces',
    'trace_retention_rounds',
    'unhealthy_refused_streak',
  ]) {
    assert.equal(typeof DEFAULT_THRESHOLDS[name], 'number', `缺阈值 ${name}`)
  }
})

test('resolveModel：空 body 回落种子图；合法图按提供', () => {
  const empty = resolveModel(undefined, {})
  assert.equal(empty.fellBack, true)
  assert.equal(empty.model.graph.nodes.length, 7)

  const model = seedModel()
  const wrapper = {
    contracts: model.contracts,
    nodes: model.nodes,
    prompts: model.prompts,
    graph: model.graph,
    thresholds: model.thresholds,
    refusal_codes: model.refusalCodes,
  }
  const provided = resolveModel(wrapper, {})
  assert.equal(provided.fellBack, false)
  assert.equal(provided.model.graph.nodes.length, 7)
})

test('resolveModel：图引用未声明契约 ⇒ 回落种子图', () => {
  const model = seedModel()
  const wrapper = { contracts: [], nodes: [], prompts: {}, graph: { nodes: ['unknown.contract'], edges: [], sink: 0 }, thresholds: {}, refusal_codes: [] }
  const resolved = resolveModel(wrapper, {})
  assert.equal(resolved.fellBack, true)
  void model
})
