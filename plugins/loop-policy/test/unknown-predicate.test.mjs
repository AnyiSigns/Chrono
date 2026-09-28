// 未知判据注入：loop.when 与边 when 的未知判据在进入迭代前显式拒绝（结构化结局 `refused`），
// 不再静默按 false 处理（不循环 / 不放行）。拒绝码 `when_unsat` 原样进结局 `cause.code`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'

function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

function wrapper(graph) {
  const seed = seedModel()
  return {
    contracts: seed.contracts,
    nodes: seed.nodes,
    prompts: seed.prompts,
    graph,
    thresholds: seed.thresholds,
    refusal_codes: seed.refusalCodes,
  }
}

test('未知 loop.when ⇒ 显式拒绝（不静默不循环），when_unsat 进 cause', async () => {
  const seed = seedModel()
  const graph = { ...seed.graph, loop: { ...seed.graph.loop, when: 'mystery_rule(x)' } }
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph: wrapper(graph) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.lifecycle, 'settled')
    assert.equal(summary.refused_at.code, 'when_unsat')
    assert.equal(summary.refused_at.attributable_to, 'graph')
    const settle = settlesOf(service)[0]
    assert.ok(settle, '未知判据必须显式收口')
    assert.equal(settle.outcome.kind, 'refused')
    assert.equal(settle.outcome.code, 'downstream_refusal', '结局层取封闭码')
    assert.equal(settle.outcome.cause.code, 'when_unsat', '下游码原样进 cause')
    assert.equal(settle.outcome.attributableTo, 'graph')
  } finally {
    service.close()
  }
})

test('未知边 when ⇒ 同样显式拒绝，不按 false 静默放行', async () => {
  const seed = seedModel()
  const graph = {
    ...seed.graph,
    edges: seed.graph.edges.map((edge) =>
      edge.when === 'nonempty(tool_calls)' ? { ...edge, when: 'mystery_rule(x)' } : edge,
    ),
  }
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph: wrapper(graph) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'when_unsat')
  } finally {
    service.close()
  }
})
