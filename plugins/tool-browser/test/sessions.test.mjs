// 会话生命周期测试：确定性 id、状态保持、TTL 回收、close / closeAll、session_not_found。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionManager } from '../execute/sessions.ts'
import { ToolError } from '../execute/types.ts'
import { makeFakeEngine } from './fake-engine.mjs'

const BASE_CONFIG = {
  impl: 'fake',
  headless: true,
  browserPath: null,
  viewport: { width: 800, height: 600 },
  navigationTimeoutMs: 1000,
  actionTimeoutMs: 1000,
  screenshotFormat: 'png',
  allowDownload: false,
  stateDir: null,
}

function manager(options = {}) {
  const engines = []
  const sessions = new SessionManager(
    async () => {
      const engine = makeFakeEngine()
      engines.push(engine)
      return engine
    },
    BASE_CONFIG,
    options.idleMs ?? 1000,
  )
  return { sessions, engines }
}

test('会话 id 由 run + 序号确定性派生：同 run 同序同 id', async () => {
  const first = manager()
  const second = manager()
  const firstIds = [
    await first.sessions.open('run-7', 0),
    await first.sessions.open('run-7', 0),
    await first.sessions.open('run-7', 0),
  ]
  const secondIds = [
    await second.sessions.open('run-7', 0),
    await second.sessions.open('run-7', 0),
    await second.sessions.open('run-7', 0),
  ]
  assert.deepEqual(firstIds, secondIds)
  assert.equal(new Set(firstIds).size, 3)
  assert.ok(firstIds[0].startsWith('run-7~'))
})

test('open 后的会话可 get / touch；状态在同一引擎实例上保持', async () => {
  const { sessions, engines } = manager()
  const id = await sessions.open('run-1', 0)
  const record = sessions.get(id, 10)
  assert.equal(record.engine, engines[0])
  sessions.touch(id, 20)
  assert.equal(sessions.size, 1)
})

test('空闲超 TTL 自动回收：会话失效且引擎被关闭', async () => {
  const { sessions, engines } = manager({ idleMs: 1000 })
  const id = await sessions.open('run-1', 0)
  sessions.touch(id, 900)
  assert.throws(() => sessions.get(id, 1901), (err) => err instanceof ToolError && err.code === 'session_not_found')
  assert.equal(sessions.size, 0)
  assert.equal(engines[0].state.closed, true)
})

test('close 显式关；再次引用回 session_not_found', async () => {
  const { sessions, engines } = manager()
  const id = await sessions.open('run-1', 0)
  assert.equal(await sessions.close(id, 1), true)
  assert.equal(engines[0].state.closed, true)
  assert.throws(() => sessions.get(id, 1), (err) => err.code === 'session_not_found')
  await assert.rejects(() => sessions.close(id, 1), (err) => err.code === 'session_not_found')
})

test('closeAll 关闭全部在册会话', async () => {
  const { sessions, engines } = manager()
  await sessions.open('run-1', 0)
  await sessions.open('run-1', 0)
  await sessions.closeAll()
  assert.equal(sessions.size, 0)
  assert.ok(engines.every((engine) => engine.state.closed))
})

test('closeAll 等在途 open 落地：引擎被关闭，open 被拒（不泄漏建引擎途中的浏览器）', async () => {
  const engines = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const sessions = new SessionManager(
    async () => {
      await gate
      const engine = makeFakeEngine()
      engines.push(engine)
      return engine
    },
    BASE_CONFIG,
    1000,
  )
  const opening = sessions.open('run-1', 0)
  const closing = sessions.closeAll()
  release()
  await assert.rejects(() => opening, (err) => err.code === 'tool_failed')
  await closing
  assert.equal(sessions.size, 0)
  assert.equal(engines.length, 1)
  assert.equal(engines[0].state.closed, true, '在途引擎应由 closeAll 关闭')
})

test('closeAll 之后 open 立即拒绝，不再造引擎', async () => {
  const { sessions, engines } = manager()
  await sessions.closeAll()
  await assert.rejects(() => sessions.open('run-1', 0), (err) => err.code === 'tool_failed')
  assert.equal(engines.length, 0)
})

test('killAllSync 硬杀兜底：同步 kill 全部会话并清空（exit / 信号用）', async () => {
  const { sessions, engines } = manager()
  await sessions.open('run-1', 0)
  await sessions.open('run-1', 0)
  sessions.killAllSync()
  assert.equal(sessions.size, 0)
  assert.ok(engines.every((engine) => engine.state.killed), '每个引擎都应收到同步 kill')
  assert.ok(engines.every((engine) => !engine.state.closed), '硬杀路径不应走异步 close')
})

test('killAllSync 触达在途建引擎：登记的浏览器子进程被同步 kill，落地引擎不入册且被补杀', async () => {
  const engine = makeFakeEngine()
  const killed = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const sessions = new SessionManager(
    async (_config, handle) => {
      // 模拟工厂在 spawn 浏览器后登记同步硬杀句柄（真实实现见 engine/cdp.ts）。
      handle.register({ kill: () => killed.push('child') })
      await gate
      return engine
    },
    BASE_CONFIG,
    1000,
  )
  const opening = sessions.open('run-1', 0)
  sessions.killAllSync()
  assert.deepEqual(killed, ['child'], '在途浏览器子进程应由 killAllSync 同步 kill')
  release()
  await assert.rejects(() => opening, (err) => err.code === 'tool_failed')
  assert.equal(sessions.size, 0)
  assert.equal(engine.state.killed, true, '落地引擎应被 abort 分支补杀，不登记进会话表')
})

test('未知会话 get 回 session_not_found', () => {
  const { sessions } = manager()
  assert.throws(() => sessions.get('nope', 0), (err) => err.code === 'session_not_found')
})
