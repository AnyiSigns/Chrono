// `ref-hydrate` 服务协议级测试：spawn `node execute/main.ts`，应答反向 `host.def.read`。
// 覆盖：握手；hydrate 逐跳取回 / missing / denied / 传输失败 → def_unavailable；对象短路不外呼；
// args 缺 identity / 上限非法 → bad_args；未知方法 / 能力类 → 结构化 error。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }
const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

/** SDK 驱动适配：能力类固定，反向 `host.def.read` 由测试应答。 */
function drive(onPortCall) {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT, onPortCall })
  return {
    ...drv,
    hello: () => drv.hello('ref-hydrate'),
    call: (method, args, env = FIXED_ENV) => drv.call('ref-hydrate', method, args, env),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'ref-hydrate')
    assert.deepEqual(manifest.implements, ['ref-hydrate'])
    assert.deepEqual(manifest.methods['ref-hydrate'], ['hydrate'])
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

test('hydrate：逐跳取回完整闭包（含 body 内 {def} 展开）', async () => {
  const entry = { id: 'm1', prev: { def: H2 } }
  const drv = drive((message) => ({
    ok: true,
    value: {
      defs: Object.fromEntries(
        message.args.hashes.map((hash) => [hash, hash === H1 ? entry : { id: 'm2' }]),
      ),
    },
  }))
  try {
    await drv.hello()
    const result = await drv.call('hydrate', { identity: 'session', refs: [H1] })
    assert.equal(result.kind, 'result')
    assert.deepEqual(result.value, { [H1]: entry, [H2]: { id: 'm2' } })
    assert.equal(drv.portCalls.length, 2, '逐跳各一批 def.read')
    assert.equal(drv.portCalls[0].port, 'host')
    assert.equal(drv.portCalls[0].method, 'def.read')
    assert.equal(drv.portCalls[0].args.identity, 'session')
  } finally {
    drv.close()
  }
})

test('hydrate：refs 已是对象 ⇒ 原样返回且不外呼', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const closure = { [H1]: { id: 'inline' } }
    const result = await drv.call('hydrate', { identity: 'session', refs: closure })
    assert.deepEqual(result.value, closure)
    assert.equal(drv.portCalls.length, 0)
  } finally {
    drv.close()
  }
})

test('hydrate：missing / denied / 传输失败 → 结构化 def_unavailable（非 internal）', async () => {
  const missing = drive(() => ({ ok: true, value: { defs: {}, missing: [H1], denied: [] } }))
  try {
    await missing.hello()
    const result = await missing.call('hydrate', { identity: 'session', refs: [H1] })
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'def_unavailable')
  } finally {
    missing.close()
  }

  const denied = drive(() => ({ ok: true, value: { defs: {}, missing: [], denied: [H1] } }))
  try {
    await denied.hello()
    assert.equal(
      (await denied.call('hydrate', { identity: 'session', refs: [H1] })).code,
      'def_unavailable',
    )
  } finally {
    denied.close()
  }

  const failed = drive(() => ({ ok: false, code: 'denied', message: 'denied' }))
  try {
    await failed.hello()
    assert.equal(
      (await failed.call('hydrate', { identity: 'session', refs: [H1] })).code,
      'def_unavailable',
    )
  } finally {
    failed.close()
  }
})

test('args 缺 identity / limits 非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('hydrate', { refs: [H1] })).code, 'bad_args')
    assert.equal(
      (await drv.call('hydrate', { identity: 'x', refs: [H1], limits: 3 })).code,
      'bad_args',
    )
    assert.equal(
      (await drv.call('hydrate', { identity: 'x', refs: [H1], limits: { max_hops: 0 } })).code,
      'bad_args',
    )
    assert.equal((await drv.call('hydrate', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'ref-hydrate', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'hydrate', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
