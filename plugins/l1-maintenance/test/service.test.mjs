// `l1-maintenance` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到内存假 owner。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const NOW = Date.parse('2023-11-14T00:00:00.000Z')
const AT = new Date(NOW).toISOString()
const FIXED_ENV = { run: 'run-1', thread: 't1', now: NOW }

function sessionsFixture() {
  return {
    version: 1,
    sessions: {
      'c-2': {
        summary: { goal: 'G2', facts: [] },
        at: '2099-01-01T00:00:00.000Z',
        expires_at: '2099-01-02T00:00:00.000Z',
      },
      'c-1': {
        summary: { goal: 'G1', facts: ['f1'] },
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
      'c-3': { summary: { goal: 'G3', facts: [] }, at: '2020-01-01T00:00:00.000Z' },
    },
  }
}

function fakeShortMemory(initial) {
  const memory = structuredClone(initial)
  return {
    memory,
    read: () => structuredClone(memory),
    apply: (args) => {
      for (const id of args?.del_sessions ?? []) delete memory.sessions[id]
      return { ok: true, changed: 1 }
    },
  }
}

function drive({ shortMemory = fakeShortMemory(sessionsFixture()) } = {}) {
  const drv = startService({
    entry: ENTRY,
    cwd: PKG_ROOT,
    onPortCall: (message) => {
      if (message.port === 'short-memory' && message.method === 'read')
        return { ok: true, value: shortMemory.read() }
      if (message.port === 'short-memory' && message.method === 'apply')
        return { ok: true, value: shortMemory.apply(message.args ?? {}) }
      if (message.port === 'session' && message.method === 'read')
        return { ok: true, value: { version: 1, current: 'c-1', conversations: [] } }
      return { ok: false, code: 'not_ready', message: 'no resolver' }
    },
  })
  return {
    ...drv,
    ...shortMemory,
    hello: () => drv.hello('l1-maintenance'),
    call: (method, args, env = FIXED_ENV) => drv.call('l1-maintenance', method, args, env),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'l1-maintenance')
    assert.deepEqual(manifest.implements, ['l1-maintenance'])
    assert.deepEqual(manifest.methods['l1-maintenance'], ['sweep', 'candidates', 'view'])
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('sweep：删到期会话（expires_at 与 at + TTL 两路），写 short-memory', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('sweep', {})
    assert.equal(result.kind, 'result')
    assert.deepEqual(result.value.l1_deleted, ['c-1', 'c-3'])
    assert.deepEqual(Object.keys(drv.memory.sessions), ['c-2'])
    assert.ok(
      drv.portCalls.some((frame) => frame.port === 'short-memory' && frame.method === 'apply'),
    )
  } finally {
    drv.close()
  }
})

test('sweep：空删除集不产生写', async () => {
  const drv = drive({
    shortMemory: fakeShortMemory({
      version: 1,
      sessions: { 'c-9': { at: AT, expires_at: '2099-01-01T00:00:00.000Z' } },
    }),
  })
  try {
    await drv.hello()
    const result = await drv.call('sweep', {})
    assert.deepEqual(result.value.l1_deleted, [])
    assert.equal(
      drv.portCalls.some((frame) => frame.port === 'short-memory' && frame.method === 'apply'),
      false,
    )
  } finally {
    drv.close()
  }
})

test('candidates：只读回过期候选，不写、不删', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('candidates', {})
    assert.equal(result.value.kind, 'candidates')
    assert.deepEqual(
      result.value.candidates.map((item) => item.id),
      ['c-1', 'c-3'],
    )
    assert.equal(result.value.candidates[0].reason, 'l1_expired')
    assert.equal(
      drv.portCalls.some((frame) => frame.port === 'short-memory' && frame.method === 'apply'),
      false,
    )
  } finally {
    drv.close()
  }
})

test('view：L1 一档字段齐全（含剩余 TTL）', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const result = await drv.call('view', {})
    assert.equal(result.value.kind, 'view')
    assert.deepEqual(
      result.value.l1.map((item) => item.id),
      ['c-1', 'c-2', 'c-3'],
    )
    assert.equal(result.value.l1[0].ttl_remaining_ms, 0)
    assert.equal(typeof result.value.l1[0].summary.goal, 'string')
    assert.equal(result.value.l1[1].expires_at, '2099-01-02T00:00:00.000Z')
  } finally {
    drv.close()
  }
})

test('l1_ttl_ms 覆盖：非法值回 bad_args；未知方法 / 能力类回结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('sweep', { l1_ttl_ms: -1 })).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'l1-maintenance', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'view', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
