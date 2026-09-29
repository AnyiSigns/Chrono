// throttle 原语测试：令牌桶 / 冷却 / ③ 目录持久化与原子写；退避决策。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RateLimiter, planDelay, rateLimitFile, resolvePolicy } from '../execute/throttle.ts'

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

test('acquire：429 冷却期内回剩余冷却毫秒，不越过冷却', () => {
  const limiter = new RateLimiter(null)
  limiter.penalize('p', 0, 1000, POLICY)
  assert.equal(limiter.acquire('p', 0, POLICY), 1000)
  assert.equal(limiter.acquire('p', 400, POLICY), 600)
  assert.equal(limiter.acquire('p', 1000, POLICY), 0)
})

test('planDelay：指数退避截断到上限，Retry-After 取下限', () => {
  assert.equal(planDelay(0, POLICY), 100)
  assert.equal(planDelay(2, POLICY), 100, '截断到 backoff_max_ms')
  assert.equal(
    planDelay(0, { ...POLICY, backoff_ms: 10, backoff_max_ms: 10000 }, 500),
    500,
    'Retry-After 作下限',
  )
})

test('planDelay：jitter 开启时落在 [0.5,1] 倍基数内', () => {
  for (let i = 0; i < 20; i += 1) {
    const delay = planDelay(0, { ...POLICY, jitter: true, backoff_ms: 100, backoff_max_ms: 10000 })
    assert.ok(delay >= 50 && delay <= 100, `抖动值 ${delay} 应在 [50,100]`)
  }
})

test('resolvePolicy：调用方覆盖优先，缺省回落 schema', () => {
  const policy = resolvePolicy({ backoff_ms: 7 })
  assert.equal(policy.backoff_ms, 7)
  assert.equal(typeof policy.max_retries, 'number')
  assert.equal(typeof policy.token_bucket.capacity, 'number')
})

test('rateLimitFile：CHRONO_PLUGIN_STATE 非空时落 ③ 目录并持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-state-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    const file = rateLimitFile()
    assert.equal(file, join(dir, 'rate-limit.json'))
    const limiter = new RateLimiter(file)
    limiter.acquire('provider-x', 1000, POLICY)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof saved['provider-x'].tokens, 'number')
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rateLimitFile：CHRONO_PLUGIN_STATE 缺省 / 空串 → null（纯内存）', () => {
  const previous = process.env.CHRONO_PLUGIN_STATE
  delete process.env.CHRONO_PLUGIN_STATE
  try {
    assert.equal(rateLimitFile(), null)
    process.env.CHRONO_PLUGIN_STATE = ''
    assert.equal(rateLimitFile(), null)
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
  }
})

test('rateLimitFile：写入为原子替换，不留临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'th-atomic-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    const file = rateLimitFile()
    const limiter = new RateLimiter(file)
    limiter.acquire('provider-y', 1000, POLICY)
    const entries = readdirSync(dir)
    assert.deepEqual(entries, ['rate-limit.json'])
    assert.equal(typeof JSON.parse(readFileSync(file, 'utf8'))['provider-y'].tokens, 'number')
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
