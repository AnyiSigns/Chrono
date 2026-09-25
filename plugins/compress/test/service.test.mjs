// `compress` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；summarize / compact / extract 写 short-memory（不产世界写计划）；
// 文本与向量去重；semantic 经 model.chat；persist:false 只算不写；形态非法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryFixture, startService } from './driver.mjs'

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

test('summarize：写 L1 到 short-memory，保留其他会话 / 工作区；不产世界写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      conversation: 'c-1',
      covered_upto: 'msg-9',
      goal: 'G',
      facts: ['f1', 'f2'],
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.$directives, undefined, '运行记录不得产世界写计划')
    assert.equal(result.value.dedup, 'text')
    const memory = drv.shortMemory.memory
    assert.equal(memory.sessions['c-1'].summary.goal, 'G')
    assert.equal(memory.sessions['c-1'].covered_upto, 'msg-9')
    assert.deepEqual(memory.sessions['c-keep'], memoryFixture().sessions['c-keep'])
    assert.deepEqual(memory.workspaces, memoryFixture().workspaces)
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
    assert.ok(drv.portCalls.some((call) => call.port === 'short-memory' && call.method === 'apply'))
  } finally {
    drv.close()
  }
})

test('summarize 向量去重：近似重复被丢弃', async () => {
  const drv = startService({ resolvePort: (port, method, args) => (method === 'embed' ? OK_EMBED(args.texts) : { error: 'not_ready', message: 'no' }) })
  try {
    await drv.hello()
    drv.shortMemory.memory.sessions['c-1'] = {
      summary: { goal: '', decisions: [], facts: ['alpha'], open_questions: [], files: [], next_steps: [] },
      covered_upto: 'msg-1',
      at: '2020-01-01T00:00:00.000Z',
      expires_at: '2020-01-02T00:00:00.000Z',
    }
    const result = await drv.call('summarize', { conversation: 'c-1', facts: ['alpha!', 'beta'] })
    assert.deepEqual(drv.shortMemory.memory.sessions['c-1'].summary.facts, ['alpha', 'beta'])
    assert.equal(result.value.dedup, 'vector')
  } finally {
    drv.close()
  }
})

test('compact：写 L1 并触发 extract 写 L2（2–3 条）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('compact', {
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    })
    const memory = drv.shortMemory.memory
    assert.equal(memory.sessions['c-1'].summary.goal, 'G')
    const items = memory.workspaces['w-1'].summary.facts
    assert.ok(items.length >= 2 && items.length <= 3, `items=${items.length}`)
    assert.equal(result.value.kind, 'compact')
    assert.deepEqual(memory.workspaces['w-keep'], memoryFixture().workspaces['w-keep'])
  } finally {
    drv.close()
  }
})

test('extract：候选全为已有条目 → all_duplicate，不写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    drv.shortMemory.memory.workspaces['w-1'] = {
      summary: { goal: '', decisions: [], facts: ['dup', 'dup2'], open_questions: [], files: [] },
      sources: [],
      at: '2020-01-01T00:00:00.000Z',
    }
    const before = JSON.stringify(drv.shortMemory.memory.workspaces['w-1'])
    const result = await drv.call('extract', { workspace: 'w-1', summary: { facts: ['dup', 'dup2'] } })
    assert.equal(result.value.reason, 'all_duplicate')
    assert.equal(JSON.stringify(drv.shortMemory.memory.workspaces['w-1']), before)
  } finally {
    drv.close()
  }
})

test('extract：候选不足 2 条 → insufficient_content', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const result = await drv.call('extract', { workspace: 'w-1', summary: { facts: [] } })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'insufficient_content')
  } finally {
    drv.close()
  }
})

test('persist:false 只算不写（供 memory-consolidate 纯计算摘要）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = JSON.stringify(drv.shortMemory.memory)
    const result = await drv.call('summarize', { conversation: 'c-1', goal: 'G', facts: ['f'], persist: false })
    assert.equal(result.value.summary.goal, 'G')
    assert.equal(JSON.stringify(drv.shortMemory.memory), before)
    assert.equal(drv.portCalls.some((call) => call.port === 'short-memory' && call.method === 'apply'), false)
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
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'https://example.invalid', model: 'm', quirks: { impl: 'protocol', protocol: 'openai-chat' } },
      session_slice: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(result.value.summary.goal, 'M')
    const chat = drv.portCalls.find((call) => call.port === 'model' && call.method === 'chat')
    assert.ok(chat !== undefined, '应经反向 port.call 调 model.chat')
    assert.equal(chat.args.config.base_url, 'https://example.invalid')
  } finally {
    drv.close()
  }
})

test('semantic：模型失败作数据（回结构化错误，不写）', async () => {
  const drv = startService({
    bridge: async (port, method) => {
      if (port === 'model' && method === 'chat') return { error: 'model_server_error', message: 'boom' }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'x' },
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_server_error')
    assert.equal(drv.portCalls.some((call) => call.port === 'short-memory' && call.method === 'apply'), false)
  } finally {
    drv.close()
  }
})

test('形态非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call('summarize', {})).code, 'bad_args')
    assert.equal((await drv.call('summarize', { conversation: 'c-1', mode: 'nope' })).code, 'bad_args')
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
