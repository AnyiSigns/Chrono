// 协议级测试：manifest 方法面、model / factor / observe 端到端、结构化错误。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

test('manifest 声明 budget 三方法', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'budget')
    assert.deepEqual(manifest.methods['budget'].sort(), ['factor', 'model', 'observe'])
  } finally {
    drv.close()
  }
})

test('model / factor / observe 端到端', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const model = await drv.call('model', {
      config: { context_window: 1000, max_output: 100 },
      policy: {
        margin_ratio: 0.05,
        default_context_window: 8192,
        default_max_output: 1024,
        quota: { l2: 0.08, l1: 0.08, skill: 0.1, recall: 0.12, style: 0.03 },
      },
    })
    assert.equal(model.budget, 950)
    assert.equal(model.quota.l2, Math.floor(950 * 0.08))

    const factor1 = await drv.call('factor', { model: 'svc-model' })
    assert.equal(factor1.factor, 1)
    const observed = await drv.call('observe', {
      model: 'svc-model',
      estimate: 100,
      usage: { prompt_tokens: 50, cached_tokens: 10 },
    })
    assert.equal(observed.usage.prompt_tokens, 50)
    // 首次只有估算、无上次估算可比，系数保持 1。
    assert.equal(observed.factor, 1)
  } finally {
    drv.close()
  }
})

test('入参非法 → 结构化 bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const noModel = await drv.callRaw('factor', {})
    assert.equal(noModel.kind, 'error')
    const badEstimate = await drv.callRaw('observe', { model: 'm', estimate: -1 })
    assert.equal(badEstimate.kind, 'error')
    // policy 缺键回落默认，仍是合法调用。
    const minimal = await drv.call('model', { config: null })
    assert.equal(minimal.origin, 'default')
  } finally {
    drv.close()
  }
})
