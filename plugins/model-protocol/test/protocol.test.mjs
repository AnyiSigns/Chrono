// `model-protocol` 协议级测试：本地 HTTP 服务器模拟三协议（含 SSE 分片、usage 三种来源、tool_calls）。
// 覆盖请求编解码、流式不重不漏、韧性（重试 / 429 退避 / 流断重连 / 4xx 不重试）、结构化错误、密钥不外泄。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatBag, configFor, startService } from './driver.mjs'
import { delay, jsonResponse, parseBody, sseEvent, sseHead, startHttpServer } from './fake-http.mjs'

const FAST = { max_retries: 2, backoff_ms: 5, backoff_max_ms: 20, token_bucket: { capacity: 100, refill_per_sec: 1000 } }

function deltas(driver, field) {
  return driver.events
    .filter((event) => event.topic === 'model.delta')
    .map((event) => event.payload[field])
    .filter((value) => typeof value === 'string')
}

async function withService(options, run) {
  const driver = startService(options)
  try {
    await driver.hello()
    return await run(driver)
  } finally {
    driver.close()
    await driver.exit
  }
}

async function withServer(handler, run) {
  const server = await startHttpServer(handler)
  try {
    return await run(server)
  } finally {
    await server.close()
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest（与 plugin.json 一致）；控制帧与 EOF 自退出', async () => {
  await withService({}, async (driver) => {
    const manifest = await driver.hello()
    assert.equal(manifest.identity, 'model-protocol')
    assert.deepEqual(manifest.implements, ['model'])
    assert.deepEqual(manifest.methods.model, ['chat', 'complete', 'vendors', 'discover', 'profile', 'sync'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await driver.request('probe', {}, 'pong')).ok, true)
    assert.equal((await driver.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  })
})

test('未知能力类 / 未知方法 / args 非对象 → 结构化 error', async () => {
  await withService({}, async (driver) => {
    assert.equal((await driver.request('call', { port: 'other', method: 'chat', args: {} }, 'error')).code, 'unresolved_cap')
    assert.equal((await driver.request('call', { port: 'model', method: 'nope', args: {} }, 'error')).code, 'unknown_method')
    assert.equal((await driver.request('call', { port: 'model', method: 'chat', args: 'x' }, 'error')).code, 'bad_args')
  })
})

// ── openai-chat：请求编解码 + 流式 ─────────────────────────────────────────

test('openai-chat：请求编解码（max_tokens / reasoning_field·map / auth / system 角色）与流式分片', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { role: 'assistant' } }] })
    sseEvent(res, { choices: [{ delta: { content: 'Hel' } }] })
    sseEvent(res, { choices: [{ delta: { content: 'lo' } }] })
    sseEvent(res, { choices: [{ delta: { reasoning_content: 'think' } }] })
    sseEvent(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"a"' } }] } }] })
    sseEvent(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] })
    sseEvent(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    sseEvent(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })
    sseEvent(res, '[DONE]')
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({ secretsResolver: () => ({ value: 'sk-secret-xyz' }) }, async (driver) => {
      const bag = chatBag(server.url, {
        config: { auth_ref: { kind: 'local', name: 'KEY' } },
        resilience: FAST,
      })
      const result = await driver.call('chat', bag)
      assert.equal(result.kind, 'result')
      assert.equal(result.value.ok, true)
      assert.equal(result.value.text, 'Hello')
      assert.equal(result.value.reasoning, 'think')
      assert.deepEqual(result.value.tool_calls, [{ id: 'call_1', name: 'lookup', arguments: { a: 1 } }])
      assert.deepEqual(result.value.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })
      assert.equal(result.value.protocol, 'openai-chat')

      const request = server.requests[0]
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer sk-secret-xyz')
      const body = parseBody(request)
      assert.equal(body.model, 'test-model')
      assert.equal(body.messages[0].role, 'system')
      assert.equal(body.messages[0].content, 'be terse')
      assert.equal(body.max_tokens, 64)
      assert.equal(body.reasoning_effort, 'low')
      assert.equal(body.stream, true)
      assert.deepEqual(body.stream_options, { include_usage: true })

      assert.equal(deltas(driver, 'text').join(''), 'Hello')
      assert.equal(deltas(driver, 'reasoning').join(''), 'think')
      const payloads = driver.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload)
      assert.ok(payloads.every((payload) => payload.run === 'run-1' && payload.thread === 't1'))
      assert.equal(JSON.stringify(result.value).includes('sk-secret-xyz'), false, '明文不得进结果')
      assert.equal(JSON.stringify(driver.events).includes('sk-secret-xyz'), false, '明文不得进事件')
      assert.equal(JSON.stringify(request.body).includes('sk-secret-xyz'), false, '明文不得进请求体')
      assert.ok(driver.portCalls.some((call) => call.port === 'secrets' && call.method === 'resolve'))
    })
  })
})

test('openai-chat：usage 来源 none → usage 为 null，不发 usage 事件', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { content: 'x' } }] })
    sseEvent(res, '[DONE]')
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, { config: { quirks: { ...configFor('').quirks, stream_usage: 'none' } }, resilience: FAST })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.usage, null)
      assert.equal(deltas(driver, 'usage').length, 0)
      assert.equal(parseBody(server.requests[0]).stream_options, undefined)
    })
  })
})

test('SSE 多字节字符跨 TCP 块：按字节流解码不损坏分片', async () => {
  const payload = Buffer.from(
    `data: ${JSON.stringify({ choices: [{ delta: { content: '中' } }] })}\n\n`,
    'utf8',
  )
  const cut = payload.indexOf(Buffer.from('中', 'utf8')) + 1
  const handler = (req, res) => {
    sseHead(res)
    res.write(payload.subarray(0, cut))
    setTimeout(() => {
      res.write(payload.subarray(cut))
      res.write('data: [DONE]\n\n')
      res.end()
    }, 10)
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', chatBag(server.url, { resilience: FAST }))
      assert.equal(result.value.ok, true)
      assert.equal(result.value.text, '中')
    })
  })
})

// ── openai-responses ───────────────────────────────────────────────────────

test('openai-responses：input / max_output_tokens 编解码与类型化事件流', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { type: 'response.output_text.delta', delta: 'Hi ' })
    sseEvent(res, { type: 'response.output_text.delta', delta: 'there' })
    sseEvent(res, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_r', name: 'search' } })
    sseEvent(res, { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":"x"}' })
    sseEvent(res, { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } })
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const quirks = { ...configFor('').quirks, protocol: 'openai-responses', max_tokens_field: 'max_output_tokens', reasoning_field: null }
      const bag = chatBag(server.url, { config: { quirks }, resilience: FAST })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.text, 'Hi there')
      assert.deepEqual(result.value.tool_calls, [{ id: 'call_r', name: 'search', arguments: { q: 'x' } }])
      assert.deepEqual(result.value.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
      const body = parseBody(server.requests[0])
      assert.equal(server.requests[0].url, '/responses')
      assert.equal(body.max_output_tokens, 64)
      assert.equal(body.messages, undefined)
      assert.equal(body.input.length, 2)
      assert.equal(body.reasoning_effort, undefined)
    })
  })
})

// ── anthropic-messages ─────────────────────────────────────────────────────

test('anthropic-messages：system 顶层 / x-api-key + anthropic-version / thinking 与 tool_use', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { type: 'message_start', message: { usage: { input_tokens: 2 } } })
    sseEvent(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    sseEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })
    sseEvent(res, { type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    sseEvent(res, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } })
    sseEvent(res, { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'calc' } })
    sseEvent(res, { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"n":2}' } })
    sseEvent(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } })
    sseEvent(res, { type: 'message_stop' })
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({ secretsResolver: () => ({ value: 'anth-key' }) }, async (driver) => {
      const quirks = {
        ...configFor('').quirks,
        protocol: 'anthropic-messages',
        auth_style: 'header',
        auth_header: 'x-api-key',
        max_tokens_field: 'max_tokens',
        stream_usage: 'separate',
        extra_headers: { 'anthropic-version': '2023-06-01' },
      }
      const bag = chatBag(server.url, { config: { quirks, auth_ref: { kind: 'env', name: 'A' } }, resilience: FAST })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.text, 'Answer')
      assert.equal(result.value.reasoning, 'hmm')
      assert.deepEqual(result.value.tool_calls, [{ id: 'toolu_1', name: 'calc', arguments: { n: 2 } }])
      assert.deepEqual(result.value.usage, { prompt_tokens: 2, completion_tokens: 6, total_tokens: 8 })
      assert.equal(result.value.stop_reason, 'tool_use')

      const request = server.requests[0]
      assert.equal(request.url, '/messages')
      assert.equal(request.headers['x-api-key'], 'anth-key')
      assert.equal(request.headers['anthropic-version'], '2023-06-01')
      const body = parseBody(request)
      assert.equal(body.system, 'be terse')
      assert.equal(body.messages.length, 1)
      assert.equal(body.messages[0].role, 'user')
      assert.equal(body.max_tokens, 64)
    })
  })
})

// ── complete（非流式） ─────────────────────────────────────────────────────

test('complete：非流式、不发 model.delta，回 {text, usage}', async () => {
  const handler = (req, res) => {
    jsonResponse(res, 200, {
      choices: [{ message: { content: 'done', reasoning_content: 'r' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('complete', chatBag(server.url, { resilience: FAST }))
      assert.deepEqual(result.value, { ok: true, text: 'done', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
      assert.equal(driver.events.length, 0, 'complete 不发事件')
      assert.equal(parseBody(server.requests[0]).stream, false)
    })
  })
})

// ── 韧性 ───────────────────────────────────────────────────────────────────

test('瞬时错误重试：5xx 后成功；请求次数 = 2', async () => {
  let count = 0
  const handler = (req, res) => {
    count += 1
    if (count === 1) {
      jsonResponse(res, 500, { error: 'boom' })
      return
    }
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { content: 'ok' } }] })
    sseEvent(res, '[DONE]')
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', chatBag(server.url, { resilience: FAST }))
      assert.equal(result.value.ok, true)
      assert.equal(result.value.text, 'ok')
      assert.equal(server.requests.length, 2)
    })
  })
})

test('429：尊重 Retry-After 后退避重试；耗尽回 model_rate_limited', async () => {
  let count = 0
  const handler = (req, res) => {
    count += 1
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end(JSON.stringify({ error: 'slow down' }))
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', chatBag(server.url, { resilience: { ...FAST, max_retries: 1 } }))
      assert.equal(result.value.ok, false)
      assert.equal(result.value.error.code, 'model_rate_limited')
      assert.equal(server.requests.length, 2)
    })
  })
})

test('429 正秒数 Retry-After：按该值退避后重试', async () => {
  const handler = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0.05' })
    res.end(JSON.stringify({ error: 'slow down' }))
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const begin = Date.now()
      const result = await driver.call('chat', chatBag(server.url, { resilience: { ...FAST, max_retries: 1 } }))
      assert.equal(result.value.error.code, 'model_rate_limited')
      assert.equal(server.requests.length, 2)
      assert.ok(Date.now() - begin >= 40, '应等待 Retry-After 指定的时长')
    })
  })
})

test('流断整请求重试：分片不重不漏', async () => {
  let count = 0
  const handler = (req, res) => {
    count += 1
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { content: 'part1-' } }] })
    if (count === 1) {
      sseEvent(res, { choices: [{ delta: { content: 'partial' } }] })
      setTimeout(() => res.destroy(), 10)
      return
    }
    sseEvent(res, { choices: [{ delta: { content: 'part2' } }] })
    sseEvent(res, '[DONE]')
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', chatBag(server.url, { resilience: FAST }))
      assert.equal(result.value.ok, true)
      assert.equal(result.value.text, 'part1-part2')
      assert.equal(server.requests.length, 2)
      const payloads = driver.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload)
      assert.ok(payloads.some((payload) => payload.reset === true), '重试前应上行 reset')
      const lastReset = payloads.map((payload) => payload.reset === true).lastIndexOf(true)
      const afterReset = payloads.slice(lastReset + 1).map((payload) => payload.text).filter((value) => typeof value === 'string')
      assert.equal(afterReset.join(''), 'part1-part2', 'reset 后重放的文本不重不漏')
    })
  })
})

test('4xx 不重试：400 一次即回 model_bad_request', async () => {
  const handler = (req, res) => jsonResponse(res, 400, { error: 'bad' })
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', chatBag(server.url, { resilience: FAST }))
      assert.equal(result.value.error.code, 'model_bad_request')
      assert.equal(server.requests.length, 1)
    })
  })
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('401 → model_auth_failed；网络不可达 → model_network_error；未知协议 → model_unsupported', async () => {
  const handler = (req, res) => jsonResponse(res, 401, { error: 'nope' })
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const auth = await driver.call('chat', chatBag(server.url, { resilience: FAST }))
      assert.equal(auth.value.error.code, 'model_auth_failed')
      assert.equal(server.requests.length, 1, '401 不重试')
      const unsupported = await driver.call('chat', chatBag(server.url, { config: { quirks: { ...configFor('').quirks, protocol: 'nope' } }, resilience: FAST }))
      assert.equal(unsupported.value.error.code, 'model_unsupported')
    })
  })
  const dead = await startHttpServer((req, res) => jsonResponse(res, 200, {}))
  const deadUrl = dead.url
  await dead.close()
  await withService({}, async (driver) => {
    const result = await driver.call('chat', chatBag(deadUrl, { resilience: { ...FAST, max_retries: 0 } }))
    assert.equal(result.value.error.code, 'model_network_error')
  })
})

test('密钥解析失败 → model_auth_failed，且不回明文', async () => {
  await withService({ secretsResolver: () => ({ error: 'secret_missing', message: 'not found' }) }, async (driver) => {
    const result = await driver.call('chat', chatBag('http://127.0.0.1:1', { config: { auth_ref: { kind: 'local', name: 'MISSING' } }, resilience: FAST }))
    assert.equal(result.value.error.code, 'model_auth_failed')
    assert.equal(JSON.stringify(result.value).includes('sk-secret'), false)
  })
})

test('bag 缺 config / model → 协议 bad_args', async () => {
  await withService({}, async (driver) => {
    assert.equal((await driver.call('chat', { messages: [] })).code, 'bad_args')
    assert.equal((await driver.call('chat', { config: { base_url: 'x' }, messages: [] })).code, 'bad_args')
  })
})

// ── 超时 ───────────────────────────────────────────────────────────────────

test('请求超时 → model_timeout（可重试，耗尽后回该码）', async () => {
  const handler = () => {
    // 不结束响应，等客户端超时。
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, { resilience: { ...FAST, max_retries: 0, request_timeout_ms: 50 } })
      const result = await driver.call('complete', bag)
      assert.equal(result.value.error.code, 'model_timeout')
    })
  })
})
