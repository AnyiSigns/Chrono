// 引用水合的不可用口径（node --test）：水合归 `ref-hydrate` 提供方；其 def_unavailable 经服务帧同码透传。
// 服务帧循环把该错误映射为 `def_unavailable`（不再静默空闭包）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultBridge, idsFixture, startService, FIXED_ENV } from './driver.mjs'

const H1 = 'a'.repeat(64)

test('service frame: unavailable referenced def -> def_unavailable, not a silent empty closure', async () => {
  const drv = startService({
    bridge: (port, method, args) =>
      port === 'ref-hydrate' && method === 'hydrate'
        ? Promise.resolve({ error: 'def_unavailable', message: 'def unavailable' })
        : defaultBridge()(port, method, args),
  })
  try {
    await drv.hello()
    const ids = idsFixture()
    // A definition identity still hydrates hash-list refs through `ref-hydrate.hydrate`.
    ids.todo = { body: { conversations: {} }, refs: [H1] }
    const message = await drv.call('send', ids, FIXED_ENV)
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'def_unavailable')
  } finally {
    drv.close()
  }
})
