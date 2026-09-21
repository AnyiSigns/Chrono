// 韧性原语测试：withRetry 的令牌 / 冷却重取与抖动；令牌桶 ③ 目录持久化路径。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RateLimiter, rateLimitFile, withRetry } from '../execute/resilience.ts'
import { ModelError } from '../execute/errors.ts'

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

test('withRetry：等待被 backoff_max_ms 截断后重新取令牌，不越过 429 冷却', async () => {
  const limiter = new RateLimiter(null)
  limiter.penalize('p', 0, 1000, POLICY)
  const waits = []
  const result = await withRetry('p', async () => 'ok', {
    policy: POLICY,
    limiter,
    now: 0,
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  assert.equal(result, 'ok')
  assert.equal(waits.length, 10, '1000ms 冷却按 100ms 上限逐段等待')
  assert.equal(
    waits.reduce((sum, ms) => sum + ms, 0),
    1000,
  )
})

test('withRetry：jitter 开启时退避落在 [0.5,1] 倍基数内', async () => {
  const limiter = new RateLimiter(null)
  const waits = []
  let calls = 0
  const policy = { ...POLICY, jitter: true, backoff_ms: 100, backoff_max_ms: 10000, token_bucket: { capacity: 100, refill_per_sec: 1000 } }
  await withRetry(
    'p',
    async () => {
      calls += 1
      if (calls === 1) throw new ModelError('model_server_error', 'boom', { retryable: true })
      return 'ok'
    },
    {
      policy,
      limiter,
      now: 0,
      sleep: async (ms) => {
        waits.push(ms)
      },
    },
  )
  assert.equal(calls, 2)
  const jittered = waits[waits.length - 1]
  assert.ok(jittered >= 50 && jittered <= 100, `抖动值 ${jittered} 应在 [50,100]`)
})

test('rateLimitFile：CHRONO_PLUGIN_STATE 非空时落 ③ 目录并持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-state-'))
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
