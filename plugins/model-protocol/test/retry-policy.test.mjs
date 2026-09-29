// 重试策略：只重试确定未开始计费的失败（连接失败、429）；超时与已开始生成后的失败一律不重试，
// 避免长推理断一次再烧一轮。用本地 HTTP 端点复现「响应头已到、body 停滞」与「连不上」两种路径。
// 限流 / 退避决策由 `throttle` 提供方出，此处注入假 Throttle。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelError } from '../execute/errors.ts'
import { httpRequest } from '../execute/http.ts'
import { withRetry } from '../execute/resilience.ts'
import { startHttpServer } from './fake-http.mjs'

const POLICY = {
  max_retries: 3,
  backoff_ms: 1,
  backoff_max_ms: 1,
  jitter: false,
  request_timeout_ms: 1000,
  connect_timeout_ms: 1000,
  token_bucket: { capacity: 100, refill_per_sec: 1000 },
  models_dev_url: 'https://example.invalid/api.json',
}

/** 假 Throttle：一律可立即取令牌、退避 1ms。 */
const STUB_THROTTLE = {
  async acquire() {
    return 0
  },
  async penalize() {},
  async plan() {
    return 1
  },
}

test('withRetry：超时不可重试，一次即抛', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(
      'p',
      async () => {
        calls += 1
        throw new ModelError('model_timeout', 'request timed out', { retryable: false })
      },
      { policy: POLICY, throttle: STUB_THROTTLE, now: 0, sleep: async () => {} },
    ),
    (err) => err.code === 'model_timeout',
  )
  assert.equal(calls, 1, '超时不得重试')
})

test('withRetry：连接失败可重试', async () => {
  let calls = 0
  const result = await withRetry(
    'p',
    async () => {
      calls += 1
      if (calls === 1)
        throw new ModelError('model_network_error', 'connect refused', { retryable: true })
      return 'ok'
    },
    { policy: POLICY, throttle: STUB_THROTTLE, now: 0, sleep: async () => {} },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 2, '连接失败应重试一次')
})

test('httpRequest：响应头已到而 body 停滞 → 超时且 withRetry 不重试', async () => {
  const server = await startHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"choices":')
    // 之后不写不结束：socket 空闲触发超时
  })
  try {
    await assert.rejects(
      withRetry(
        'p',
        () => httpRequest({ method: 'GET', url: server.url, headers: {}, timeout_ms: 50, now: 0 }),
        {
          policy: { ...POLICY, max_retries: 2 },
          throttle: STUB_THROTTLE,
          now: 0,
          sleep: async () => {},
        },
      ),
      (err) => err.code === 'model_timeout' && err.retryable === false,
    )
    assert.equal(server.requests.length, 1, '超时不得重试')
  } finally {
    await server.close()
  }
})

test('httpRequest：连不上（响应未开始）→ 连接失败且可重试', async () => {
  const server = await startHttpServer((req, res) => {
    res.writeHead(200)
    res.end()
  })
  const url = server.url
  await server.close()
  await assert.rejects(
    httpRequest({ method: 'GET', url, headers: {}, timeout_ms: 5000, now: 0 }),
    (err) => err.code === 'model_network_error' && err.retryable === true,
  )
})
