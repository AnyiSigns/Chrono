// `todo` 服务协议级测试（node --test）：握手 / 控制 / 自退出 + describe + todo.write 计划形状。
// 断言只针对「返回的计划」——服务不落账；落账由测试内联的最小批处理应用（driver.runBatch）单独验证（见「可回放」用例）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AT, EMPTY_HEAD, EMPTY_WORLD, H, externOf, opsOf, runBatch, startService } from './driver.mjs'

/** 最小补丁组装（测试内联，避免引用内核包）：replace / delete 两种 op。 */
function applyOps(base, ops) {
  const doc = structuredClone(base)
  for (const op of ops) {
    let node = doc
    for (let i = 0; i < op.path.length - 1; i++) node = node[op.path[i]]
    const last = op.path[op.path.length - 1]
    if (op.op === 'delete') {
      if (Array.isArray(node)) node.splice(last, 1)
      else delete node[last]
    } else {
      node[last] = structuredClone(op.value)
    }
  }
  return doc
}
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
    assert.equal(manifest.state, 'recomputable')
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

test('describe：两工具 + 四要素 + argsSchema + caps（无 fs / 无 net）+ render', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.call('describe', {})
    const tools = value.tools
    assert.deepEqual(tools.map((tool) => tool.name), ['todo.write', 'todo.read'])
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
      assert.equal(tool.render.tone, 'plain')
      assert.deepEqual(tool.render.detail, { kind: 'list', fields: ['text', 'status'] })
    }
    const write = tools.find((tool) => tool.name === 'todo.write')
    const read = tools.find((tool) => tool.name === 'todo.read')
    assert.equal(write.idempotent, false)
    assert.equal(read.idempotent, true)
    // todo.read = 能力类工具绑定、method 缺省 = 投影读
    assert.deepEqual(read.binding, { class: 'todo', method: null })
  } finally {
    drv.close()
  }
})

// ── todo.write 计划形状 ─────────────────────────────────────────────────────

test('write：条目各自成 def + prev 串链 + 本会话键新 body + add_gen（旧 def 不进新链）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('invoke', {
      tool: 'todo.write',
      args: {
        conversation_id: 'c1',
        at: AT,
        items: [{ text: '写文档' }, { text: '跑测试', status: 'in_progress', priority: 1 }],
      },
      todo: { body: { conversations: { c2: { items: { tail: null, count: 0 } } } } },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const plan = result.result
    const ops = opsOf(plan)
    assert.equal(ops.length, 4)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'put', 'put', 'add_gen'])

    const first = ops[0].args.body
    assert.equal(first.id, 'c1-0')
    assert.equal(first.text, '写文档')
    assert.equal(first.status, 'pending')
    assert.equal(first.at, AT)
    assert.equal(first.prev, null)
    const second = ops[1].args.body
    assert.equal(second.id, 'c1-1')
    assert.equal(second.status, 'in_progress')
    assert.equal(second.priority, 1)
    assert.deepEqual(second.prev, { def: { $n: 0 } })

    const body = ops[2].args.body
    assert.deepEqual(body.conversations.c1.items, { tail: { def: { $n: 1 } }, count: 2 })
    // 其它会话键原样保留
    assert.deepEqual(body.conversations.c2, { items: { tail: null, count: 0 } })

    const addGen = ops[3]
    assert.equal(addGen.args.id, 'todo')
    assert.deepEqual(addGen.args.payload, { $n: 2 })
    assert.deepEqual(addGen.args.sig, { $n: 2 })
    assert.deepEqual(addGen.args.pins, {})

    const payload = externOf(plan)
    assert.equal(payload.total, 2)
    assert.equal(payload.done, 0)
    assert.equal(payload.items.length, 2)
  } finally {
    drv.close()
  }
})

test('补丁世代：有 data_gen 时写补丁 + base，组装结果 == 整份写入', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const prevBody = { conversations: { c2: { items: { tail: null, count: 0 } } } }
    const result = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', at: AT, items: [{ text: '写文档' }] },
      todo: { body: prevBody, data_gen: { seq: 4, payload: H('gen-4') } },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const ops = opsOf(result.result)
    assert.equal(ops.length, 3)
    const patchDef = ops[1].args.body
    assert.ok(Array.isArray(patchDef.ops) && patchDef.ops.length > 0)
    const addGen = ops[2]
    assert.equal(addGen.args.id, 'todo')
    assert.equal(addGen.args.base, 4)
    // 补丁组装结果 == 目标整份 body（同内容旧 / 新形态逐字段一致）
    assert.deepEqual(applyOps(prevBody, patchDef.ops), {
      conversations: {
        c2: { items: { tail: null, count: 0 } },
        c1: { items: { tail: { def: { $n: 0 } }, count: 1 } },
      },
    })
  } finally {
    drv.close()
  }
})

test('补丁世代：空改动（本会话已是目标内容）回落整份', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [] },
      todo: {
        body: { conversations: { c1: { items: { tail: null, count: 0 } } } },
        data_gen: { seq: 4, payload: H('gen-4') },
      },
    })
    const ops = opsOf(result.result)
    assert.equal(ops.length, 2)
    assert.equal(ops[1].args.id, 'todo')
    assert.equal(ops[1].args.base, undefined)
    assert.equal(Array.isArray(ops[0].args.body.ops), false)
  } finally {
    drv.close()
  }
})

test('write：空数组 = 清空本会话（tail null / count 0），其它会话键不动', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', items: [] },
      todo: {
        body: {
          conversations: {
            c1: { items: { tail: { def: 'a'.repeat(64) }, count: 3 } },
            c2: { items: { tail: null, count: 0 } },
          },
        },
      },
    })
    assert.equal(result.ok, true)
    const ops = opsOf(result.result)
    assert.equal(ops.length, 2)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    const body = ops[0].args.body
    assert.deepEqual(body.conversations.c1.items, { tail: null, count: 0 })
    assert.deepEqual(body.conversations.c2, { items: { tail: null, count: 0 } })
    assert.deepEqual(ops[1].args.payload, { $n: 0 })
    assert.equal(externOf(result.result).total, 0)
  } finally {
    drv.close()
  }
})

test('write：落账后旧条目 def 仍留世界 defs、其它会话键保留（可回放）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 旧数据世代：c1 两条 + c2 空
    const oldItem0 = { id: 'old-0', text: 'old zero', status: 'completed', at: AT, prev: null }
    const oldItem1 = { id: 'old-1', text: 'old one', status: 'pending', at: AT, prev: { def: H(oldItem0) } }
    const oldBody = {
      conversations: {
        c1: { items: { tail: { def: H(oldItem1) }, count: 2 } },
        c2: { items: { tail: null, count: 0 } },
      },
    }
    const seed = runBatch(EMPTY_HEAD, structuredClone(EMPTY_WORLD), [
      { op: 'put', args: { body: { type: 'object' } } },
      { op: 'add_identity', args: { id: 'todo', schema: { $n: 0 } } },
      { op: 'put', args: { body: oldItem0 } },
      { op: 'put', args: { body: oldItem1 } },
      { op: 'put', args: { body: oldBody } },
      { op: 'add_gen', args: { id: 'todo', payload: { $n: 4 }, sig: { $n: 4 }, pins: {} } },
    ])
    assert.equal(seed.world.ids.todo.active, H({ body: oldBody }))

    const result = await drv.call('invoke', {
      tool: 'todo.write',
      args: { conversation_id: 'c1', at: AT, items: [{ text: 'new only', status: 'pending' }] },
      todo: { body: oldBody },
    })
    assert.equal(result.ok, true)
    const ops = opsOf(result.result)
    const applied = runBatch(seed.head, seed.world, structuredClone(ops))

    // 旧 def 未被删除：链上仍可寻址（def = {body:<条目/清单>}）
    assert.ok(applied.world.defs[H({ body: oldItem0 })], '旧条目 def 应仍在世界 defs')
    assert.ok(applied.world.defs[H({ body: oldBody })], '旧 body def 应仍在世界 defs')
    // active 指向新 body，c2 键保留、c1 换新链
    assert.equal(applied.world.ids.todo.gens.length, 2)
    const newBody = applied.world.defs[applied.world.ids.todo.active].body
    assert.deepEqual(newBody.conversations.c2, { items: { tail: null, count: 0 } })
    assert.equal(newBody.conversations.c1.items.count, 1)
    // 新链首条 prev = null（整表替换，不接旧链）
    const newItemHash = newBody.conversations.c1.items.tail.def
    const newItem = applied.world.defs[newItemHash].body
    assert.deepEqual(newItem.prev, null)
    assert.equal(newItem.text, 'new only')
  } finally {
    drv.close()
  }
})
