// chat 服务协议级测试：spawn `node execute/main.ts`，桥接 #33 loop-policy.interpret 与 #49 title 假实现。
// 覆盖：握手 / 控制帧 / EOF；空槽 no-op；send 的 interpret bag 键完整性与 $directives 合并；
// title 仅首条触发 + 失败跳过；resume 从 args.ids 装配 + bag.resume 透传 + 续跑计划合并；
// 结构化失败以 extern 收口；chat.history 链还原与切片；服务只收 args（不读投影）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTERPRET_PLAN,
  TITLE_PLAN,
  callArgs,
  defaultBridge,
  directivesOf,
  externOf,
  idsFixture,
  startService,
} from './driver.mjs'

/** §1.14 `chat.send` 行要求的 interpret bag 键。 */
const BAG_KEYS = [
  'input',
  'config',
  'tier',
  'memories',
  'session',
  'graph',
  'persona',
  'skills',
  'workspace_root',
  'evidence',
  'todo',
  'guard_rules',
  'sandbox_tiers',
  'tools_bindings',
  'mcp_tools',
]

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'chat')
    assert.deepEqual(manifest.implements, ['chat'])
    assert.deepEqual(manifest.methods.chat, ['send', 'history', 'resume'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：port.call loop-policy.interpret + 首条 title 段，bag 装配完整', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ agent: 'agent-a' }))
    assert.equal(result.kind, 'result')
    assert.deepEqual(
      drv.portCalls.map((frame) => `${frame.port}.${frame.method}`),
      ['loop-policy.interpret', 'session-title.generate'],
    )

    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    for (const key of BAG_KEYS) assert.ok(Object.hasOwn(bag, key), `interpret bag 缺 ${key}`)

    assert.equal(bag.input.content, '帮我写一个快速排序')
    assert.equal(bag.config.model, 'deepseek-chat')
    assert.equal(bag.config.base_url, 'https://api.deepseek.com')
    assert.equal(bag.tier, 'review')
    assert.equal(bag.memories.l1.summary.goal, '写排序')
    assert.equal(bag.memories.l2.summary.goal, 'w')
    assert.equal(bag.session.head, 'h3')
    assert.equal(bag.session.refs.h3.id, 'm3')
    assert.equal(bag.graph.contracts.tail.def.length, 64)
    assert.equal(bag.graph.graph.def.length, 64)
    assert.equal(bag.graph.refs['a'.repeat(64)].nodes[0], 'context.assemble')
    assert.equal(bag.persona, '你是代码评审员。')
    assert.equal(bag.skills[0].id, 's1')
    assert.equal(bag.workspace_root, 'C:/ws/w-1')
    assert.equal(bag.workspace_id, 'w-1')
    assert.equal(bag.session_id, 'c-1')
    assert.equal(bag.evidence.proposals.count, 0)
    assert.equal(bag.evolution.proposals.count, 0)
    assert.equal(bag.todo.items[0].id, 't1')
    assert.equal(bag.guard_rules.version, 1)
    assert.equal(bag.sandbox_tiers.impl, 'native')
    assert.equal(bag.tools_bindings.bindings['retrieval.search'].class, 'retrieval')
    assert.equal(bag.mcp_tools[0].name, 'mcp.demo.echo')
    assert.equal(bag.thread, 't1')
    assert.equal(bag.thread_kind, 'main')
    assert.equal(bag.style, '简洁')
    assert.equal(bag.input_body.slots.t1.kind, 'chat.message')
    assert.equal(Object.hasOwn(bag, 'resume'), false, 'send 不应带 resume')

    const titleArgs = callArgs(drv.portCalls, 'session-title', 'generate')
    assert.equal(titleArgs.conversation, 'c-1')
    assert.equal(titleArgs.first_message, '帮我写一个快速排序')
    assert.equal(titleArgs.title_default, '新对话')

    // 顶层 $directives = interpret 计划 + title 计划按段序机械合并
    assert.deepEqual(directivesOf(result.value), [...INTERPRET_PLAN.$directives, ...TITLE_PLAN.$directives])
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：缺身份切片时对应 bag 键省略（graceful）', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const ids = idsFixture({ omit: ['guard', 'sandbox', 'tools', 'mcp', 'evolution', 'todo', 'workspace', 'agents', 'skill'] })
    await drv.call('send', ids)
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    for (const key of ['guard_rules', 'sandbox_tiers', 'tools_bindings', 'mcp_tools', 'evidence', 'todo', 'workspace_root', 'persona', 'skills']) {
      assert.equal(Object.hasOwn(bag, key), false, `缺身份时不应落 ${key}`)
    }
    assert.ok(Object.hasOwn(bag, 'graph'), 'graph 仍在（loop-policy 未省略）')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：审批 / 提问队列切片随 bag 传入（入队按当前 tail 追加）', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const ids = idsFixture()
    const queue = { version: 1, tail: { def: 'f'.repeat(64) }, count: 1 }
    const refs = { ['f'.repeat(64)]: { id: 'ap-old', status: 'pending' } }
    ids.approval = { body: queue, refs }
    ids.question = { body: { version: 1, tail: null, count: 0 }, refs: {} }
    await drv.call('send', ids)
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.deepEqual(bag.approval, { queue, refs })
    assert.deepEqual(bag.question, { body: { version: 1, tail: null, count: 0 }, refs: {} })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：非首条（count != 0）不触发 title 段', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ conversation: { count: 4 } }))
    assert.deepEqual(drv.portCalls.map((frame) => `${frame.port}.${frame.method}`), ['loop-policy.interpret'])
    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：已有标题（非缺省）不触发 title 段', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    await drv.call('send', idsFixture({ conversation: { title: '已有标题' } }))
    assert.equal(drv.portCalls.some((frame) => frame.port === 'session-title'), false)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：空槽 / idle / 非 chat kind → 幂等 no-op，不触发任何 eff', async () => {
  for (const slot of [undefined, { kind: 'idle' }, { kind: 'session.new' }]) {
    const drv = startService({ bridge: defaultBridge() })
    try {
      await drv.hello()
      const ids = idsFixture(slot === undefined ? { extraSlots: {} } : { slot })
      if (slot === undefined) delete ids.input.body.slots.t1
      const result = await drv.call('send', ids)
      assert.equal(result.kind, 'result')
      assert.deepEqual(externOf(result.value), { ok: true, noop: true })
      assert.equal(drv.portCalls.length, 0)
    } finally {
      drv.close()
    }
    assert.equal(await drv.exit, 0)
  }
})

test('send：interpret 传输失败 → extern loop_unavailable 收口', async () => {
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'loop-policy'
        ? Promise.resolve({ error: 'unresolved_cap', message: 'no loop-policy' })
        : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(drv.portCalls.map((frame) => `${frame.port}.${frame.method}`), ['loop-policy.interpret'])
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'loop_unavailable', message: 'no loop-policy' },
    })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：interpret 结构化失败值 → extern 原样收口', async () => {
  const drv = startService({
    bridge: defaultBridge({ 'loop-policy.interpret': () => ({ ok: false, error: { code: 'budget', message: 'gas' } }) }),
  })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture())
    assert.deepEqual(externOf(result.value), { ok: false, error: { code: 'budget', message: 'gas' } })
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：title 段失败 / 无计划一律跳过，不影响主回合', async () => {
  for (const titleReply of [
    { error: 'not_ready', message: 'no title service' },
    { value: { ok: false, error: { code: 'set_title_failed', message: 'no plan' } } },
    { value: null },
  ]) {
    const drv = startService({
      bridge: (port, method, args) =>
        port === 'session-title'
          ? Promise.resolve(titleReply)
          : defaultBridge()(port, method, args),
    })
    try {
      await drv.hello()
      const result = await drv.call('send', idsFixture())
      assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
    } finally {
      drv.close()
    }
    assert.equal(await drv.exit, 0)
  }
})

test('send：连接配置缺失 → model_not_configured，不派发 interpret', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', idsFixture({ configBody: { model: 'm', permission: 'review' } }))
    assert.deepEqual(externOf(result.value), {
      ok: false,
      error: { code: 'model_not_configured', message: 'config vendor/model/base_url missing' },
    })
    assert.equal(drv.portCalls.length, 0)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume：从 args.ids 装配 interpret bag + bag.resume 透传 + 计划合并', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const cursor = { kind: 'approval', iter: 1, node_index: 3, executed: [0, 1, 2] }
    const result = await drv.call('resume', {
      cursor,
      thread: 't1',
      payload: { verdict: 'approved' },
      ids: idsFixture({ agent: 'agent-a' }),
    })
    assert.equal(result.kind, 'result')
    assert.deepEqual(drv.portCalls.map((frame) => `${frame.port}.${frame.method}`), ['loop-policy.interpret'])
    const bag = callArgs(drv.portCalls, 'loop-policy', 'interpret')
    assert.deepEqual(bag.resume, { cursor, thread: 't1', payload: { verdict: 'approved' } })
    assert.equal(bag.input.content, '帮我写一个快速排序')
    assert.equal(bag.graph.refs['a'.repeat(64)].nodes[0], 'context.assemble')
    assert.equal(bag.tier, 'review')
    assert.equal(bag.workspace_root, 'C:/ws/w-1')
    assert.deepEqual(directivesOf(result.value), INTERPRET_PLAN.$directives)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('resume：cursor 缺失 → bad_args，不崩进程', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('resume', { thread: 't1' })
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
    const after = await drv.request('probe', {}, 'pong')
    assert.equal(after.ok, true)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('history：链还原（新→旧）+ 缺省 conversation=current + body/refs 全量', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('history', idsFixture())
    assert.equal(result.kind, 'result')
    assert.equal(result.value.conversation, 'c-1')
    assert.equal(result.value.next_before, null)
    assert.deepEqual(result.value.messages.map((entry) => entry.body.id), ['m3', 'm2', 'm1'])
    assert.equal(result.value.body.current, 'c-1')
    assert.equal(result.value.refs.h1.id, 'm1')
    assert.equal(drv.portCalls.length, 0, '读命令不发下游 eff')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('history：limit 截断 / before 更旧窗 / 指定 conversation', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const limited = await drv.call('history', { ...idsFixture(), limit: 2 })
    assert.deepEqual(limited.value.messages.map((entry) => entry.body.id), ['m3', 'm2'])
    const before = await drv.call('history', { ...idsFixture(), before: 'm3' })
    assert.deepEqual(before.value.messages.map((entry) => entry.body.id), ['m2', 'm1'])
    const missing = await drv.call('history', { ...idsFixture(), conversation: 'c-9' })
    assert.equal(missing.value.conversation, 'c-1', '未命中回落 current')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('history：服务只收 args（投影由入口 term 传入），不读世界', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('history', { ids: idsFixture(), conversation: 'c-1', limit: 1 })
    assert.deepEqual(result.value.messages.map((entry) => entry.body.id), ['m3'])
    assert.equal(drv.portCalls.length, 0)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('send：args 非对象 → bad_args 错误帧，不崩进程', async () => {
  const drv = startService({ bridge: defaultBridge() })
  try {
    await drv.hello()
    const result = await drv.call('send', null)
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'bad_args')
    const after = await drv.request('probe', {}, 'pong')
    assert.equal(after.ok, true)
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})
