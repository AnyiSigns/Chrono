// 并发方法声明行为：`model.chat` 声明 concurrent_methods，SDK 让它脱出服务串行链，
// 两次调用在途时互不阻塞。声明未生效则第二次会排在第一次之后，供应商端同时在途数恒为 1。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatBag, startService } from './driver.mjs'
import { sseEvent, sseHead, startHttpServer } from './fake-http.mjs'

const FAST = {
  max_retries: 1,
  backoff_ms: 5,
  backoff_max_ms: 20,
  token_bucket: { capacity: 100, refill_per_sec: 1000 },
}

test('concurrent_methods=chat：两次 chat 并发在途、互不阻塞', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const server = await startHttpServer((req, res) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    setTimeout(() => {
      inFlight -= 1
      sseHead(res)
      sseEvent(res, { choices: [{ delta: { content: 'ok' } }] })
      sseEvent(res, '[DONE]')
      res.end()
    }, 100)
  })
  const driver = startService({})
  try {
    await driver.hello()
    const bag = chatBag(server.url, { resilience: FAST })
    const [first, second] = await Promise.all([driver.call('chat', bag), driver.call('chat', bag)])
    assert.equal(first.value.ok, true)
    assert.equal(second.value.ok, true)
    assert.equal(maxInFlight, 2, 'chat 应并发在途（声明未生效会串行成 1）')
  } finally {
    driver.close()
    await driver.exit
    await server.close()
  }
})
