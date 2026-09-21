// 反向调用链接测试：调用 id 用序号（可回放、非随机），写帧失败作结构化失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ReverseLink } from '../execute/reverse.ts'

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
