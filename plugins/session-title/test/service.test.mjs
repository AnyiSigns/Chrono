// `session-title` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；正常生成 + 码点截断 + 引号标点清理；模型空 / 错误 / 超时兜底；
// 缺省标题最终兜底；args 缺字段结构化拒；会话写计划原样上提；非流式（不发 model.delta）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIXED_ENV, SET_TITLE_PLAN, directivesOf, externOf, generateArgs, startService } from './driver.mjs'

const OK = (text) => ({ value: { ok: true, text } })
const SET_TITLE_OK = { value: SET_TITLE_PLAN }

/** 默认 bridge：model.complete 回给定文本，session.set_title 回写计划夹具。 */
function bridgeWith(text) {
  return (port, method) => {
    if (port === 'model' && method === 'complete') return OK(text)
    if (port === 'session' && method === 'set_title') return SET_TITLE_OK
    return { error: 'not_ready', message: 'no' }
  }
}

function titleArg(drv) {
  const call = drv.portCalls.find((frame) => frame.port === 'session' && frame.method === 'set_title')
  assert.ok(call !== undefined, '应经反向 port.call 调 session.set_title')
  return call.args
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'session-title')
    assert.deepEqual(manifest.implements, ['session-title'])
    assert.deepEqual(manifest.methods['session-title'], ['generate'])
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

test('正常生成：非流式调 model.complete，清理引号标点并按码点截断 ≤10，写计划原样上提', async () => {
  const drv = startService({ bridge: bridgeWith('"快速排序算法。"') })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs())
    assert.equal(result.kind, 'result')
    // 写计划 = 会话服务的写计划，原样上提
    assert.deepEqual(directivesOf(result.value), SET_TITLE_PLAN.$directives)
    // 非流式：调 complete、不发 model.delta 事件
    const model = drv.portCalls.find((frame) => frame.port === 'model')
    assert.equal(model.method, 'complete')
    assert.equal(model.args.max_tokens, 64)
    assert.equal(model.args.messages[0].role, 'system')
    assert.equal(model.args.messages[1].content, '帮我写一个快速排序')
    assert.equal(drv.events.length, 0)
    // 清理 + 码点截断
    const title = titleArg(drv).title
    assert.equal(title, '快速排序算法')
    assert.ok(Array.from(title).length <= 10)
  } finally {
    drv.close()
  }
})

test('正常生成：CJK 超长标题按码点硬截断到 10', async () => {
  const drv = startService({ bridge: bridgeWith('这是一个非常长的人工智能生成标题需要截断') })
  try {
    await drv.hello()
    await drv.call('generate', generateArgs())
    const title = titleArg(drv).title
    assert.equal(Array.from(title).length, 10)
    assert.equal(title, '这是一个非常长的人工')
  } finally {
    drv.close()
  }
})

test('模型返回空 → 首条消息去空白前 10 字兜底', async () => {
  const drv = startService({ bridge: bridgeWith('   ') })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs({ first_message: '  帮我写一个快速排序算法  ' }))
    assert.equal(result.kind, 'result')
    assert.equal(titleArg(drv).title, '帮我写一个快速排序算')
  } finally {
    drv.close()
  }
})

test('模型错误（port.error）→ 兜底且不抛', async () => {
  const drv = startService({
    bridge: (port, method) => {
      if (port === 'model' && method === 'complete') return { error: 'model_server_error', message: 'boom' }
      if (port === 'session' && method === 'set_title') return SET_TITLE_OK
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs({ first_message: '写一个快速排序算法' }))
    assert.equal(result.kind, 'result')
    assert.equal(titleArg(drv).title, '写一个快速排序算法')
  } finally {
    drv.close()
  }
})

test('模型超时 → 兜底且不阻塞（按 args.timeout_ms 提前收口）', async () => {
  const drv = startService({
    bridge: (port, method) => {
      if (port === 'model' && method === 'complete') return new Promise(() => {})
      if (port === 'session' && method === 'set_title') return SET_TITLE_OK
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs({ first_message: '超时兜底测试', timeout_ms: 60 }))
    assert.equal(result.kind, 'result')
    assert.equal(titleArg(drv).title, '超时兜底测试')
  } finally {
    drv.close()
  }
})

test('模型空且首条消息全空白 → 保留 title_default', async () => {
  const drv = startService({ bridge: bridgeWith('') })
  try {
    await drv.hello()
    await drv.call('generate', generateArgs({ first_message: '   ', title_default: '我的标题' }))
    assert.equal(titleArg(drv).title, '我的标题')
  } finally {
    drv.close()
  }
})

test('未配置模型（无 vendor/model/params）→ 不发模型调用，直接兜底', async () => {
  const drv = startService({ bridge: bridgeWith('模型标题') })
  try {
    await drv.hello()
    const result = await drv.call('generate', { conversation: 'c-1', first_message: '写一个快速排序算法' })
    assert.equal(result.kind, 'result')
    assert.equal(drv.portCalls.some((frame) => frame.port === 'model'), false)
    assert.equal(titleArg(drv).title, '写一个快速排序算法')
  } finally {
    drv.close()
  }
})

test('会话调用失败（未返回计划）→ extern 失败值，不抛', async () => {
  const drv = startService({
    bridge: (port, method) => {
      if (port === 'model' && method === 'complete') return OK('标题')
      if (port === 'session' && method === 'set_title') return { value: { ok: false } }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs())
    assert.equal(result.kind, 'result')
    assert.deepEqual(directivesOf(result.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(result.value).ok, false)
    assert.equal(externOf(result.value).error.code, 'set_title_failed')
  } finally {
    drv.close()
  }
})

test('args 缺字段 → 结构化 bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = startService({ bridge: bridgeWith('标题') })
  try {
    await drv.hello()
    assert.equal((await drv.call('generate', {})).code, 'bad_args')
    assert.equal((await drv.call('generate', { conversation: 'c-1' })).code, 'bad_args')
    assert.equal((await drv.call('generate', null)).code, 'bad_args')
    assert.equal(
      (await drv.request('call', { port: 'session-title', method: 'nope', args: {}, env: FIXED_ENV }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'generate', args: {}, env: FIXED_ENV }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
