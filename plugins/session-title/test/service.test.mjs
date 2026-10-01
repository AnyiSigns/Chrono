// `session-title` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假后端。
// 覆盖：握手 / 控制 / EOF 自退出；正常生成经 `model.complete` + 本地标题后处理；
// 模型的空 / 错误 / 未配置路径；args 缺字段结构化拒；回标题值且不写世界（无 session 反向调用）；非流式（不发 model.delta）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 一次 generate 的常用入参。 */
function generateArgs(overrides = {}) {
  return {
    conversation: 'c-1',
    first_message: '帮我写一个快速排序',
    vendor: 'vendor-openai',
    model: 'gpt-4o-mini',
    params: { temperature: 0.3 },
    ...overrides,
  }
}

/** SDK 驱动适配：能力类固定，反向调用桥接同步应答。 */
function drive({ bridge } = {}) {
  const resolvePort = bridge ?? (() => ({ error: 'not_ready', message: 'no resolver' }))
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      const outcome = resolvePort(message.port, message.method, message.args)
      if (outcome.error)
        return {
          ok: false,
          code: outcome.error,
          message: outcome.message ?? outcome.error,
        }
      return { ok: true, value: outcome.value }
    },
  })
  return {
    ...drv,
    hello: () => drv.hello('session-title'),
    call: (method, args, env = FIXED_ENV) => drv.call('session-title', method, args, env),
    modelCalls: () => drv.portCalls.filter((frame) => frame.port === 'model'),
  }
}

const OK = (text) => ({ value: { ok: true, text } })

/** 默认 bridge：model.complete 回给定文本；标题后处理住本插件、无第二个反向调用。 */
function bridge({ modelText = '"快速排序算法。"' } = {}) {
  return (port, method) => {
    if (port === 'model' && method === 'complete') return OK(modelText)
    return { error: 'not_ready', message: 'no' }
  }
}

/** 断言本次 generate 没有任何 session 反向调用（标题落盘归调用方）。 */
function assertNoSessionCall(drv) {
  assert.equal(
    drv.portCalls.some((frame) => frame.port === 'session'),
    false,
    'session-title 不应再调 session（标题落盘归 chat）',
  )
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
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

test('正常生成：非流式调 model.complete，本地清理模型输出，回标题值', async () => {
  const drv = drive({ bridge: bridge() })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs())
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, true)
    assert.equal(result.value.title, '快速排序算法')
    assert.equal(result.value.$directives, undefined, '不产世界写计划')
    // 非流式：调 complete、不发 model.delta 事件
    const model = drv.modelCalls()[0]
    assert.equal(model.method, 'complete')
    assert.equal(model.args.max_tokens, 64)
    assert.equal(model.args.messages[0].role, 'system')
    assert.equal(model.args.messages[1].content, '帮我写一个快速排序')
    assert.equal(drv.events.length, 0)
    assert.equal(drv.portCalls.length, 1, '除模型外无其它反向调用')
    assertNoSessionCall(drv)
  } finally {
    drv.close()
  }
})

test('后处理本地化：args.max_chars 覆盖后按次截断', async () => {
  const drv = drive({ bridge: bridge() })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs({ max_chars: 3 }))
    assert.equal(result.value.title, '快速排')
  } finally {
    drv.close()
  }
})

test('模型返回空白 → 回落首条用户消息前 N 字', async () => {
  const drv = drive({ bridge: bridge({ modelText: '   ' }) })
  try {
    await drv.hello()
    const result = await drv.call(
      'generate',
      generateArgs({ first_message: '  帮我写一个快速排序算法  ' }),
    )
    assert.equal(result.kind, 'result')
    assert.equal(result.value.title, '帮我写一个快速排序算')
  } finally {
    drv.close()
  }
})

test('模型错误（port.error）→ 回落首条消息，且不抛', async () => {
  const drv = drive({
    bridge: (port, method) => {
      if (port === 'model' && method === 'complete')
        return { error: 'model_server_error', message: 'boom' }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('generate', generateArgs({ first_message: '写一个快速排序算法' }))
    assert.equal(result.kind, 'result')
    assert.equal(result.value.title, '写一个快速排序算法')
  } finally {
    drv.close()
  }
})

test('模型空且首条消息全空白 → 保留缺省标题', async () => {
  const drv = drive({ bridge: bridge({ modelText: '' }) })
  try {
    await drv.hello()
    const result = await drv.call(
      'generate',
      generateArgs({ first_message: '   ', title_default: '我的标题' }),
    )
    assert.equal(result.value.title, '我的标题')
  } finally {
    drv.close()
  }
})

test('未配置模型（无 vendor/model/params）→ 不发模型调用，走首条消息兜底', async () => {
  const drv = drive({ bridge: bridge() })
  try {
    await drv.hello()
    const result = await drv.call('generate', {
      conversation: 'c-1',
      first_message: '写一个快速排序算法',
    })
    assert.equal(result.kind, 'result')
    assert.equal(drv.modelCalls().length, 0)
    assert.equal(result.value.title, '写一个快速排序算法')
  } finally {
    drv.close()
  }
})

test('args 缺字段 → 结构化 bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive({ bridge: bridge() })
  try {
    await drv.hello()
    assert.equal((await drv.call('generate', {})).code, 'bad_args')
    assert.equal((await drv.call('generate', { conversation: 'c-1' })).code, 'bad_args')
    assert.equal((await drv.call('generate', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'session-title', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'generate', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
