// `todo` 协议级测试（node --test）：`todo.update` 增量操作 —— add / update / remove / move、
// 稳定 id、焦点唯一、activeForm 增删、业务拒（item_not_found / unknown_op / too_many_items）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

async function seed(drv, texts, extra = {}) {
  return drv.call('invoke', {
    tool: 'todo.write',
    args: { conversation_id: 'c1', items: texts.map((text) => ({ text })), ...extra },
  })
}

test('update：add / update / remove / move 顺次作用于同一清单', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, ['a', 'b', 'c'])

    const result = await drv.call('invoke', {
      tool: 'todo.update',
      args: {
        conversation_id: 'c1',
        ops: [
          { op: 'update', id: 't1', status: 'in_progress', activeForm: '正在做 b' },
          { op: 'add', text: 'd' },
          { op: 'remove', id: 't0' },
          { op: 'move', id: 't2', index: 0 },
        ],
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result.total, 3)
    assert.equal('items' in result.result, false, 'update 不回传全表')
    assert.deepEqual(
      result.result.changed.map((item) => item.id),
      ['t1', 't3', 't0', 't2'],
    )

    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.deepEqual(
      read.result.items.map((item) => item.text),
      ['c', 'b', 'd'],
    )
    assert.deepEqual(
      read.result.items.map((item) => item.id),
      ['t2', 't1', 't3'],
    )
    assert.equal(read.result.items[1].status, 'in_progress')
    assert.equal(read.result.items[1].activeForm, '正在做 b')
  } finally {
    drv.close()
  }
})

test('update：焦点唯一 —— 置新条为 in_progress 会把旧的降回 pending', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, ['a', 'b'])
    await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'update', id: 't0', status: 'in_progress' }] },
    })
    const result = await drv.call('invoke', {
      tool: 'todo.update',
      args: {
        conversation_id: 'c1',
        ops: [
          { op: 'update', id: 't1', status: 'in_progress' },
          { op: 'update', id: 't0', status: 'completed' },
        ],
      },
    })
    assert.equal(result.ok, true)
    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal(read.result.items[0].status, 'completed')
    assert.equal(read.result.items[1].status, 'in_progress')
  } finally {
    drv.close()
  }
})

test('update：activeForm 传空串清除；status rejected 值 → bad_status', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        items: [{ text: 'a', status: 'in_progress', activeForm: '正在做' }],
      },
    })
    const cleared = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'update', id: 't0', activeForm: '' }] },
    })
    assert.equal(cleared.ok, true)
    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal('activeForm' in read.result.items[0], false)

    const bad = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'update', id: 't0', status: 'done' }] },
    })
    assert.equal(bad.error.code, 'bad_status')
  } finally {
    drv.close()
  }
})

test('update：id 不存在 / op 非法 / ops 空 / index 非法 → 结构化拒', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await seed(drv, ['a'])

    const missing = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'update', id: 'nope', status: 'completed' }] },
    })
    assert.equal(missing.error.code, 'item_not_found')

    const unknownOp = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'explode' }] },
    })
    assert.equal(unknownOp.error.code, 'unknown_op')

    const empty = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [] },
    })
    assert.equal(empty.error.code, 'bad_args')

    const badIndex = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'move', id: 't0', index: 'x' }] },
    })
    assert.equal(badIndex.error.code, 'bad_args')

    const noSession = await drv.call('invoke', {
      tool: 'todo.update',
      args: { ops: [{ op: 'add', text: 'z' }] },
    })
    assert.equal(noSession.error.code, 'bad_args')
  } finally {
    drv.close()
  }
})

test('update：条数超 max_items 在应用后拒绝', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const items = Array.from({ length: 200 }, (_, i) => ({ text: `t${i}` }))
    await drv.call('invoke', { tool: 'todo.write', args: { conversation_id: 'c1', items } })
    const over = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'add', text: 'overflow' }] },
    })
    assert.equal(over.error.code, 'too_many_items')
  } finally {
    drv.close()
  }
})

test('update：稳定 id 不与显式 / 存量 id 冲突', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 显式给 t5：下一个自动分配应为 t6，而非从 t0 撞车。
    await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ id: 't5', text: 'a' }] },
    })
    const added = await drv.call('invoke', {
      tool: 'todo.update',
      args: { conversation_id: 'c1', ops: [{ op: 'add', text: 'b' }] },
    })
    assert.equal(added.ok, true)
    assert.equal(added.result.changed[0].id, 't6')
    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.deepEqual(
      read.result.items.map((item) => item.id),
      ['t5', 't6'],
    )
  } finally {
    drv.close()
  }
})
