// 分层保留与替代去重的单元测试（直接 import execute 源码）。
// 覆盖：等级判定（T0/T1/T2/T3）、T1 摘要 + 句柄、T2 结果丢弃、替代去重塌缩较早读取、
// 资源身份推导、digest 取提供方或确定回落、压缩失败回落机械老化不硬死。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { canonicalize } = await import('../execute/normalize.ts')
const { applyRetention, tierOf, compressText } = await import('../execute/retention.ts')
const { dedupe } = await import('../execute/stages.ts')
const { resourceIdentity, isMutableResult, digestOf } = await import('../execute/digest.ts')
const { allocate } = await import('../execute/budget.ts')
const { defaultPolicy } = await import('../execute/policy.ts')

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

function toolRaw({ turnId, callId, tool, args, result, ok = true, orderHint = 0, step }) {
  return raw({
    role: 'tool',
    source: 'history',
    toolCallId: callId,
    turnId,
    step,
    orderHint,
    parts: [{ type: 'text', text: JSON.stringify({ call_id: callId, ok, result }) }],
    toolResult: { tool, args, verbatim: JSON.stringify({ call_id: callId, ok, result }) },
  })
}

const OPTIONS = {
  distances: new Map([
    ['t-new', 0],
    ['t-recent', 1],
    ['t-mid', 2],
    ['t-stale', 6],
  ]),
  coveredTurnIds: new Set(['t-covered']),
  callStep: new Map(),
  recentTurns: 3,
  t2TextChars: 40,
  largeArtifactBytes: 0,
}

test('等级判定：T0 当前回合 / T1 近期 / T2 陈旧 / T3 检查点覆盖；非历史恒 T0', () => {
  const messages = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0 }),
    raw({ turnId: 't-new', orderHint: 1 }),
    raw({ turnId: 't-recent', orderHint: 2 }),
    raw({ turnId: 't-mid', orderHint: 3 }),
    raw({ turnId: 't-stale', orderHint: 4 }),
    raw({ turnId: 't-covered', orderHint: 5 }),
    raw({ turnId: null, orderHint: 6 }),
  ])
  assert.deepEqual(messages.map((message) => tierOf(message, OPTIONS)), ['T0', 'T0', 'T1', 'T1', 'T2', 'T3', 'T1'])
  const result = applyRetention(messages, OPTIONS)
  assert.deepEqual(result.counts, { T0: 2, T1: 3, T2: 1, T3: 1 })
  assert.equal(result.dropped, 1)
  assert.ok(result.degraded.includes('checkpoint_covered_turns'))
})

test('C6：非历史来源即使 covered=true 也落 T0，不被 T3 覆盖裁剪移除', () => {
  const options = { ...OPTIONS, coveredTurnIds: new Set(['t-new']) }
  const messages = canonicalize([
    raw({ source: 'tool', turnId: 't-new', covered: true, priority: 4, orderHint: 0 }),
  ])
  assert.equal(tierOf(messages[0], options), 'T0')
  const result = applyRetention(messages, options)
  assert.equal(result.dropped, 0)
  assert.equal(result.messages.length, 1)
  assert.deepEqual(result.counts, { T0: 1, T1: 0, T2: 0, T3: 0 })
})

test('T1：工具结果 → 摘要 + 句柄（提供方 digest 原样带出，缺失按形状回落）', () => {
  const messages = canonicalize([
    toolRaw({
      turnId: 't-recent',
      callId: 'c1',
      tool: 'read',
      args: { path: 'src/a.ts' },
      result: { text: 'line\n'.repeat(120), lines_returned: 120 },
    }),
  ])
  const result = applyRetention(messages, OPTIONS)
  assert.equal(result.counts.T1, 1)
  const aged = JSON.parse(result.messages[0].parts[0].text)
  assert.equal(aged.aged, true)
  assert.equal(aged.dropped, undefined)
  assert.equal(aged.tool, 'read')
  assert.equal(aged.path, 'src/a.ts')
  assert.equal(aged.count, 120)
  assert.ok(String(aged.summary).includes('120 行'))
  assert.ok(String(aged.handle).startsWith('h-'))
  assert.ok(typeof aged.tail === 'string' && aged.tail.length <= 160)
})

test('T2：工具结果只留句柄（结果丢弃、句柄保留），助手正文压缩、推理丢弃', () => {
  const messages = canonicalize([
    toolRaw({
      turnId: 't-stale',
      callId: 'c1',
      tool: 'read',
      args: { path: 'src/old.ts' },
      result: { text: 'z '.repeat(300), lines_returned: 300 },
    }),
    raw({
      role: 'assistant',
      turnId: 't-stale',
      orderHint: 1,
      parts: [{ type: 'text', text: '很长的散文正文\n第二行不该出现' }],
      reasoning: { provider: '', model: 'm', form: 'text', payload: '思考', signature: '', encrypted: '', tokens: 0 },
    }),
  ])
  const result = applyRetention(messages, OPTIONS)
  const tool = result.messages.find((message) => message.role === 'tool')
  const dropped = JSON.parse(tool.parts[0].text)
  assert.equal(dropped.dropped, true)
  assert.equal(dropped.path, 'src/old.ts')
  assert.ok(String(dropped.handle).startsWith('h-'))
  assert.equal(dropped.tail, undefined)
  assert.equal(dropped.summary, undefined)

  const assistant = result.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.parts[0].text, compressText('很长的散文正文\n第二行不该出现', 40))
  assert.equal(assistant.parts[0].text.includes('\n'), false)
  assert.equal(assistant.reasoning, null)
  assert.ok(result.degraded.includes('tier2_compress'))
})

test('替代去重：同一 (工具, 资源身份) 只留最后一份完整内容，早前塌成「已被第 N 步替代」', () => {
  const options = { ...OPTIONS, callStep: new Map([['c1', 3], ['c2', 17]]) }
  const messages = canonicalize([
    toolRaw({ turnId: 't-recent', callId: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'OLD'.repeat(50), lines_returned: 50 }, orderHint: 0 }),
    toolRaw({ turnId: 't-recent', callId: 'c2', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'NEW'.repeat(50), lines_returned: 50 }, orderHint: 1 }),
  ])
  const result = applyRetention(messages, options)
  assert.equal(result.replaced, 1)
  assert.ok(result.degraded.includes('replacement_dedupe'))
  const [first, second] = result.messages
  const collapsed = JSON.parse(first.parts[0].text)
  assert.equal(collapsed.replaced, true)
  assert.equal(collapsed.path, 'src/a.ts')
  assert.equal(collapsed.replaced_by_step, 17)
  const kept = JSON.parse(second.parts[0].text)
  assert.equal(kept.aged, true)
  assert.equal(kept.replaced, undefined)
})

test('替代去重：变更类结果不塌缩（改写历史会丢事实）', () => {
  const messages = canonicalize([
    toolRaw({ turnId: 't-recent', callId: 'c1', tool: 'edit', args: { path: 'src/a.ts' }, result: { bytes_written: 10, patch: '-a\n+b' }, orderHint: 0 }),
    toolRaw({ turnId: 't-recent', callId: 'c2', tool: 'edit', args: { path: 'src/a.ts' }, result: { bytes_written: 20, patch: '-b\n+c' }, orderHint: 1 }),
  ])
  const result = applyRetention(messages, OPTIONS)
  assert.equal(result.replaced, 0)
  assert.equal(result.messages.length, 2)
})

test('替代去重：只作用于历史，同回合工作集（source=tool）不塌缩', () => {
  const messages = canonicalize([
    toolRaw({ turnId: null, callId: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'OLD'.repeat(50), lines_returned: 50 }, orderHint: 0 }),
    toolRaw({ turnId: null, callId: 'c2', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'NEW'.repeat(50), lines_returned: 50 }, orderHint: 1 }),
  ]).map((message) => ({ ...message, source: 'tool' }))
  const result = applyRetention(messages, OPTIONS)
  assert.equal(result.replaced, 0)
  assert.equal(result.messages.length, 2)
  for (const message of result.messages) {
    assert.equal(JSON.parse(message.parts[0].text).replaced, undefined)
  }
})

test('第 2 步去重：正文一致的工具结果不互相删除（避免配对修复补 interrupted）', () => {
  const content = JSON.stringify({ call_id: 'c', ok: true, result: { text: 'SAME' } })
  const messages = canonicalize([
    raw({ role: 'tool', source: 'tool', toolCallId: 'c1', parts: [{ type: 'text', text: content }], orderHint: 0 }),
    raw({ role: 'tool', source: 'tool', toolCallId: 'c2', parts: [{ type: 'text', text: content }], orderHint: 1 }),
  ])
  const result = dedupe(messages)
  assert.equal(result.messages.length, 2)
  assert.equal(result.deduped, 0)
})

test('资源身份：path / url / cmd+cwd / pattern+base 各自成键；无资源概念返回 null', () => {
  assert.equal(resourceIdentity('read', { path: 'a.ts' }).key, 'read\u0001path\u0001a.ts')
  assert.equal(
    resourceIdentity('read', { path: 'a.ts', offset: 240, limit: 240 }).key,
    'read\u0001path\u0001a.ts\u0001offset=240\u0001limit=240',
  )
  assert.notEqual(
    resourceIdentity('read', { path: 'a.ts', offset: 0 }).key,
    resourceIdentity('read', { path: 'a.ts', offset: 240 }).key,
  )
  assert.equal(resourceIdentity('http', { url: 'https://x' }).key, 'http\u0001url\u0001https://x')
  assert.deepEqual(resourceIdentity('shell', { cmd: 'ls', cwd: '/w' }).fields, { cmd: 'ls', cwd: '/w' })
  assert.equal(resourceIdentity('shell', { cmd: 'ls', cwd: '/w' }).key, 'shell\u0001cmd\u0001ls\u0001/w')
  assert.equal(resourceIdentity('grep', { pattern: 'foo', path: 'src' }).key, 'grep\u0001pattern\u0001foo\u0001src')
  assert.equal(resourceIdentity('noop', { free: 'x' }), null)
  assert.equal(isMutableResult('edit', { bytes_written: 1 }, true), true)
  assert.equal(isMutableResult('read', { text: 'x' }, true), false)
})

test('digest：提供方 digest 优先，缺失由形状确定派生', () => {
  const provided = digestOf({ text: 'abc', digest: { lines: 3, sha: 'deadbeef' } }, true)
  assert.deepEqual(provided.provider, { lines: 3, sha: 'deadbeef' })
  const fallback = digestOf({ text: 'abc', total_lines: 7 }, true)
  assert.equal(fallback.provider, null)
  assert.equal(fallback.count, 7)
  const failure = digestOf({ code: 'not_found' }, false)
  assert.equal(failure.summary, 'error: not_found')
})

test('附件分层：T0 原样；T1/T2 历史附件塌成「文本描述 + 句柄」，不再内联', () => {
  const image = { type: 'image', asset: { sha256: 'a'.repeat(64), mime: 'image/png', size: 2048 }, name: 'pic.png' }
  const messages = canonicalize([
    raw({ source: 'input', priority: 0, parts: [{ type: 'text', text: '本轮' }, image] }),
    raw({ turnId: 't-recent', orderHint: 1, parts: [{ type: 'text', text: '近期' }, image] }),
    raw({ turnId: 't-stale', orderHint: 2, parts: [{ type: 'text', text: '陈旧' }, image] }),
  ])
  const result = applyRetention(messages, OPTIONS)
  // T0 本轮：原样保留资产 part
  assert.deepEqual(result.messages[0].parts[1], image)
  // T1 / T2：文本描述 + 句柄
  for (const message of [result.messages[1], result.messages[2]]) {
    assert.equal(message.parts[0].type, 'text')
    assert.equal(message.parts[1].type, 'text')
    const aged = JSON.parse(message.parts[1].text)
    assert.equal(aged.aged, true)
    assert.equal(aged.attachment, 'image')
    assert.equal(aged.name, 'pic.png')
    assert.equal(aged.mime, 'image/png')
    assert.equal(aged.sha256, 'a'.repeat(64))
    assert.equal(aged.bytes, 2048)
    assert.ok(String(aged.handle).startsWith('h-'))
  }
  // 确定性：同输入同句柄
  assert.equal(
    JSON.parse(applyRetention(messages, OPTIONS).messages[1].parts[1].text).handle,
    JSON.parse(result.messages[1].parts[1].text).handle,
  )
  assert.ok(result.degraded.includes('age_attachments'))
})

test('大产物：达到阈值即无论层级以「摘要 + 句柄」表示；未达阈值保持内联', () => {
  const verbatim = JSON.stringify({ ok: true, result: { content: 'z '.repeat(200) } })
  const message = raw({
    role: 'tool',
    source: 'tool',
    priority: 4,
    parts: [{ type: 'text', text: verbatim }],
    toolResult: { tool: 'read', args: { path: 'src/a.ts' }, verbatim },
  })
  const aged = applyRetention(canonicalize([message]), { ...OPTIONS, largeArtifactBytes: 64 })
  const body = JSON.parse(aged.messages[0].parts[0].text)
  assert.equal(body.aged, true)
  assert.equal(body.tool, 'read')
  assert.equal(body.path, 'src/a.ts')
  assert.ok(String(body.handle).startsWith('h-'))
  assert.ok(aged.degraded.includes('age_large_artifacts'))

  const kept = applyRetention(canonicalize([message]), { ...OPTIONS, largeArtifactBytes: 1_000_000 })
  assert.deepEqual(kept.messages[0].parts, [{ type: 'text', text: verbatim }])
  assert.equal(kept.degraded.includes('age_large_artifacts'), false)
})

test('校正系数作用于改写路径：老化后 token 按系数缩放（不因改写丢校准）', () => {
  const messages = canonicalize([
    toolRaw({
      turnId: 't-recent',
      callId: 'c1',
      tool: 'read',
      args: { path: 'src/a.ts' },
      result: { text: 'line\n'.repeat(120), lines_returned: 120 },
    }),
  ])
  const one = applyRetention(messages, { ...OPTIONS, scale: 1 }).messages[0]
  const two = applyRetention(messages, { ...OPTIONS, scale: 2 }).messages[0]
  assert.ok(one.tokens > 0)
  assert.equal(two.tokens, one.tokens * 2)
})

test('压缩梯级：机械老化已压回预算内不登记；仍超才登记 compress / compress_unavailable', () => {
  const policy = defaultPolicy()
  // 可收缩：老化后已回到预算内 → 不登记压缩梯级。
  const verbatim = JSON.stringify({ call_id: 'c1', ok: true, result: { text: 'z '.repeat(400) } })
  const ageable = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'tool',
      source: 'tool',
      toolCallId: 'c1',
      priority: 4,
      parts: [{ type: 'text', text: verbatim }],
      toolResult: { tool: 'read', args: { path: 'a' }, verbatim },
    }),
  ])
  const aged = allocate(ageable, 120, policy)
  assert.equal(aged.error, null)
  assert.ok(aged.degraded.includes('age_tool_results'))
  assert.equal(aged.degraded.includes('compress_unavailable'), false, '老化已压回预算内 → 压缩未发生')

  // 不可收缩：大段历史正文既不能老化也不能丢推理 → 仍超预算才登记压缩梯级；历史整组被裁不硬死。
  const huge = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({ role: 'assistant', source: 'history', priority: 4, parts: [{ type: 'text', text: 'w '.repeat(400) }] }),
  ])
  const fallback = allocate(huge, 120, policy)
  assert.equal(fallback.error, null)
  assert.ok(fallback.degraded.includes('compress_unavailable'))
  assert.ok(fallback.degraded.includes('drop_old_turns'), '历史因预算被裁须登记 drop_old_turns')

  const withCheckpoint = allocate(huge, 120, policy, { checkpoint: true })
  assert.equal(withCheckpoint.error, null)
  assert.ok(withCheckpoint.degraded.includes('compress'))
  assert.equal(withCheckpoint.degraded.includes('compress_unavailable'), false)
})
