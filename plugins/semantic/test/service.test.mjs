// `semantic` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假 model。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function drive({ bridge } = {}) {
  const resolvePort = bridge ?? (() => ({ error: 'not_ready', message: 'no resolver' }))
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      const outcome = resolvePort(message.port, message.method, message.args)
      if (outcome.error)
        return { ok: false, code: outcome.error, message: outcome.message ?? outcome.error }
      return { ok: true, value: outcome.value }
    },
  })
  return {
    ...drv,
    hello: () => drv.hello('semantic'),
    call: (method, args, env = FIXED_ENV) => drv.call('semantic', method, args, env),
    modelCalls: () => drv.portCalls.filter((frame) => frame.port === 'model'),
  }
}

/** 默认 bridge：model.chat 回给定文本。 */
function bridgeWith(text) {
  return (port, method) => {
    if (port === 'model' && method === 'chat') return { value: { ok: true, text } }
    return { error: 'not_ready', message: 'no' }
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'semantic')
    assert.deepEqual(manifest.implements, ['semantic'])
    assert.deepEqual(manifest.methods.semantic, ['summarize'])
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('summarize：经 model.chat（带 config）出记录，原样回', async () => {
  const drv = drive({ bridge: bridgeWith('```json\n{"goal":"M","facts":["f1"]}\n```') })
  try {
    await drv.hello()
    const result = await drv.call('summarize', {
      args: {
        model_config: { base_url: 'https://example.invalid', model: 'm' },
        session_slice: [{ role: 'user', content: 'hi' }],
      },
      existing_l1: { goal: 'prior', facts: ['f'] },
    })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.summary.goal, 'M')
    assert.deepEqual(result.value.summary.facts, ['f1'])
    const chat = drv.modelCalls()[0]
    assert.equal(chat.method, 'chat')
    assert.equal(chat.args.config.base_url, 'https://example.invalid')
    assert.ok(chat.args.messages[0].content.includes('JSON'))
  } finally {
    drv.close()
  }
})

test('summarize：模型失败作数据（回结构化错误、不抛）', async () => {
  const drv = drive({
    bridge: (port, method) => {
      if (port === 'model' && method === 'chat')
        return { error: 'model_server_error', message: 'boom' }
      return { error: 'not_ready', message: 'no' }
    },
  })
  try {
    await drv.hello()
    const result = await drv.call('summarize', { args: { model_config: { base_url: 'x' } } })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.error.code, 'model_server_error')
  } finally {
    drv.close()
  }
})

test('summarize：缺 model_config → model_config_required（不发模型调用）', async () => {
  const drv = drive({ bridge: bridgeWith('{}') })
  try {
    await drv.hello()
    const result = await drv.call('summarize', { args: {} })
    assert.equal(result.value.error.code, 'model_config_required')
    assert.equal(drv.modelCalls().length, 0)
  } finally {
    drv.close()
  }
})

test('形态非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('summarize', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'semantic', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'summarize', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
