// `dedup` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假 embedding。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

const OK_EMBED = (texts) => ({
  value: {
    model: 'granite-97m',
    dim: 2,
    vectors: texts.map((text) => (text === 'alpha' || text === 'alpha!' ? [1, 0] : [0, 1])),
  },
})

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
    hello: () => drv.hello('dedup'),
    call: (method, args, env = FIXED_ENV) => drv.call('dedup', method, args, env),
    embedCalls: () => drv.portCalls.filter((frame) => frame.port === 'embedding'),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'dedup')
    assert.deepEqual(manifest.implements, ['dedup'])
    assert.deepEqual(manifest.methods.dedup, ['dedup'])
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('dedup：向量去重丢弃近似项，dedup=vector', async () => {
  const drv = drive({
    bridge: (port, method, args) =>
      method === 'embed' ? OK_EMBED(args.texts) : { error: 'not_ready', message: 'no' },
  })
  try {
    await drv.hello()
    const result = await drv.call('dedup', {
      incoming: ['alpha!', 'beta'],
      reference: ['alpha'],
      model: 'granite-97m',
      threshold: 0.9,
    })
    assert.deepEqual(result.value.accepted, ['beta'])
    assert.equal(result.value.dedup, 'vector')
    assert.ok(drv.embedCalls().length > 0)
  } finally {
    drv.close()
  }
})

test('dedup：无向量后端 → 回落精确文本去重，dedup=text', async () => {
  const drv = drive({ bridge: () => ({ error: 'embedding_unavailable', message: 'down' }) })
  try {
    await drv.hello()
    const result = await drv.call('dedup', { incoming: ['a', 'a', 'b'], reference: ['a'] })
    assert.deepEqual(result.value.accepted, ['b'])
    assert.equal(result.value.dedup, 'text')
  } finally {
    drv.close()
  }
})

test('形态非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('dedup', { incoming: 'x', reference: [] })).code, 'bad_args')
    assert.equal(
      (await drv.call('dedup', { incoming: [], reference: [], threshold: 2 })).code,
      'bad_args',
    )
    assert.equal((await drv.call('dedup', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'dedup', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'dedup', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
