// 模型厂商 HTTP 桩的线协议自检：纯文本 / 工具调用 / 推理 / 任意流式分片 / 静默 / 连接失败 / HTTP 错误。
// 不依赖 model-protocol 内部实现，只按 openai-chat 的 SSE 与 JSON 形状断言。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startModelStub } from '../harness/index.mjs'

async function post(stub, body) {
  return fetch(`${stub.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('纯文本：SSE 分片 + [DONE]', async (t) => {
  const stub = startModelStub({ defaultText: 'plain' })
  await stub.ready
  t.after(() => stub.close())
  const response = await post(stub, { stream: true, messages: [] })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const body = await response.text()
  assert.ok(body.includes('plain'))
  assert.ok(body.includes('data: [DONE]'))
})

test('工具调用：function tool_calls 分片与 finish_reason=tool_calls', async (t) => {
  const stub = startModelStub({
    responder: () => ({ type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', arguments: { path: 'a.txt' } }] }),
  })
  await stub.ready
  t.after(() => stub.close())
  const body = await (await post(stub, { stream: true, messages: [] })).text()
  assert.ok(body.includes('"tool_calls"'))
  assert.ok(body.includes('"name":"read"'))
  assert.ok(body.includes('tool_calls'))
})

test('推理：reasoning_content 分片', async (t) => {
  const stub = startModelStub({ responder: () => ({ type: 'reasoning', reasoning: 'think', text: 'answer' }) })
  await stub.ready
  t.after(() => stub.close())
  const body = await (await post(stub, { stream: true, messages: [] })).text()
  assert.ok(body.includes('reasoning_content'))
  assert.ok(body.includes('answer'))
})

test('任意流式分片序列原样透传', async (t) => {
  const stub = startModelStub({
    responder: () => ({
      type: 'stream',
      events: [
        { choices: [{ index: 0, delta: { content: 'A' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'B' }, finish_reason: 'stop' }] },
      ],
    }),
  })
  await stub.ready
  t.after(() => stub.close())
  const body = await (await post(stub, { stream: true, messages: [] })).text()
  assert.ok(body.includes('"A"'))
  assert.ok(body.includes('"B"'))
})

test('非流式：完整 JSON 回包', async (t) => {
  const stub = startModelStub({ responder: () => ({ type: 'text', text: 'full' }) })
  await stub.ready
  t.after(() => stub.close())
  const payload = await (await post(stub, { stream: false, messages: [] })).json()
  assert.equal(payload.choices[0].message.content, 'full')
  assert.ok(typeof payload.usage.total_tokens === 'number')
})

test('HTTP 错误：按脚本回状态码', async (t) => {
  const stub = startModelStub({ responder: () => ({ type: 'http_error', status: 503 }) })
  await stub.ready
  t.after(() => stub.close())
  const response = await post(stub, { stream: true, messages: [] })
  assert.equal(response.status, 503)
})

test('连接失败：断开 socket', async (t) => {
  const stub = startModelStub({ responder: () => ({ type: 'connection_failure' }) })
  await stub.ready
  t.after(() => stub.close())
  await assert.rejects(post(stub, { stream: true, messages: [] }))
})

test('长静默：在给定时限内不回包，超时后收尾', async (t) => {
  const stub = startModelStub({ responder: () => ({ type: 'silence', ms: 30 }) })
  await stub.ready
  t.after(() => stub.close())
  const response = await post(stub, { stream: true, messages: [] })
  assert.equal(response.status, 200)
  assert.equal((await response.text()).length, 0)
})
