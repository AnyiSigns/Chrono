// `todo` 协议级测试（node --test）：写读往返、缺数据回空、非法 args / 业务拒、服务不读投影。
// 清单本体已出世界：服务从委托存储（storage-kv）取数，不再从 bag 收投影切片。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AT, startService } from './driver.mjs'

// ── 写读往返 ──────────────────────────────────────────────────────────────

test('read：写后读回条目（老→新），done 计数正确', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        at: AT,
        items: [{ text: 'first', status: 'completed' }, { text: 'second' }],
      },
    })
    const result = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.result.items.map((item) => item.text), ['first', 'second'])
    assert.equal(result.result.total, 2)
    assert.equal(result.result.done, 1)
    assert.equal('prev' in result.result.items[0], false)
  } finally {
    drv.close()
  }
})

test('read：未知会话 / 无记录回空清单（不报 missing_todo）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const empty = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'missing' } })
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.result.items, [])
    assert.equal(empty.result.total, 0)
  } finally {
    drv.close()
  }
})

test('read：会话 id 由 bag.session / bag.session_id 解析', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'a' }] },
    })
    const viaSession = await drv.call('invoke', { tool: 'todo.read', args: {}, session_id: 'c1' })
    assert.deepEqual(viaSession.result.items.map((item) => item.text), ['a'])
    const viaSlice = await drv.call('invoke', {
      tool: 'todo.read',
      args: {},
      session: { body: { current: 'c1' } },
    })
    assert.deepEqual(viaSlice.result.items.map((item) => item.text), ['a'])
  } finally {
    drv.close()
  }
})

// ── 非法 args / 业务拒 ──────────────────────────────────────────────────────

test('invoke：缺会话 id / items 非数组 / 未知工具 → 结构化拒', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const missing = await drv.call('invoke', { tool: 'todo.write', args: { items: [] } })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'bad_args')

    const badItems = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: 'nope' },
    })
    assert.equal(badItems.ok, false)
    assert.equal(badItems.error.code, 'bad_args')

    const unknown = await drv.call('invoke', { tool: 'todo.nope', args: {} })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')
  } finally {
    drv.close()
  }
})

test('write：超限 / 坏状态 → 结构化业务拒（too_many_items / text_too_long / bad_status）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const many = await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        items: Array.from({ length: 201 }, (_, i) => ({ text: `t${i}` })),
      },
    })
    assert.equal(many.error.code, 'too_many_items')

    const longText = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'x'.repeat(501) }] },
    })
    assert.equal(longText.error.code, 'text_too_long')

    const badStatus = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'a', status: 'done' }] },
    })
    assert.equal(badStatus.error.code, 'bad_status')
  } finally {
    drv.close()
  }
})

// ── 服务不读投影 ───────────────────────────────────────────────────────────

test('服务不读投影：传入的 bag.todo 被忽略，数据只来自自有存储', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 传入陈旧投影：写不得把它当基准，读不得从中取数。
    const stale = { body: { conversations: { c9: { items: [{ text: 'stale' }] } } } }
    const write = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'fresh' }] },
      todo: stale,
    })
    assert.equal(write.ok, true)
    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c9' }, todo: stale })
    assert.deepEqual(read.result.items, [])
    const own = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.deepEqual(own.result.items.map((item) => item.text), ['fresh'])
  } finally {
    drv.close()
  }
})
