// 降级判定（§15）：agent.step 失败 → port.call router.select → 以返回端口名派发备选实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'

function bagWith(pins, modelAliasPins) {
  const seed = seedModel()
  const thresholds = { ...seed.thresholds }
  if (modelAliasPins !== undefined) thresholds.model_alias_pins = modelAliasPins
  return {
    pins,
    graph: {
      contracts: seed.contracts,
      nodes: seed.nodes,
      prompts: seed.prompts,
      graph: seed.graph,
      thresholds,
      refusal_codes: seed.refusalCodes,
    },
  }
}

const PINS = {
  session: 'session',
  model: 'model-provider',
  'model-alt': 'alt-provider',
  context: 'context-window',
  retrieval: 'memory-retrieval',
  guard: 'guard',
  approval: 'approval',
  tools: 'tools',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
}

function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

test('有别名：model.chat 失败 → router.select → model-alt.chat 成功', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: false, error: { code: 'model_unsupported', message: 'no' } }),
      'model-alt.chat': () => ({ ok: true, text: 'alt answered', tool_calls: [], usage: {} }),
      'router.select': (args) => {
        assert.ok(args.candidates.includes('model-alt'))
        assert.deepEqual(args.aliases, ['model-alt'])
        return 'model-alt'
      },
    },
  })
  try {
    const result = await service.interpret(bagWith(PINS, ['model-alt']))
    const seq = service.portCalls.map((call) => `${call.port}.${call.method}`)
    assert.ok(seq.includes('router.select'), seq.join(','))
    assert.ok(seq.includes('model-alt.chat'), seq.join(','))
    assert.equal(summaryOf(result.value).ended, 'done')
  } finally {
    service.close()
  }
})

test('无别名：不调 router.select，失败按拒绝码收口（机械 no-op）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: false, error: { code: 'model_unsupported', message: 'no' } }),
    },
  })
  try {
    const result = await service.interpret(bagWith(PINS, []))
    assert.ok(!service.portCalls.some((call) => call.method === 'select'), '不应调 router.select')
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'model_unsupported')
  } finally {
    service.close()
  }
})
