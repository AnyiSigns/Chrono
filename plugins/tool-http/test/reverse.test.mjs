// 反向调用链接测试：调用 id 用序号（可回放、非随机），写帧失败作结构化失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ReverseLink } from '../execute/reverse.ts'
import { HANDLERS, REVERSE } from '../execute/methods.ts'

test('写帧失败 → transport_failed，且不残留 pending', async () => {
  const link = new ReverseLink()
  const original = process.stdout.write
  process.stdout.write = () => {
    throw new Error('boom')
  }
  try {
    const outcome = await link.call('sandbox', 'exec', { cmd: 'fetcher' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'transport_failed')
  } finally {
    process.stdout.write = original
  }
})

test('调用 id 是序号形态（非 randomUUID）', async () => {
  const link = new ReverseLink()
  const frames = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    const body = chunk.subarray(4).toString('utf8')
    frames.push(JSON.parse(body))
    return true
  }
  try {
    const first = link.call('sandbox', 'exec', { cmd: 'a' })
    const second = link.call('sandbox', 'exec', { cmd: 'b' })
    assert.equal(frames[0].id, 'tool-http-pc-0')
    assert.equal(frames[1].id, 'tool-http-pc-1')
    link.failAll()
    await Promise.all([first, second])
  } finally {
    process.stdout.write = original
  }
})

test('反向帧回带 call_id：有则带，无则省略', async () => {
  const link = new ReverseLink()
  const frames = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    frames.push(JSON.parse(chunk.subarray(4).toString('utf8')))
    return true
  }
  try {
    const withId = link.call('sandbox', 'exec', { cmd: 'a' }, 'call-7')
    const withoutId = link.call('sandbox', 'exec', { cmd: 'b' }, null)
    assert.equal(frames[0].call_id, 'call-7')
    assert.equal(frames[1].call_id, undefined)
    link.failAll()
    await Promise.all([withId, withoutId])
  } finally {
    process.stdout.write = original
  }
})

test('timeoutMs 覆盖通道兜底：到点作 tool_timeout', async () => {
  const link = new ReverseLink()
  const original = process.stdout.write
  let pending
  process.stdout.write = () => true
  try {
    pending = link.call('sandbox', 'exec', { cmd: 'slow' }, null, 20)
  } finally {
    process.stdout.write = original
  }
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'tool_timeout')
})

test('HANDLERS.invoke 把 call 帧 id 作为 callId 下传（反向帧回带）', async () => {
  const frames = []
  const original = process.stdout.write
  let pending
  process.stdout.write = (chunk) => {
    frames.push(JSON.parse(chunk.subarray(4).toString('utf8')))
    return true
  }
  try {
    pending = HANDLERS.invoke(
      { tool: 'webfetch', args: { url: 'https://page.test/' }, config: { obey_robots: false } },
      { run: null, thread: null, now: 0 },
      'call-42',
    )
  } finally {
    process.stdout.write = original
  }
  const call = frames.find((frame) => frame.kind === 'port.call')
  assert.ok(call !== undefined, '应发出反向 port.call')
  assert.equal(call.call_id, 'call-42')
  REVERSE.settle({ kind: 'port.error', id: call.id, error: 'fetch_failed', message: 'stop' })
  const result = await pending
  assert.equal(result.ok, false)
})
