// `throttle` 服务协议级测试：spawn `node execute/main.ts`。
// 覆盖握手 / 控制 / EOF；policy 合并；acquire 令牌与冷却；plan 退避；penalize；结构化拒；无反向调用 / 事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function drive() {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT })
  return {
    ...drv,
    hello: () => drv.hello('throttle'),
    call: (method, args, env = FIXED_ENV) => drv.call('throttle', method, args, env),
  }
}

const POLICY = {
  max_retries: 2,
  backoff_ms: 100,
  backoff_max_ms: 100,
  jitter: false,
  request_timeout_ms: 1000,
  connect_timeout_ms: 1000,
  token_bucket: { capacity: 1, refill_per_sec: 1000 },
  models_dev_url: 'https://example.invalid/api.json',
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'throttle')
    assert.deepEqual(manifest.implements, ['throttle'])
    assert.deepEqual(manifest.methods.throttle, ['acquire', 'plan', 'penalize', 'policy'])
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

test('policy：合并覆盖并补齐缺省', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('policy', { override: { backoff_ms: 7 } })
    assert.equal(result.value.backoff_ms, 7)
    assert.equal(typeof result.value.max_retries, 'number')
    assert.equal(typeof result.value.token_bucket.capacity, 'number')
  } finally {
    drv.close()
  }
})

test('acquire / penalize：冷却期内回剩余毫秒，冷却后回 0', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const first = await drv.call('acquire', { provider: 'p', now: 1000, policy: POLICY })
    assert.equal(first.value.wait_ms, 0, '容量 1 首取可得')
    assert.equal(
      (
        await drv.call('penalize', {
          provider: 'p',
          now: 1000,
          retry_after_ms: 1000,
          policy: POLICY,
        })
      ).value.ok,
      true,
    )
    assert.equal(
      (await drv.call('acquire', { provider: 'p', now: 1000, policy: POLICY })).value.wait_ms,
      1000,
    )
    assert.equal(
      (await drv.call('acquire', { provider: 'p', now: 2000, policy: POLICY })).value.wait_ms,
      0,
    )
  } finally {
    drv.close()
  }
})

test('plan：退避延迟', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('plan', { attempt: 0, policy: POLICY })).value.delay_ms, 100)
    assert.equal(
      (
        await drv.call('plan', {
          attempt: 0,
          retry_after_ms: 500,
          policy: { ...POLICY, backoff_ms: 10, backoff_max_ms: 10000 },
        })
      ).value.delay_ms,
      500,
    )
  } finally {
    drv.close()
  }
})

test('args 非法 / 未知方法 → 结构化 error；无反向调用 / 事件', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('acquire', { now: 1, policy: POLICY })).code, 'bad_args')
    assert.equal((await drv.call('acquire', { provider: 'p', policy: POLICY })).code, 'bad_args')
    assert.equal((await drv.call('plan', { policy: POLICY })).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'throttle', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'policy', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
    assert.equal(drv.portCalls.length, 0)
    assert.equal(drv.events.length, 0)
  } finally {
    drv.close()
  }
})
