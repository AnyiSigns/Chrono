// `router` 服务协议级测试：SDK 驱动 spawn `node execute/main.ts`。
// 覆盖：握手 / 控制 / EOF 自退出 / select 纯判定 / 形态非法 bad_args / 未知方法 / 未知能力类。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'test-run', thread: 't1', now: 0 }

function drive() {
  return startService({ entry: ENTRY, cwd: PKG_ROOT })
}

const call = (drv, args) => drv.call('router', 'select', args, FIXED_ENV)

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello('router')
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'router')
    assert.deepEqual(manifest.implements, ['router'])
    assert.deepEqual(manifest.methods.router, ['select'])
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

test('select 无别名 → 主名；有别名候选 → 别名', async () => {
  const drv = drive()
  try {
    await drv.hello('router')
    const primary = await call(drv, { candidates: ['model', 'model-alt'], failure: 'model_server_error' })
    assert.equal(primary.kind, 'result')
    assert.equal(primary.value, 'model')
    const alias = await call(drv, {
      candidates: ['model', 'model-alt'],
      failure: 'model_server_error',
      aliases: ['model-alt'],
    })
    assert.equal(alias.value, 'model-alt')
  } finally {
    drv.close()
  }
})

test('select 主名不在候选清单 → 结构化 no_candidate', async () => {
  const drv = drive()
  try {
    await drv.hello('router')
    const result = await call(drv, { candidates: ['model-alt'], aliases: [] })
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'no_candidate')
  } finally {
    drv.close()
  }
})

test('select 形态非法 → bad_args（不崩进程，后续调用仍可用）', async () => {
  const drv = drive()
  try {
    await drv.hello('router')
    assert.equal((await call(drv, {})).code, 'bad_args')
    assert.equal((await call(drv, { candidates: 'model' })).code, 'bad_args')
    const ok = await call(drv, { candidates: ['model'] })
    assert.equal(ok.value, 'model')
  } finally {
    drv.close()
  }
})

test('未知方法 / 未知能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello('router')
    assert.equal(
      (await drv.request('call', { port: 'router', method: 'nope', args: {} }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'select', args: {} }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
