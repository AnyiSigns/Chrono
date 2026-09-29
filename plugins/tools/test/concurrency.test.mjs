// 并发方法声明行为：`tools.dispatch` 声明 concurrent_methods，SDK 让它脱出服务串行链，
// 两次派发在途时互不阻塞。声明未生效则第二次会排在第一次之后，提供者端同时在途数恒为 1。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardAllow, startService } from './driver.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const NO_CAPS = { fs: { read: 'none', write: 'none' }, net: 'none' }

function readDecl() {
  return {
    name: 'read',
    provider: 'tool-fs',
    kind: 'invoke',
    method: null,
    read: null,
    intent: 'i',
    when_to_use: 'w',
    param_semantics: {},
    boundaries: 'b',
    description: 'd',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: true,
    },
    caps: NO_CAPS,
    idempotent: false,
  }
}

test('concurrent_methods=dispatch：两次 dispatch 并发在途、互不阻塞', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      invoke: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(120)
        inFlight -= 1
        return { ok: true, result: { text: 'x' } }
      },
    },
  }
  const service = startService({ providers })
  try {
    await service.hello()
    const bag = (path) => ({
      calls: [{ call_id: 'c1', tool: 'read', args: { path } }],
      directory: { tools: [readDecl()], rejected: [] },
      workspace_root: '/ws',
      verdicts: 'allow',
    })
    const [first, second] = await Promise.all([
      service.call('dispatch', bag('a.ts')),
      service.call('dispatch', bag('b.ts')),
    ])
    assert.equal(first.value.results[0].ok, true)
    assert.equal(second.value.results[0].ok, true)
    assert.equal(maxInFlight, 2, 'dispatch 应并发在途（声明未生效会串行成 1）')
  } finally {
    service.close()
  }
})
