// `compress` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；summarize（文本与向量去重）；compact 触发 extract；
// extract 全重复与候选不足；semantic 经 model.chat；形态非法 bad_args；未知方法 / 能力类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService, memoryFixture, opsOf, externOf, directivesOf } from './driver.mjs'

const OK_EMBED = (texts) => ({
  value: { model: 'granite-97m', dim: 2, vectors: texts.map((text) => (text === 'alpha' || text === 'alpha!' ? [1, 0] : [0, 1])) },
})

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'compress')
    assert.deepEqual(manifest.implements, ['compress'])
    assert.deepEqual(manifest.methods.compress, ['summarize', 'compact', 'extract'])
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

test('summarize（algorithmic，去重回落文本）：写计划 put + add_gen，保留其他会话', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const memory = memoryFixture()
    const result = await drv.call('summarize', {
      memory,
      conversation: 'c-1',
      covered_upto: 'msg-9',
      goal: 'G',
      facts: ['f1', 'f2'],
    })
    assert.equal(result.kind, 'result')
    const ops = opsOf(result.value)
    assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(ops[1].args.id, 'short-memory')
    const body = ops[0].args.body
    assert.equal(body.sessions['c-1'].summary.goal, 'G')
    assert.equal(body.sessions['c-1'].covered_upto, 'msg-9')
    assert.deepEqual(body.sessions['c-keep'], memory.sessions['c-keep'])
    assert.deepEqual(body.workspaces, memory.workspaces)
    assert.equal(externOf(result.value).dedup, 'text')
    // 反向调用 embedding.embed 已发出但假后端未就绪 → 回落文本去重
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
  } finally {
    drv.close()
  }
})

test('summarize 向量去重：近似重复被丢弃', async () => {
  const drv = startService({ resolvePort: (port, method, args) => (method === 'embed' ? OK_EMBED(args.texts) : { error: 'not_ready', message: 'no' }) })
  try {
    await drv.hello()
    const memory = memoryFixture()
    memory.sessions['c-1'] = {
      summary: { goal: '', decisions: [], facts: ['alpha'], open_questions: [], files: [], next_steps: [] },
      covered_upto: 'msg-1',
      at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-01-02T00:00:00.000Z',
    }
    const result = await drv.call('summarize', { memory, conversation: 'c-1', facts: ['alpha!', 'beta'] })
    const body = opsOf(result.value)[0].args.body
    assert.deepEqual(body.sessions['c-1'].summary.facts, ['alpha', 'beta'])
    assert.equal(externOf(result.value).dedup, 'vector')
  } finally {
    drv.close()
  }
})

test('compact：写 L1 并触发 extract 写 L2（2–3 条）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('compact', {
      memory: memoryFixture(),
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    })
    const body = opsOf(result.value)[0].args.body
    assert.equal(body.sessions['c-1'].summary.goal, 'G')
    const items = body.workspaces['w-1'].summary.facts
    assert.ok(items.length >= 2 && items.length <= 3, `items=${items.length}`)
    assert.equal(externOf(result.value).kind, 'compact')
  } finally {
    drv.close()
  }
})

test('extract：候选全为已有条目 → 只回 extern', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const memory = memoryFixture()
    memory.workspaces['w-1'] = {
      summary: { goal: '', decisions: [], facts: ['dup', 'dup2'], open_questions: [], files: [] },
      sources: [],
      at: '2020-01-01T00:00:00.000Z',
    }
    const result = await drv.call('extract', { memory, workspace: 'w-1', summary: { facts: ['dup', 'dup2'] } })
    assert.deepEqual(directivesOf(result.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(result.value).reason, 'all_duplicate')
  } finally {
    drv.close()
  }
})

test('extract：候选不足 2 条 → insufficient_content（无写计划）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('extract', { memory: memoryFixture(), workspace: 'w-1', summary: { facts: [] } })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'insufficient_content')
  } finally {
    drv.close()
  }
})

test('semantic：经反向调用 model.chat 出摘要', async () => {
  const drv = startService({
    bridge: async (port, method) => {
      if (port === 'model' && method === 'chat') {
        return { value: { ok: true, text: JSON.stringify({ goal: 'M', facts: ['mf1', 'mf2'] }) } }
      }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      memory: memoryFixture(),
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'https://example.invalid', model: 'm', quirks: { impl: 'protocol', protocol: 'openai-chat' } },
      session_slice: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(externOf(result.value).summary.goal, 'M')
    const chat = drv.portCalls.find((call) => call.port === 'model' && call.method === 'chat')
    assert.ok(chat !== undefined, '应经反向 port.call 调 model.chat')
    assert.equal(chat.args.config.base_url, 'https://example.invalid')
  } finally {
    drv.close()
  }
})

test('semantic：模型失败作数据（回结构化错误，无写计划）', async () => {
  const drv = startService({
    bridge: async (port, method) => {
      if (port === 'model' && method === 'chat') return { error: 'model_server_error', message: 'boom' }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      memory: memoryFixture(),
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'x' },
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_server_error')
    assert.equal(result.value.$directives, undefined)
  } finally {
    drv.close()
  }
})

test('形态非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call('summarize', { conversation: 'c-1' })).code, 'bad_args')
    assert.equal((await drv.call('summarize', { memory: memoryFixture(), conversation: 'c-1', mode: 'nope' })).code, 'bad_args')
    assert.equal(
      (await drv.request('call', { port: 'compress', method: 'nope', args: {} }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'summarize', args: {} }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
