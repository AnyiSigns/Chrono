// 协议级测试：v1 估算器规格向量、批量计数语义、版本自述、结构化错误。
// 与 Rust `cargo test` 的规格向量保持一致——两处同口径，锁定「同输入同输出」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

test('估算器规格向量：ASCII / CJK / 混合 / 空串 / 其他文字', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { counts } = await drv.call('count', {
      texts: [
        '',
        '   \n\t',
        'hello',
        'hello world',
        '你好',
        '你好，世界',
        'Hello世界!',
        'foo(bar, baz)',
        'Привет',
      ],
    })
    assert.deepEqual(counts, [0, 0, 1, 2, 2, 5, 4, 4, 2])
  } finally {
    drv.close()
  }
})

test('批量计数：同序同长、可空数组、同输入同输出', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const sample = 'The quick brown fox 中文测试 12345. '.repeat(50)
    const first = await drv.call('count', { texts: [sample, 'a', sample, ''] })
    assert.equal(first.counts.length, 4)
    assert.equal(first.counts[0], first.counts[2])
    assert.equal(first.counts[3], 0)
    const second = await drv.call('count', { texts: [sample, 'a', sample, ''] })
    assert.deepEqual(second.counts, first.counts)
    const empty = await drv.call('count', { texts: [] })
    assert.deepEqual(empty.counts, [])
  } finally {
    drv.close()
  }
})

test('version：回报估算器规格版本', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const { version } = await drv.call('version', {})
    assert.equal(version, 'v1')
  } finally {
    drv.close()
  }
})

test('count 入参非法 → 结构化 bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const missing = await drv.callRaw('count', {})
    assert.equal(missing.kind, 'error')
    const bad = await drv.callRaw('count', { texts: ['ok', 3] })
    assert.equal(bad.kind, 'error')
  } finally {
    drv.close()
  }
})
