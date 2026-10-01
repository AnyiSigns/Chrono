// `guard` 服务协议级测试（node --test）：自实现最小协议驱动。
// judge 判定已整迁 term（plugin.json.judgments），语义测试住宿主侧 tests/contract/guard-judgment.contract.test.mjs；
// 本文件只测服务剩下的取数面（facts / collect）与协议控制帧。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService as startSdkService } from 'plugin-sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

function startService() {
  const drv = startSdkService({ entry: ENTRY, cwd: PKG_ROOT })
  return {
    child: drv.child,
    exit: drv.exit,
    request: drv.request,
    hello: () => drv.hello('guard'),
    facts: (args) => drv.call('guard', 'facts', args, { run: null, thread: null, now: 0 }),
    collect: (args) => drv.call('guard', 'collect', args, { run: null, thread: null, now: 0 }),
    close: () => drv.close(),
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'guard')
    assert.deepEqual(manifest.implements, ['guard'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.deepEqual(manifest.methods.guard, ['judge', 'facts', 'collect'])
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong / stdin EOF 自退出', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

// ── facts：取数（不含裁决） ─────────────────────────────────────────────────

test('facts：逐 call 出命中事实，不含 verdict / reason 裁决字段', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const reply = await drv.facts({
      bag: {
        calls: [{ port: 'tool-fs', tool: 'read', path: '/repo/a.txt' }],
        tier: 'severe',
        workspace_root: '/repo',
      },
    })
    assert.equal(reply.kind, 'result')
    const call = reply.value.calls[0]
    assert.equal(call.index, 0)
    assert.equal(call.port, 'tool-fs')
    assert.equal(call.tool, 'read')
    assert.equal(call.invalid, false)
    assert.equal(call.forbidden, false)
    assert.equal(call.portAllowed, true)
    assert.equal(call.structural.matched, false)
    assert.equal(call.mcp.isMcp, false)
    assert.equal(call.danger.matched, false)
    assert.equal(call.allow.matched, false)
    assert.equal(call.outside.matched, false)
    assert.equal(call.net.matched, false)
    assert.equal(call.policy.outside, true)
    assert.equal(call.verdict, undefined)
    assert.equal(call.reason, undefined)
  } finally {
    drv.close()
  }
})

test('facts：危险模式按词元边界命中，裸子串不再误报', async () => {
  const drv = startService()
  const shellCall = (input) => ({ port: 'tool-shell', tool: 'shell', args: { input } })
  try {
    await drv.hello()
    // 误报回归：`Format-Table` 含 `rm`、`-Recurse` 含 `-r`，加边界后不得判成 recursive_delete。
    const benign = await drv.facts({
      bag: {
        calls: [shellCall("Get-ChildItem -Recurse | Format-Table -AutoSize")],
      },
    })
    assert.equal(benign.value.calls[0].danger.matched, false)
    // 真危险仍命中。
    const dangerous = await drv.facts({
      bag: { calls: [shellCall('Remove-Item -Recurse ./build')] },
    })
    assert.equal(dangerous.value.calls[0].danger.matched, true)
    assert.equal(dangerous.value.calls[0].danger.rule, 'recursive_delete')
  } finally {
    drv.close()
  }
})

test('facts：bag 非对象 / calls 非数组 → bad_args，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const nonObject = await drv.facts({ bag: 'x' })
    assert.equal(nonObject.kind, 'error')
    assert.equal(nonObject.code, 'bad_args')
    const badCalls = await drv.facts({ bag: { calls: 'nope' } })
    assert.equal(badCalls.kind, 'error')
    assert.equal(badCalls.code, 'bad_args')
  } finally {
    drv.close()
  }
})

// ── collect：cons 链 → 数组（机械，不裁决） ─────────────────────────────────

test('collect：把 {head, tail} / null 材料化为有序数组', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const empty = await drv.collect({ list: null })
    assert.deepEqual(empty.value, { decisions: [] })
    const list = {
      head: { index: 1, port: 'b', tool: 'b', verdict: 'allow', reason: 'allowed' },
      tail: { head: { index: 0, port: 'a', tool: 'a', verdict: 'deny', reason: 'bad_call' }, tail: null },
    }
    const reply = await drv.collect({ list })
    assert.deepEqual(
      reply.value.decisions.map((decision) => decision.index),
      [0, 1],
    )
  } finally {
    drv.close()
  }
})

test('未知方法 → unknown_method', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const unknownMethod = await drv.request('call', { port: 'guard', method: 'nope', args: {} }, 'error')
    assert.equal(unknownMethod.code, 'unknown_method')
  } finally {
    drv.close()
  }
})

test('execute/ 无 judge 运行时实现，terms/ 判定产物随包', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'execute', 'judge.ts')), false)
  assert.ok(existsSync(join(PKG_ROOT, 'terms', 'guard.json')))
})
