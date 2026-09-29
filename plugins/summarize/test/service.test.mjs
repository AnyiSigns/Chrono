// `summarize` 服务协议级测试：spawn `node execute/main.ts`，无反向调用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function drive() {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT })
  return {
    ...drv,
    hello: () => drv.hello('summarize'),
    call: (method, args, env = FIXED_ENV) => drv.call('summarize', method, args, env),
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'summarize')
    assert.deepEqual(manifest.implements, ['summarize'])
    assert.deepEqual(manifest.methods.summarize, [
      'derive',
      'parse',
      'current',
      'sentences',
      'merge',
      'to_l1',
      'to_l2',
    ])
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('derive：结构化字段优先、缺失由切片派生、目标长度截断', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const value = (
      await drv.call('derive', {
        args: { goal: 'G', facts: ['f1', 'f1'] },
        target_length: 100,
        extract_items: 3,
      })
    ).value
    assert.equal(value.summary.goal, 'G')
    assert.deepEqual(value.summary.facts, ['f1'])
    assert.equal(value.summary.next_steps.length, 0)

    const derived = (
      await drv.call('derive', {
        args: { session_slice: [{ role: 'user', content: 'Hello world.' }] },
        target_length: 100,
        extract_items: 3,
      })
    ).value
    assert.equal(derived.summary.goal, 'Hello world.')
    assert.deepEqual(derived.summary.facts, ['Hello world.'])
  } finally {
    drv.close()
  }
})

test('parse / current：解析不截断，current 统一截断', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const record = { goal: 'abcdef', facts: ['12345'], next_steps: ['zz'] }
    const parsed = (await drv.call('parse', { record })).value.summary
    assert.equal(parsed.goal, 'abcdef')
    assert.deepEqual(parsed.facts, ['12345'])
    const current = (await drv.call('current', { record, target_length: 3 })).value.summary
    assert.equal(current.goal, 'abc')
    assert.deepEqual(current.facts, ['123'])
    assert.deepEqual(current.next_steps, ['zz'])
  } finally {
    drv.close()
  }
})

test('sentences：从切片按句派生、去重、截断、取前 limit 条', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const value = (
      await drv.call('sentences', {
        session_slice: [{ role: 'user', content: 'Alpha one. Beta two. Gamma three.' }],
        limit: 2,
        target_length: 100,
      })
    ).value
    assert.deepEqual(value.sentences, ['Alpha one.', 'Beta two.'])
  } finally {
    drv.close()
  }
})

test('merge / to_l1 / to_l2：拼接去重结果、写出两种形状', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const merged = (
      await drv.call('merge', {
        existing: { goal: 'old', facts: ['a'] },
        incoming: { goal: 'new', facts: ['b'] },
        outcomes: { facts: { accepted: ['b'], dedup: 'vector' } },
      })
    ).value
    assert.equal(merged.summary.goal, 'new')
    assert.deepEqual(merged.summary.facts, ['a', 'b'])
    assert.equal(merged.dedup, 'vector')

    const l1 = (await drv.call('to_l1', { summary: { goal: 'g', next_steps: ['n'] } })).value.record
    assert.deepEqual(l1.next_steps, ['n'])
    const l2 = (await drv.call('to_l2', { summary: { goal: 'g', next_steps: ['n'] } })).value.record
    assert.equal(l2.next_steps, undefined)
  } finally {
    drv.close()
  }
})

test('形态非法 → bad_args；未知方法 / 能力类 → 结构化 error', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('derive', { args: {}, extract_items: 3 })).code, 'bad_args')
    assert.equal(
      (await drv.call('derive', { args: {}, target_length: 0, extract_items: 3 })).code,
      'bad_args',
    )
    assert.equal((await drv.call('current', { record: {}, target_length: 'x' })).code, 'bad_args')
    assert.equal((await drv.call('derive', null)).code, 'bad_args')
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'summarize', method: 'nope', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unknown_method',
    )
    assert.equal(
      (
        await drv.request(
          'call',
          { port: 'other', method: 'derive', args: {}, env: FIXED_ENV },
          'error',
        )
      ).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})
