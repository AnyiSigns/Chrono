// content 分层两条例外的专项测试。
// - 超大用户粘贴：全文由 session 保存，上下文投影逐层（含 T0 本轮）给首尾 + 句柄 + 显式标记；
//   阈值可由 `bag.thresholds.oversized_user_chars` 覆盖；非超大用户消息逐字。
// - 系统错误（`meta.error`）：T0 逐字、T1 一行、T2+ 蒸馏进检查点 `errors_to_avoid`；配对不变量保持。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, contentOf, startService, ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { setLocalCountProvider } = await import('../execute/tokens.ts')
const { countText } = await import('./fakes.mjs')
setLocalCountProvider((text) => countText(text))

const { canonicalize } = await import('../execute/normalize.ts')
const { applyRetention } = await import('../execute/retention.ts')

function raw(overrides) {
  return {
    role: 'user',
    parts: [{ type: 'text', text: 'x' }],
    source: 'history',
    priority: 4,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint: 0,
    ...overrides,
  }
}

const OPTIONS = {
  distances: new Map([
    ['t-new', 0],
    ['t-recent', 1],
    ['t-mid', 2],
    ['t-stale', 6],
  ]),
  callStep: new Map(),
  recentTurns: 3,
  largeArtifactBytes: 0,
  oversizedUserChars: 100,
  scale: 1,
  errorLine: '系统错误：{error}',
}

// ── 超大用户粘贴 ───────────────────────────────────────────────────────────

test('超大粘贴：T0 / T1 / T2 逐层给首尾 + 句柄，显式标记；非超大逐字', () => {
  const messages = canonicalize([
    raw({ role: 'user', source: 'input', priority: 0, parts: [{ type: 'text', text: 'T0'.repeat(200) }] }),
    raw({ role: 'user', turnId: 't-recent', orderHint: 1, parts: [{ type: 'text', text: 'T1'.repeat(200) }] }),
    raw({ role: 'user', turnId: 't-stale', orderHint: 2, parts: [{ type: 'text', text: 'T2'.repeat(200) }] }),
    raw({ role: 'user', turnId: 't-recent', orderHint: 3, parts: [{ type: 'text', text: '短消息' }] }),
  ])
  const result = applyRetention(messages, OPTIONS)
  assert.ok(result.degraded.includes('trim_oversized_user'))

  const users = result.messages.filter((message) => message.role === 'user')
  const envelopes = users
    .map((message) => message.parts[0].text)
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text))
  assert.equal(envelopes.length, 3, 'T0 / T1 / T2 三层的超大粘贴都应裁剪')
  for (const envelope of envelopes) {
    assert.equal(envelope.aged, true)
    assert.ok(String(envelope.handle).startsWith('h-'), '须带可还原句柄')
    assert.ok(envelope.omitted_chars > 0, '须记省略码点数')
    assert.ok(typeof envelope.head === 'string' && envelope.head.length > 0)
    assert.ok(typeof envelope.tail === 'string' && envelope.tail.length > 0)
  }
  assert.ok(users.some((message) => message.parts[0].text === '短消息'), '非超大用户消息逐字保留')

  // 确定性：同输入同句柄
  const again = applyRetention(messages, OPTIONS)
  const handles = (out) => out.messages.filter((m) => m.role === 'user').map((m) => m.parts[0].text)
  assert.deepEqual(handles(again), handles(result))
})

test('超大粘贴：关闭阈值（0）时用户消息逐字', () => {
  const messages = canonicalize([raw({ role: 'user', source: 'input', priority: 0, parts: [{ type: 'text', text: 'Y'.repeat(400) }] })])
  const result = applyRetention(messages, { ...OPTIONS, oversizedUserChars: 0 })
  assert.equal(result.messages[0].parts[0].text, 'Y'.repeat(400))
  assert.equal(result.degraded.includes('trim_oversized_user'), false)
})

test('超大粘贴（协议级）：bag.thresholds 覆盖阈值，本轮超阈值即裁剪、否则逐字', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const clipped = await drv.build(
      baseBag({ input: 'p'.repeat(500), thresholds: { oversized_user_chars: 100 } }),
    )
    const envelope = JSON.parse(contentOf(clipped.messages[clipped.messages.length - 1]))
    assert.equal(envelope.kind, 'user_paste')
    assert.ok(envelope.handle.startsWith('h-'))
    assert.ok(envelope.omitted_chars > 0)

    const verbatim = await drv.build(baseBag({ input: 'hi' }))
    assert.equal(contentOf(verbatim.messages[verbatim.messages.length - 1]), 'hi')
  } finally {
    drv.close()
  }
})

// ── 系统错误分层 ───────────────────────────────────────────────────────────

test('工具错误（ok:false）逐字回灌；配对不破（步日志口径）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = {
      turns: [
        {
          turn_id: 'a',
          conv: 'c1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'settled',
          user_message: { content: 'A-USER' },
          steps: [
            { type: 'step.result', turn_id: 'a', seq: 6, assistant: { content: 'A-ASSIST' }, tool_results: [] },
          ],
        },
        {
          turn_id: 'b',
          conv: 'c1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'open',
          user_message: { content: 'B-USER' },
          steps: [
            { type: 'step.intent', turn_id: 'b', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c9', name: 'read', arguments: { path: 'a' } }] },
            { type: 'step.result', turn_id: 'b', seq: 1, assistant: { content: '' }, tool_results: [{ call_id: 'c9', ok: false, error: 'CERR 首行\nCERR 次行' }] },
          ],
        },
      ],
    }
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const texts = value.messages.map(contentOf)
    const joined = texts.join('\n')

    // 往期会话记录照常逐条回灌（不再有检查点覆盖）。
    assert.ok(texts.includes('A-USER'))
    assert.ok(texts.includes('A-ASSIST'))

    // T0 工具错误逐字（模型需要知道失败原因与配对）。
    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c9')
    assert.ok(tool !== undefined, '工具错误记录须回灌')
    assert.ok(joined.includes('CERR 首行'), '工具错误逐字保留')
    assert.equal(JSON.parse(contentOf(tool)).ok, false)

    // 配对不变量：每个 tool_call 都有配对结果。
    for (let index = 0; index < value.messages.length; index += 1) {
      const calls = Array.isArray(value.messages[index].tool_calls) ? value.messages[index].tool_calls : []
      for (const call of calls) {
        const paired = value.messages
          .slice(index + 1)
          .some((message) => message.role === 'tool' && message.tool_call_id === call.id)
        assert.equal(paired, true, `call ${call.id} 须有配对结果`)
      }
    }
  } finally {
    drv.close()
  }
})

test('系统错误分层（单元）：T2 回落一行，T0 逐字', () => {
  const messages = canonicalize([
    raw({ role: 'system', turnId: 't-new', orderHint: 0, parts: [{ type: 'text', text: 'NEW 首\nNEW 次' }], error: 'NEW 首\nNEW 次' }),
    raw({ role: 'system', turnId: 't-stale', orderHint: 1, parts: [{ type: 'text', text: 'OLD 首\nOLD 次' }], error: 'OLD 首\nOLD 次' }),
  ])
  const result = applyRetention(messages, OPTIONS)
  const texts = result.messages.map((message) => message.parts[0].text)
  assert.ok(texts.includes('NEW 首\nNEW 次'), 'T0 逐字')
  assert.ok(texts.includes('系统错误：OLD 首'), 'T2 回落一行')
  assert.ok(!texts.some((text) => text.includes('OLD 次')), '一行蒸馏不得含次行')
  assert.ok(result.degraded.includes('error_line'))
})
