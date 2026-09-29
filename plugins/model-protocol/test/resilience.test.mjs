// withRetry 循环语义：取令牌被上限截断后重取、429 置冷却并取 Retry-After 下限、不可重试立即抛。
// 限流 / 退避决策由 `throttle` 提供方出，此处用注入的假 Throttle 记录调用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelError } from '../execute/errors.ts'
import { withRetry } from '../execute/resilience.ts'

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

/** 假 Throttle：记录调用，按 overrides 决定 acquire / plan 回值。 */
function stubThrottle(overrides = {}) {
  const calls = { acquire: [], penalize: [], plan: [] }
  return {
    calls,
    async acquire(provider, now) {
      calls.acquire.push({ provider, now })
      return overrides.acquire?.(calls.acquire.length) ?? 0
    },
    async penalize(provider, now, retryAfterMs) {
      calls.penalize.push({ provider, now, retryAfterMs })
    },
    async plan(attempt, _policy, retryAfterMs) {
      calls.plan.push({ attempt, retryAfterMs })
      return overrides.plan?.(attempt) ?? 1
    },
  }
}

test('withRetry：等待被 backoff_max_ms 截断后重新取令牌', async () => {
  const throttle = stubThrottle({ acquire: (n) => (n === 1 ? 1000 : 0) })
  const waits = []
  const result = await withRetry('p', async () => 'ok', {
    policy: POLICY,
    throttle,
    now: 0,
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  assert.equal(result, 'ok')
  assert.deepEqual(waits, [100], '1000ms 等待按 100ms 上限截断')
  assert.equal(throttle.calls.acquire.length, 2, '截断后须重新取令牌')
})

test('withRetry：429 置冷却 + 取 Retry-After 下限，耗尽抛出', async () => {
  const throttle = stubThrottle({ plan: () => 50 })
  let calls = 0
  await assert.rejects(
    withRetry(
      'p',
      async () => {
        calls += 1
        throw new ModelError('model_rate_limited', '429', { retryable: true, retryAfterMs: 30 })
      },
      { policy: { ...POLICY, max_retries: 1 }, throttle, now: 0, sleep: async () => {} },
    ),
    (err) => err.code === 'model_rate_limited',
  )
  assert.equal(calls, 2)
  assert.deepEqual(throttle.calls.penalize, [{ provider: 'p', now: 0, retryAfterMs: 30 }])
  assert.deepEqual(throttle.calls.plan, [{ attempt: 0, retryAfterMs: 30 }])
})

test('withRetry：不可重试立即抛出，不取退避', async () => {
  const throttle = stubThrottle()
  let calls = 0
  await assert.rejects(
    withRetry(
      'p',
      async () => {
        calls += 1
        throw new ModelError('model_timeout', 'request timed out', { retryable: false })
      },
      { policy: POLICY, throttle, now: 0, sleep: async () => {} },
    ),
    (err) => err.code === 'model_timeout',
  )
  assert.equal(calls, 1, '超时不得重试')
  assert.equal(throttle.calls.plan.length, 0)
})
