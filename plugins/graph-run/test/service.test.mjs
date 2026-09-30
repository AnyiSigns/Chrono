// graph-run 协议级冒烟：hello / run（最小图）/ cancel（入口命中即停，不派发节点）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

/** 最小可执行模型：入口 agent.step → sink turn.commit，无工具。 */
function tinyModel() {
  return {
    contracts: [
      {
        contract_id: 'agent.step',
        inputs: [{ name: 'messages', type: 'messages' }],
        outputs: [
          { name: 'message', type: 'message' },
          { name: 'tool_calls', type: 'tool_calls' },
        ],
        effects: { ports: ['model'], methods: ['chat'] },
      },
      { contract_id: 'turn.commit', inputs: [{ name: 'message', type: 'message' }], outputs: [] },
    ],
    nodes: [
      {
        node_id: 'as-step',
        contract_id: 'agent.step',
        impl: 'atomic',
        entry: { cap: 'model', method: 'chat' },
        scope: { kind: 'global' },
      },
      { node_id: 'as-commit', contract_id: 'turn.commit', impl: 'atomic', scope: { kind: 'global' } },
    ],
    prompts: {},
    graph: {
      nodes: ['agent.step', 'turn.commit'],
      edges: [{ from: [0, 'message'], to: [1, 'message'] }],
      entry_supply: [],
      loop: { when: '', max_iter: 'max_turn_iter' },
      sink: 1,
    },
    thresholds: { max_turn_iter: 4, max_steps: 8, gas: 8 },
    refusalCodes: [],
  }
}

test('hello 回 manifest（graph-run 方法面 / needs）', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'graph-run')
    assert.deepEqual(manifest.implements, ['graph-run'])
    assert.deepEqual(manifest.methods['graph-run'], ['run', 'cancel'])
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('run：最小图执行，回执行结果与 trace 事实（steps / outcome）', async () => {
  const drv = startService()
  try {
    const result = await drv.run({ bag: {}, model: tinyModel() })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.equal(result.value.ended, 'done')
    assert.equal(result.value.lifecycle, 'settled')
    assert.equal(result.value.trace.outcome, 'done')
    assert.ok(Array.isArray(result.value.trace.steps) && result.value.trace.steps.length >= 1)
    assert.equal(result.value.trace.steps[0].contract_id, 'agent.step')
  } finally {
    drv.close()
  }
})

test('cancel：进入解释前已置标志 ⇒ 不派发任何节点，ended=cancelled', async () => {
  const drv = startService()
  try {
    const cancelled = await drv.cancel({ turn_id: 't-early' })
    assert.equal(cancelled.kind, 'result')
    assert.equal(cancelled.value.cancelled, true)
    const result = await drv.run({ bag: { turn_id: 't-early' }, model: tinyModel() })
    assert.equal(result.value.ended, 'cancelled')
    assert.equal(result.value.trace.steps.length, 0)
  } finally {
    drv.close()
  }
})
