// 反向调用接线：方法表把发起 call 帧 id 下传，SDK PortLink 负责帧协议与按 id 配对。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PortLink } from 'plugin-sdk'
import { createHandlers } from '../execute/methods.ts'

test('createHandlers.invoke 把 call 帧 id 作为 callId 下传（反向帧回带）', async () => {
  const frames = []
  const link = new PortLink({ write: (message) => frames.push(message), idPrefix: 'tool-http' })
  const handlers = createHandlers(link)
  const pending = handlers.invoke(
    { tool: 'webfetch', args: { url: 'https://page.test/' }, config: { obey_robots: false } },
    { run: null, thread: null, now: 0 },
    'call-42',
  )
  const call = frames.find((frame) => frame.kind === 'port.call')
  assert.ok(call !== undefined, '应发出反向 port.call')
  assert.equal(call.call_id, 'call-42')
  link.settle({ kind: 'port.error', id: call.id, error: 'fetch_failed', message: 'stop' })
  const result = await pending
  assert.equal(result.ok, false)
})
