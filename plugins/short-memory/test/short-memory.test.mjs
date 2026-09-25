// `short-memory` 包形状 + 服务协议级测试（node --test）。
// 覆盖：声明字段 / 服务自述；read / read_session / read_workspace / apply 往返；世界不再新增世代；
// 边跑边追加与幂等；中断残留可辨（store 级）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ShortMemoryStore } from '../execute/persist.ts'
import { startService } from './driver.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))
const AT = new Date(1_700_000_000_000).toISOString()

test('plugin.json 字段齐全且形态合法（durable + 独占 data）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(
    Object.keys(decl).sort(),
    ['commands', 'exclusive', 'health', 'identity', 'implements', 'members', 'methods', 'pins', 'protocol', 'restart', 'schema', 'start', 'state'].sort(),
  )
  assert.equal(decl.identity, 'short-memory')
  assert.deepEqual(decl.implements, ['short-memory'])
  assert.deepEqual(decl.methods, { 'short-memory': ['read', 'read_session', 'read_workspace', 'apply', 'pending'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.state, 'durable')
  assert.deepEqual(decl.exclusive, ['data'])
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'schema', path: 'schema/' },
  ])
})

test('execute/ 不 import 宿主 / 内核 / client；README 不含计划编号', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const file of ['frames.ts', 'main.ts', 'methods.ts', 'persist.ts', 'plan.ts', 'types.ts']) {
    assert.equal(forbidden.test(readText(join('execute', file))), false, `${file} 出现宿主 / 内核 / client 引用`)
  }
  assert.equal(/#\d/.test(readText('README.md')), false, 'README 含计划编号样式')
})

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'short-memory')
    assert.deepEqual(manifest.implements, ['short-memory'])
    assert.equal(manifest.state, 'durable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('apply / read 往返：L1 与 L2 分别落位；不产世界写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const applied = await drv.call('apply', {
      set_sessions: { 'c-1': { summary: { goal: 'g', facts: ['f'] }, at: AT } },
      set_workspaces: { 'w-1': { summary: { goal: 'wg', facts: ['wf'] }, sources: ['c-1'], at: AT } },
    })
    assert.equal(applied.value.ok, true)
    assert.equal(applied.value.$directives, undefined)

    const body = await drv.call('read', {})
    assert.equal(body.value.sessions['c-1'].summary.goal, 'g')
    assert.equal(body.value.workspaces['w-1'].summary.goal, 'wg')

    const session = await drv.call('read_session', { id: 'c-1' })
    assert.equal(session.value.record.summary.goal, 'g')
    const workspace = await drv.call('read_workspace', { id: 'w-1' })
    assert.equal(workspace.value.record.sources[0], 'c-1')
    assert.equal((await drv.call('read_session', { id: 'missing' })).value.record, null)
  } finally {
    drv.close()
  }
})

test('apply：删除键、重复写幂等', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const args = { set_sessions: { 'c-1': { summary: { facts: ['f'] }, at: AT } } }
    await drv.call('apply', args)
    const first = await drv.call('read', {})
    await drv.call('apply', args)
    const second = await drv.call('read', {})
    assert.deepEqual(second.value, first.value)

    await drv.call('apply', { del_sessions: ['c-1'] })
    assert.equal((await drv.call('read', {})).value.sessions['c-1'], undefined)
  } finally {
    drv.close()
  }
})

test('边跑边追加 + 中断残留可辨（store 级）', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sm-data-'))
  try {
    const store = ShortMemoryStore.open({ CHRONO_PLUGIN_DATA: dataDir })
    store.turnOpen('run-1')
    store.setL1('run-1', 'c-1', { summary: { facts: ['f'] }, at: AT })
    // 未 turnClose：中断残留应可辨
    assert.deepEqual(store.pendingTurns(), ['run-1'])
    store.turnClose('run-1')
    assert.deepEqual(store.pendingTurns(), [])

    // 重开：从 ④ 重放得到同一状态
    const reopened = ShortMemoryStore.open({ CHRONO_PLUGIN_DATA: dataDir })
    assert.equal(reopened.sessionOf('c-1').summary.facts[0], 'f')
    assert.deepEqual(reopened.pendingTurns(), [])
    const log = readFileSync(join(dataDir, 'short-memory.jsonl'), 'utf8')
    assert.ok(log.includes('"t":"l1"'))
    assert.ok(log.includes('"state":"closed"'))
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('形态非法 / 未知方法 → 结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call('read_session', {})).code, 'bad_args')
    assert.equal((await drv.call('apply', { set_sessions: 'nope' })).code, 'bad_args')
    assert.equal((await drv.request('call', { port: 'short-memory', method: 'nope', args: {} }, 'error')).code, 'unknown_method')
    assert.equal((await drv.request('call', { port: 'other', method: 'read', args: {} }, 'error')).code, 'unresolved_cap')
  } finally {
    drv.close()
  }
})
