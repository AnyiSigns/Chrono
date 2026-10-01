// `context.assemble` 前置通用汇集：按世界 `context-source` 成员表逐一反向 `collect`，
// 汇总为随 context.build bag 下传的 `context_sources`；成员不可用作数据跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_ENV, startService } from './driver.mjs'

/** 最小模型：入口 context.assemble（entry 指向 context.build）→ sink turn.commit。 */
function assembleModel() {
  return {
    contracts: [
      {
        contract_id: 'context.assemble',
        inputs: [],
        outputs: [{ name: 'message', type: 'message' }],
        effects: { ports: ['context'], methods: ['build'] },
      },
      { contract_id: 'turn.commit', inputs: [{ name: 'message', type: 'message' }], outputs: [] },
    ],
    nodes: [
      {
        node_id: 'ca',
        contract_id: 'context.assemble',
        impl: 'atomic',
        entry: { cap: 'context', method: 'build' },
        scope: { kind: 'global' },
      },
      { node_id: 'tc', contract_id: 'turn.commit', impl: 'atomic', scope: { kind: 'global' } },
    ],
    prompts: {},
    graph: {
      nodes: ['context.assemble', 'turn.commit'],
      edges: [{ from: [0, 'message'], to: [1, 'message'] }],
      entry_supply: [],
      loop: { when: '', max_iter: 'max_turn_iter' },
      sink: 1,
    },
    thresholds: { max_turn_iter: 4, max_steps: 8, gas: 8 },
    refusalCodes: [],
  }
}

function manyEnv(providers) {
  return { ...FIXED_ENV, CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify({ 'context-source': providers }) }
}

test('context.assemble 前置 collect 扇出：记录汇总进 context.build 的 bag', async () => {
  const seen = []
  const drv = startService({
    env: manyEnv(['plug-b', 'plug-a']),
    providers: {
      'context-source.collect': (args, message) => ({
        records: [
          {
            source: `src-${message.provider}`,
            role: 'system',
            parts: [{ type: 'text', text: `from ${message.provider}` }],
            priority: 0,
            stability: 'stable',
          },
        ],
      }),
      'context.build': (args) => {
        seen.push(args)
        return { messages: [{ role: 'system', content: 'x' }], params: { model: 'm' } }
      },
    },
  })
  try {
    const result = await drv.run({ bag: { input: 'hi' }, model: assembleModel() })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.equal(result.value.ended, 'done', JSON.stringify(result.value))
    assert.equal(seen.length, 1)
    // 成员按注入顺序（宿主给的是码元序）逐一 collect，记录按序汇总。
    assert.deepEqual(
      seen[0].context_sources.map((record) => record.source),
      ['src-plug-b', 'src-plug-a'],
    )
    const calls = drv.service.portCalls.filter((call) => call.port === 'context-source')
    assert.deepEqual(
      calls.map((call) => call.provider),
      ['plug-b', 'plug-a'],
    )
  } finally {
    drv.close()
  }
})

test('context.assemble 零成员：不发 collect，bag 不带 context_sources', async () => {
  const seen = []
  const drv = startService({
    env: manyEnv([]),
    providers: {
      'context.build': (args) => {
        seen.push(args)
        return { messages: [{ role: 'system', content: 'x' }], params: { model: 'm' } }
      },
    },
  })
  try {
    const result = await drv.run({ bag: { input: 'hi' }, model: assembleModel() })
    assert.equal(result.value.ended, 'done', JSON.stringify(result.value))
    assert.equal(seen.length, 1)
    assert.equal(Object.hasOwn(seen[0], 'context_sources'), false)
    assert.equal(drv.service.portCalls.some((call) => call.port === 'context-source'), false)
  } finally {
    drv.close()
  }
})

test('context.assemble 成员不可用：跳过该成员，不阻断组装', async () => {
  const seen = []
  const drv = startService({
    env: manyEnv(['plug-down', 'plug-up']),
    providers: {
      'context-source.collect': (args, message) =>
        message.provider === 'plug-down'
          ? Promise.reject(new Error('sleeping'))
          : {
              records: [
                {
                  source: 'src-up',
                  role: 'system',
                  parts: [{ type: 'text', text: 'up' }],
                  priority: 0,
                  stability: 'stable',
                },
              ],
            },
      'context.build': (args) => {
        seen.push(args)
        return { messages: [{ role: 'system', content: 'x' }], params: { model: 'm' } }
      },
    },
  })
  try {
    const result = await drv.run({ bag: { input: 'hi' }, model: assembleModel() })
    assert.equal(result.value.ended, 'done', JSON.stringify(result.value))
    assert.deepEqual(seen[0].context_sources.map((record) => record.source), ['src-up'])
  } finally {
    drv.close()
  }
})
