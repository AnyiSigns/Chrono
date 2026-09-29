// `abort(turn_id)`：销毁该回合在途 HTTP 请求；缺 / 未知 turn_id 是幂等 no-op；
// 请求在成功 / 错误 / 超时 / 中止四条完成路径上都摘除在途登记，映射不泄漏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatBag, startService } from './driver.mjs'
import { jsonResponse, sseEvent, sseHead, startHttpServer } from './fake-http.mjs'

const FAST = {
  max_retries: 1,
  backoff_ms: 5,
  backoff_max_ms: 20,
  request_timeout_ms: 30000,
  token_bucket: { capacity: 100, refill_per_sec: 1000 },
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withDriver(run) {
  const driver = startService({})
  try {
    await driver.hello()
    return await run(driver)
  } finally {
    driver.close()
    await driver.exit
  }
}

test('abort：缺 turn_id / 未知 turn_id 是幂等 no-op', async () => {
  await withDriver(async (driver) => {
    assert.deepEqual((await driver.call('abort', {})).value, {
      ok: true,
      aborted: false,
      turn_id: null,
    })
    assert.deepEqual((await driver.call('abort', { turn_id: 'nope' })).value, {
      ok: true,
      aborted: false,
      turn_id: 'nope',
    })
  })
})

test('abort：销毁在途流式请求，失败归 model_aborted（不可重试），登记清理', async () => {
  let closed = false
  const server = await startHttpServer((req, res) => {
    res.on('close', () => {
      closed = true
    })
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { content: 'partial' } }] })
    // 不结束：等待客户端中止。
  })
  const driver = startService({})
  try {
    await driver.hello()
    const pending = driver.call(
      'chat',
      chatBag(server.url, { turn_id: 't-abort', resilience: FAST }),
    )
    await waitFor(() => server.requests.length >= 1)
    assert.equal((await driver.call('abort', { turn_id: 't-abort' })).value.aborted, true)
    const result = await pending
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_aborted')
    await waitFor(() => closed === true)
    // 登记已清理：再次 abort 是 no-op；不可重试，只发过一次请求。
    assert.equal((await driver.call('abort', { turn_id: 't-abort' })).value.aborted, false)
    assert.equal(server.requests.length, 1)
  } finally {
    driver.close()
    await driver.exit
    await server.close()
  }
})

test('abort：销毁在途非流式请求（complete）', async () => {
  const server = await startHttpServer((req, res) => {
    setTimeout(
      () =>
        jsonResponse(res, 200, { choices: [{ message: { role: 'assistant', content: 'late' } }] }),
      500,
    )
  })
  const driver = startService({})
  try {
    await driver.hello()
    const pending = driver.call(
      'complete',
      chatBag(server.url, { turn_id: 't-comp', resilience: FAST }),
    )
    await waitFor(() => server.requests.length >= 1)
    assert.equal((await driver.call('abort', { turn_id: 't-comp' })).value.aborted, true)
    const result = await pending
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'model_aborted')
    assert.equal((await driver.call('abort', { turn_id: 't-comp' })).value.aborted, false)
  } finally {
    driver.close()
    await driver.exit
    await server.close()
  }
})

test('完成路径清理：成功 / HTTP 错误后 abort 都是 no-op', async () => {
  {
    const server = await startHttpServer((req, res) => {
      sseHead(res)
      sseEvent(res, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })
      sseEvent(res, '[DONE]')
      res.end()
    })
    const driver = startService({})
    try {
      await driver.hello()
      const ok = await driver.call(
        'chat',
        chatBag(server.url, { turn_id: 't-ok', resilience: FAST }),
      )
      assert.equal(ok.value.ok, true)
      assert.equal((await driver.call('abort', { turn_id: 't-ok' })).value.aborted, false)
    } finally {
      driver.close()
      await driver.exit
      await server.close()
    }
  }
  {
    const server = await startHttpServer((req, res) =>
      jsonResponse(res, 400, { error: { message: 'bad' } }),
    )
    const driver = startService({})
    try {
      await driver.hello()
      const bad = await driver.call(
        'chat',
        chatBag(server.url, { turn_id: 't-bad', resilience: FAST }),
      )
      assert.equal(bad.value.ok, false)
      assert.equal((await driver.call('abort', { turn_id: 't-bad' })).value.aborted, false)
    } finally {
      driver.close()
      await driver.exit
      await server.close()
    }
  }
})

test('完成路径清理：socket 空闲超时后 abort 是 no-op', async () => {
  const server = await startHttpServer((req, res) => {
    sseHead(res)
    // 收头后一直不发数据：socket 空闲超时。等待销毁。
  })
  const driver = startService({})
  try {
    await driver.hello()
    const result = await driver.call(
      'chat',
      chatBag(server.url, {
        turn_id: 't-timeout',
        resilience: { ...FAST, max_retries: 0, request_timeout_ms: 150 },
      }),
    )
    assert.equal(result.value.ok, false)
    assert.equal((await driver.call('abort', { turn_id: 't-timeout' })).value.aborted, false)
  } finally {
    driver.close()
    await driver.exit
    await server.close()
  }
})
