// `todo` 服务协议级测试（node --test）：握手 / 控制 / 自退出 + describe +
// 运行记录写读往返 + 世界不再新增世代 + 边跑边追加 + 委托存储清理。
// 清单本体已出世界：服务把读写委托给 storage-kv（驱动桥接内存假后端）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AT, FIXED_ENV, assertNoDirectives, startService } from './driver.mjs'

// 红线断言（包形状）；本包 test 脚本按文件显式列出，故在此引入使其随 npm test 执行。
import './package.test.mjs'

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：身份 / 能力类 / 方法与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'todo')
    assert.deepEqual(manifest.implements, ['todo'])
    assert.deepEqual(manifest.methods.todo, ['describe', 'invoke'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'durable')
  } finally {
    drv.close()
  }
})

test('reload → ack / probe → pong / drain → bye', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
})

// ── describe ───────────────────────────────────────────────────────────────

test('describe：单一 todo 工具（action 分派）+ 四要素 + argsSchema + caps（无 fs / 无 net）+ render', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('describe', {})
    const tools = value.tools
    assert.deepEqual(tools.map((tool) => tool.name), ['todo'])
    for (const tool of tools) {
      for (const field of ['intent', 'when_to_use', 'boundaries', 'description']) {
        assert.ok(
          typeof tool[field] === 'string' && tool[field].length > 0,
          `${tool.name} missing ${field}`,
        )
      }
      assert.ok(
        tool.param_semantics !== null && typeof tool.param_semantics === 'object',
        `${tool.name} missing param_semantics`,
      )
      for (const key of tool.argsSchema.required ?? []) {
        assert.ok(tool.param_semantics[key] !== undefined, `${tool.name} param ${key}`)
      }
      assert.deepEqual(tool.caps.fs, { read: 'none', write: 'none' })
      assert.equal(tool.caps.net, 'none')
      assert.equal(tool.render.form, 'card')
      assert.equal(tool.render.label, 'todo')
      assert.equal(tool.render.summary, '{done}/{total} 已完成')
      assert.deepEqual(tool.render.detail, { kind: 'list', fields: ['text', 'status'] })
    }
    const todo = tools[0]
    assert.equal(todo.render.tone, 'plain')
    assert.equal(todo.idempotent, false)
    assert.equal(todo.binding, undefined)
    assert.deepEqual(todo.argsSchema.properties.action.enum, ['replace', 'update', 'read'])
    assert.deepEqual(todo.argsSchema.required, ['action'])
    // 死接口已移除；状态枚举单一来源（含 cancelled）。
    assert.equal('body' in todo.argsSchema.properties, false)
    assert.deepEqual(todo.argsSchema.properties.items.items.properties.status.enum, [
      'pending',
      'in_progress',
      'completed',
      'cancelled',
    ])
    assert.equal('priority' in todo.argsSchema.properties.items.items.properties, false)
    assert.equal('activeForm' in todo.argsSchema.properties.items.items.properties, true)
  } finally {
    drv.close()
  }
})

test('invoke：合并工具 todo 按 action 派发 replace / update / read；非法 action 回 bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const replace = await drv.call('invoke', {
      tool: 'todo',
      args: { action: 'replace', items: [{ text: 'a' }] },
      session_id: 'c1',
    })
    assert.equal(replace.ok, true, JSON.stringify(replace))
    assert.equal(replace.result.total, 1)
    const update = await drv.call('invoke', {
      tool: 'todo',
      args: { action: 'update', ops: [{ op: 'add', text: 'b' }] },
      session_id: 'c1',
    })
    assert.equal(update.ok, true, JSON.stringify(update))
    assert.equal(update.result.changed.length, 1)
    const read = await drv.call('invoke', { tool: 'todo', args: { action: 'read' }, session_id: 'c1' })
    assert.equal(read.ok, true)
    assert.equal(read.result.total, 2)
    const bad = await drv.call('invoke', { tool: 'todo', args: { action: 'nope' }, session_id: 'c1' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad_args')
  } finally {
    drv.close()
  }
})

// ── 写读往返 + 世界不再新增世代 ─────────────────────────────────────────────
test('write/read 往返：整表替换、稳定 id、条目形状、done 计数；不产世界写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const written = await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        at: AT,
        items: [{ text: '写文档' }, { text: '跑测试', status: 'in_progress', activeForm: '正在跑测试' }],
      },
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    assertNoDirectives(written.result)
    assert.equal(written.result.total, 2)
    assert.equal(written.result.done, 0)
    assert.equal(written.result.conversation_id, 'c1')
    assert.equal('items' in written.result, false, 'write 不回传全表')

    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal(read.ok, true)
    assertNoDirectives(read.result)
    assert.deepEqual(read.result.items.map((item) => item.id), ['t0', 't1'])
    assert.deepEqual(read.result.items.map((item) => item.text), ['写文档', '跑测试'])
    assert.equal(read.result.items[1].activeForm, '正在跑测试')
    assert.equal(read.result.total, 2)
    assert.equal('prev' in read.result.items[0], false)

    // 带上读回的 id 整表重写：身份保持（含重排）。
    const rewritten = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [read.result.items[1], { ...read.result.items[0], status: 'completed' }] },
    })
    assert.equal(rewritten.ok, true)
    const after = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.deepEqual(after.result.items.map((item) => item.id), ['t1', 't0'])
    assert.equal(after.result.items[1].status, 'completed')
  } finally {
    drv.close()
  }
})

test('世界不再新增世代：写只落委托存储，服务不产 add_gen / batch 写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const written = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'a' }] },
    })
    const serialized = JSON.stringify(written)
    assert.equal(serialized.includes('add_gen'), false)
    assert.equal(serialized.includes('"op":"batch"'), false)
    assert.equal(written.result.$directives, undefined)
    // 数据落在 todo 命名空间的委托存储里
    const namespace = drv.storage.namespaces.get('todo')
    assert.ok(namespace.has('conv:c1'))
  } finally {
    drv.close()
  }
})

test('空数组 = 清空本会话；其它会话键互不影响', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', { tool: 'todo.write', args: { conversation_id: 'c1', items: [{ text: 'a' }] } })
    await drv.call('invoke', { tool: 'todo.write', args: { conversation_id: 'c2', items: [{ text: 'b' }] } })
    const cleared = await drv.call('invoke', { tool: 'todo.write', args: { conversation_id: 'c1', items: [] } })
    assert.equal(cleared.result.total, 0)
    const readC1 = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    const readC2 = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c2' } })
    assert.deepEqual(readC1.result.items, [])
    assert.deepEqual(readC2.result.items.map((item) => item.text), ['b'])
  } finally {
    drv.close()
  }
})

test('write：多个 in_progress → multiple_in_progress；cancelled 合法但不计完成', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const bad = await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        items: [{ text: 'a', status: 'in_progress' }, { text: 'b', status: 'in_progress' }],
      },
    })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'multiple_in_progress')

    const ok = await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        items: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'cancelled' },
          { text: 'c', status: 'in_progress' },
        ],
      },
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.result.total, 3)
    assert.equal(ok.result.done, 1)
  } finally {
    drv.close()
  }
})

// ── 边跑边追加 ─────────────────────────────────────────────────────────────

test('边跑边追加：写后立即可读；同回合重复写同值幂等', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const args = { conversation_id: 'c1', at: AT, items: [{ id: 't0', text: 'a' }, { id: 't1', text: 'b', status: 'completed' }] }
    await drv.call('invoke', { tool: 'todo.write', args })
    const midTurn = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.equal(midTurn.result.total, 2)
    assert.equal(midTurn.result.done, 1)

    const before = JSON.stringify([...drv.storage.namespaces.get('todo').entries()])
    await drv.call('invoke', { tool: 'todo.write', args })
    const after = JSON.stringify([...drv.storage.namespaces.get('todo').entries()])
    assert.equal(after, before, '同回合重复写同值应幂等')
    assert.equal((await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })).result.total, 2)
  } finally {
    drv.close()
  }
})

test('中断残留可辨：数据批次失败时回合 open 标记留在存储里', async () => {
  const drv = startService({
    fault: (method, args) => {
      // 只让落数据的 batch 失败（open 标记的 batch 放行），模拟中途中断。
      if (method === 'batch' && Array.isArray(args?.ops) && args.ops.some((op) => String(op.key).startsWith('conv:'))) {
        return { code: 'transport_failed', message: 'interrupted' }
      }
      return null
    },
  })
  try {
    await drv.hello()
    const failed = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [{ text: 'a' }] },
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'transport_failed')
    const namespace = drv.storage.namespaces.get('todo')
    const turn = namespace.get('turn:run-1')
    assert.equal(turn.state, 'open', '未闭合回合应可辨')
    assert.equal(namespace.has('conv:c1'), false)
  } finally {
    drv.close()
  }
})

// ── 委托存储清理 ───────────────────────────────────────────────────────────

test('委托存储：dropNamespace 清净本 owner 数据', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.call('invoke', { tool: 'todo.write', args: { conversation_id: 'c1', items: [{ text: 'a' }] } })
    assert.equal(drv.storage.namespaces.get('todo').size > 0, true)
    const dropped = drv.storage.call('todo', 'dropNamespace', {})
    assert.equal(dropped.dropped, true)
    assert.equal(drv.storage.namespaces.has('todo'), false)
    const read = await drv.call('invoke', { tool: 'todo.read', args: { conversation_id: 'c1' } })
    assert.deepEqual(read.result.items, [])
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
    const ok = await drv.call('describe', {})
    assert.equal(ok.tools.length, 1)
  } finally {
    drv.close()
  }
})
