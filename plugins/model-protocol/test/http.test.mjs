// `http.ts` 单元测试：body 阶段超时 / 断连必须结算；流式消费方提前退出须销毁上游 socket。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpRequest, httpStream } from '../execute/http.ts'
import { delay, sseEvent, sseHead, startHttpServer } from './fake-http.mjs'

test('httpRequest：响应头后 body 停滞 → 超时结算 model_timeout（不悬挂）', async () => {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"choices":')
    // 之后不再写、不结束：body 阶段 socket 空闲触发超时
  }
  const server = await startHttpServer(handler)
  try {
    await assert.rejects(
      httpRequest({ method: 'GET', url: server.url, headers: {}, timeout_ms: 50, now: 0 }),
      (err) => err.code === 'model_timeout',
    )
  } finally {
    await server.close()
  }
})

test('httpRequest：响应未完成即断连 → model_network_error 结算（不悬挂）', async () => {
  const handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"partial":')
    setTimeout(() => res.destroy(), 10)
  }
  const server = await startHttpServer(handler)
  try {
    await assert.rejects(
      httpRequest({ method: 'GET', url: server.url, headers: {}, timeout_ms: 5000, now: 0 }),
      (err) => err.code === 'model_network_error',
    )
  } finally {
    await server.close()
  }
})

test('httpStream：调用方从不迭代 → 未消费兜底 TTL 到点销毁上游（socket 不泄漏）', async () => {
  let closed = false
  const server = await startHttpServer((req, res) => {
    sseHead(res)
    sseEvent(res, { a: 1 })
    const timer = setInterval(() => sseEvent(res, { t: 1 }), 20)
    res.on('close', () => {
      closed = true
      clearInterval(timer)
    })
  })
  try {
    await httpStream({
      method: 'GET',
      url: server.url,
      headers: {},
      timeout_ms: 5000,
      now: 0,
      unconsumed_ttl_ms: 40,
    })
    await delay(150)
    assert.equal(closed, true, '未消费的流应被兜底销毁')
  } finally {
    await server.close()
  }
})

test('httpStream：持续吐增量不受空闲超时限制（判死按推进，不按总时长）', async () => {
  const server = await startHttpServer((req, res) => {
    sseHead(res)
    let sent = 0
    // 每 20ms 一个事件、共 8 个：总时长 160ms 远超 120ms 的空闲阈值，但每次间隔都短于阈值。
    const timer = setInterval(() => {
      sent += 1
      sseEvent(res, { t: sent })
      if (sent >= 8) {
        clearInterval(timer)
        res.end()
      }
    }, 20)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const stream = await httpStream({ method: 'GET', url: server.url, headers: {}, timeout_ms: 120, now: 0 })
    let chunks = 0
    for await (const chunk of stream.chunks) {
      assert.equal(typeof chunk, 'string')
      chunks += 1
    }
    assert.equal(chunks, 8, '仍在推进的流不得被空闲超时掐断')
  } finally {
    await server.close()
  }
})

test('httpStream：消费方提前 break → 上游响应被销毁（socket 释放）', async () => {
  let closed = false
  const server = await startHttpServer((req, res) => {
    sseHead(res)
    sseEvent(res, { a: 1 })
    const timer = setInterval(() => sseEvent(res, { t: 1 }), 20)
    res.on('close', () => {
      closed = true
      clearInterval(timer)
    })
  })
  try {
    const stream = await httpStream({ method: 'GET', url: server.url, headers: {}, timeout_ms: 5000, now: 0 })
    for await (const chunk of stream.chunks) {
      assert.equal(typeof chunk, 'string')
      break
    }
    await delay(50)
    assert.equal(closed, true, '提前退出应销毁上游响应')
  } finally {
    await server.close()
  }
})
