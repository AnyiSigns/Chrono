// 引用按需解析的不可用口径（node --test）：mock read 缺失 / 越权 → hydrate 抛 DefUnavailableError；
// 服务帧循环把该错误映射为 `def_unavailable`（不再静默空闭包）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRefHydrator, DefUnavailableError } from '../execute/refs.ts'
import { defaultBridge, idsFixture, startService, FIXED_ENV } from './driver.mjs'

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

test('hydrate：read 缺失 → 抛 def_unavailable 并带不可用哈希', async () => {
  const hydrator = createRefHydrator(async () => ({ defs: {}, missing: [H1], denied: [] }))
  await assert.rejects(hydrator.hydrate('session', [H1]), (err) => {
    assert.ok(err instanceof DefUnavailableError)
    assert.equal(err.code, 'def_unavailable')
    assert.deepEqual(err.hashes, [H1])
    return true
  })
})

test('hydrate：read 越权 / 传输失败 → 同样抛 def_unavailable', async () => {
  const denied = createRefHydrator(async () => ({ defs: {}, missing: [], denied: [H2] }))
  await assert.rejects(denied.hydrate('session', [H2]), (err) => err.code === 'def_unavailable')
  const failed = createRefHydrator(async () => null)
  await assert.rejects(failed.hydrate('session', [H1]), (err) => err.code === 'def_unavailable')
})

test('hydrate：可取回时返回闭包；refs 已是对象 / 非数组行为不变', async () => {
  const body = { id: 'm1', prev: null }
  const hydrator = createRefHydrator(async () => ({ defs: { [H1]: body }, missing: [], denied: [] }))
  assert.deepEqual(await hydrator.hydrate('session', [H1]), { [H1]: body })
  const inline = { [H2]: { id: 'm2' } }
  assert.equal(await hydrator.hydrate('session', inline), inline)
  assert.deepEqual(await hydrator.hydrate('session', 7), {})
})

test('service frame: unavailable referenced def -> def_unavailable, not a silent empty closure', async () => {
  const drv = startService({
    bridge: (port, method) =>
      port === 'host' && method === 'def.read'
        ? Promise.resolve({ error: 'denied', message: 'denied' })
        : defaultBridge()(port, method),
  })
  try {
    await drv.hello()
    const ids = idsFixture()
    // A definition identity still hydrates hash-list refs through host.def.read.
    ids.todo = { body: { conversations: {} }, refs: [H1] }
    const message = await drv.call('send', ids, FIXED_ENV)
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'def_unavailable')
  } finally {
    drv.close()
  }
})
