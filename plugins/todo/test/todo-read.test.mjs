// `todo` 协议级测试（node --test）：todo.read 从 bag 取数 + 非法 args / 业务拒 + 不读投影 + 协议级错误。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AT, FIXED_ENV, H, opsOf, startService } from './driver.mjs'

// ── todo.read ──────────────────────────────────────────────────────────────

test('read：从 bag 投影片段（body + refs）回溯条目链，老→新', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const item0 = { id: 'x-0', text: 'first', status: 'completed', at: AT, prev: null }
    const item1 = { id: 'x-1', text: 'second', status: 'pending', at: AT, prev: { def: H(item0) } }
    const body = { conversations: { c1: { items: { tail: { def: H(item1) }, count: 2 } } } }
    const refs = { [H(item0)]: item0, [H(item1)]: item1 }
    const result = await drv.call('invoke', {
      tool: 'todo.read',
      args: { conversation_id: 'c1' },
      todo: { body, refs },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.result.items.map((item) => item.text), ['first', 'second'])
    assert.equal(result.result.total, 2)
    assert.equal(result.result.done, 1)
    assert.equal('prev' in result.result.items[0], false)
  } finally {
    drv.close()
  }
})

test('read：已解析 items 直接返回；未知会话回空清单；缺数据报 missing_todo', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const pre = await drv.call('invoke', {
      tool: 'todo.read',
      args: { conversation_id: 'c1' },
      todo: { items: [{ id: 'a', text: 'a', status: 'completed' }] },
    })
    assert.equal(pre.ok, true)
    assert.equal(pre.result.total, 1)
    assert.equal(pre.result.done, 1)

    const empty = await drv.call('invoke', {
      tool: 'todo.read',
      args: { conversation_id: 'missing' },
      todo: { body: { conversations: { c1: { items: { tail: null, count: 0 } } } }, refs: {} },
    })
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.result.items, [])

    const none = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal(none.ok, false)
    assert.equal(none.error.code, 'missing_todo')
  } finally {
    drv.close()
  }
})

// ── 非法 args / 业务拒 ──────────────────────────────────────────────────────

test('invoke：缺 conversation_id / items 非数组 / 未知工具 → 结构化拒', async () => {
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

test('服务不读投影：无 bag.todo 时 write 只落本会话键', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const write = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'a' }] },
    })
    assert.equal(write.ok, true)
    const ops = opsOf(write.result)
    const body = ops[ops.length - 2].args.body
    assert.deepEqual(Object.keys(body.conversations), ['c1'])
  } finally {
    drv.close()
  }
})

// ── 协议级错误 ─────────────────────────────────────────────────────────────

test('未知能力 / 方法 / 非对象 args → 协议级结构化错误，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.callPort('nope', 'describe', {})).code, 'unresolved_cap')
    assert.equal((await drv.callRaw('nope', {})).code, 'unknown_method')
    const badArgs = await drv.request(
      'call',
      { port: 'todo', method: 'invoke', args: 'not-an-object', env: FIXED_ENV },
      ['result', 'error'],
    )
    assert.equal(badArgs.code, 'bad_args')
    // 进程仍可服务
    const ok = await drv.call('describe', {})
    assert.equal(ok.tools.length, 2)
  } finally {
    drv.close()
  }
})
