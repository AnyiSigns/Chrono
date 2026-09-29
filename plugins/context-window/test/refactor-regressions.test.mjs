// 上下文投影重构的回归测试（R1 / R2 / C4 / C5 / C6）。
// R1：本轮回合用户消息不投影（`bag.input` 权威），本轮其余记录 source='tool'（排 input 之后、保留 T0）；
//     本轮超大输入走专属截断路径且不重复。
// R2：携带 toolCalls 的 assistant 帧不去重（否则同批次工调塌缩、结果变孤儿）。
// C4：只有仍超预算才登记压缩梯级；只有历史组真被裁才登记 drop_old_turns。
// C5：只截断「正文最长」的单条输入；其余输入与非文本附件原样保留。
// C6：非历史来源恒 T0，T3 覆盖裁剪不得移除本回合。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, contentOf, startService, ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const { canonicalize } = await import('../execute/normalize.ts')
const { dedupe } = await import('../execute/stages.ts')
const { missingResults, repairPairing } = await import('../execute/pairing.ts')

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

function toolCallsOf(message) {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

/** 每个 tool_call 都能在同批次里找到配对结果。 */
function pairingHolds(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    for (const call of toolCallsOf(messages[index])) {
      const found = messages
        .slice(index + 1)
        .some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      if (!found) return false
    }
  }
  return true
}

function turn(turn_id, user, steps, at = '2026-01-01T00:00:00.000Z') {
  return { turn_id, conv: 'c1', at, state: 'settled', user_message: user === null ? undefined : { content: user }, steps }
}

// ── R1：本轮用户消息权威、来源与排序 ────────────────────────────────────────

test('R1：本轮用户消息只出现一次（sources.input.count=1），本轮记录排 input 之后、往期在前', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = {
      turns: [
        turn('t1', 'OLD', [{ type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'A1' }, tool_results: [] }]),
        turn('t2', 'IN', [
          { type: 'step.intent', turn_id: 't2', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: '' }, tool_results: [{ call_id: 'c1', ok: true, result: 'FILE' }] },
        ]),
      ],
    }
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session, turn_id: 't2' }))
    assert.equal(value.ok, true)

    const inputs = value.messages.filter((message) => message.role === 'user' && message.content === 'IN')
    assert.equal(inputs.length, 1, '本轮用户消息只出现一次（历史副本须让位给 input）')
    assert.equal(value.manifest.sources.input.count, 1)
    assert.equal(value.manifest.sources.history.count, 2, '往期用户 + 助手各一条（本轮用户不投影）')

    const inputIndex = value.messages.indexOf(inputs[0])
    const historyIndex = value.messages.findIndex((message) => contentOf(message) === 'A1')
    const callIndex = value.messages.findIndex((message) => toolCallsOf(message).some((call) => call.id === 'c1'))
    const toolIndex = value.messages.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(historyIndex >= 0 && inputIndex >= 0 && callIndex >= 0 && toolIndex >= 0)
    assert.ok(historyIndex < inputIndex, '往期历史在 input 之前')
    assert.ok(inputIndex < callIndex, '本轮工具调用帧在 input 之后')
    assert.ok(callIndex < toolIndex, '本轮结果紧随调用')
    assert.equal(pairingHolds(value.messages), true)
    // 本轮结果逐字（T0，未老化）
    assert.equal(JSON.parse(contentOf(value.messages[toolIndex])).result, 'FILE')
    assert.ok(value.manifest.retention.T0 >= 3, `本轮记录须计 T0：${JSON.stringify(value.manifest.retention)}`)
  } finally {
    drv.close()
  }
})

test('R1：本轮超大输入走专属截断路径（trimmed={source:input,reason:truncated}），不硬死', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({ input: 'i '.repeat(3000), system_prompt: 'P', turn_id: 't-now', config: { model: 'm1', context_window: 200, max_output: 10 } }),
    )
    assert.equal(value.ok, true)
    assert.ok(value.manifest.degraded.includes('truncate_input'))
    assert.ok(value.manifest.trimmed.some((entry) => entry.source === 'input' && entry.reason === 'truncated'))
    assert.ok(value.manifest.used <= value.manifest.budget)
    assert.equal(value.manifest.sources.input.count, 1)
    assert.ok(value.messages.some((message) => contentOf(message).includes('被截断')))
  } finally {
    drv.close()
  }
})

test('R1：group 线程本轮用户消息不产生与 bag.input 的重复', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = { turns: [turn('t2', 'IN', [])] }
    const value = await drv.build(
      baseBag({ thread_kind: 'group', input: 'IN', system_prompt: 'P', topic: 'TOPIC', session, turn_id: 't2' }),
    )
    assert.equal(value.ok, true)
    assert.equal(value.messages.filter((message) => message.role === 'user' && message.content === 'IN').length, 1)
    assert.ok(value.messages.map(contentOf).includes('[圆桌议题]\nTOPIC'))
    assert.equal(value.manifest.sources.input.count, 2, 'bag.input + 议题各一条')
  } finally {
    drv.close()
  }
})

// ── R2：工调帧不去重 ────────────────────────────────────────────────────────

test('R2：三个阶段批次（空正文 assistant(tool_calls) + 结果）全保留，配对自检干净', () => {
  const frames = []
  for (let index = 1; index <= 3; index += 1) {
    frames.push(
      raw({
        role: 'assistant',
        source: 'tool',
        priority: 4,
        parts: [],
        toolCalls: [{ id: `c${index}`, name: 'read', arguments: {} }],
        atomic: true,
        atomicGroup: index,
        orderHint: index * 2,
      }),
    )
    frames.push(
      raw({
        role: 'tool',
        source: 'tool',
        priority: 4,
        toolCallId: `c${index}`,
        parts: [{ type: 'text', text: JSON.stringify({ call_id: `c${index}`, ok: true, result: index }) }],
        atomic: true,
        atomicGroup: index,
        orderHint: index * 2 + 1,
      }),
    )
  }
  const messages = canonicalize(frames)
  const result = dedupe(messages)
  assert.equal(result.messages.filter((message) => Array.isArray(message.toolCalls)).length, 3, '三帧工调都须保留')
  assert.equal(result.messages.filter((message) => message.role === 'tool').length, 3, '三份结果都须保留')
  assert.equal(result.deduped, 0)
  assert.deepEqual(missingResults(result.messages), [])
  assert.deepEqual(missingResults(repairPairing(result.messages)), [])
})

// ── C5：单条最大输入截断，附件与其余输入保留 ─────────────────────────────────

test('C5：只截断正文最长的单条输入；非文本附件与第二条输入原样保留', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const image = { kind: 'image', name: 'pic.png', source: { kind: 'asset', sha256: 'a'.repeat(64), mime: 'image/png', size: 9 } }
    const value = await drv.build(
      baseBag({
        thread_kind: 'group',
        input: { content: 'i '.repeat(3000), attachments: [image] },
        system_prompt: 'P',
        topic: 'TOPIC',
        config: { model: 'm1', context_window: 300, max_output: 10, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)
    assert.ok(value.manifest.degraded.includes('truncate_input'))
    assert.equal(value.manifest.trimmed.filter((entry) => entry.source === 'input' && entry.reason === 'truncated').length, 1, '只截断一条输入')

    const truncated = value.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'))
    assert.ok(truncated, '被截断消息须保留图片 part')
    const serialized = JSON.stringify(truncated.content)
    assert.ok(serialized.includes(`asset:${'a'.repeat(64)}`), '图片资产引用须保留')
    const textPart = truncated.content.find((part) => part.type === 'text')
    assert.ok(typeof textPart.text === 'string' && textPart.text.includes('被截断'), '正文须带截断标记')

    const topic = value.messages.find((message) => contentOf(message) === '[圆桌议题]\nTOPIC')
    assert.ok(topic !== undefined, '第二条输入消息须原样保留')
    assert.equal(value.manifest.sources.input.count, 2)
  } finally {
    drv.close()
  }
})

// ── C6：同回合 T0 守卫 ──────────────────────────────────────────────────────

test('C6：T3 检查点覆盖裁剪不得移除本回合（非历史恒 T0）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = {
      turns: [
        turn('t1', 'OLD', [{ type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'A1' }, tool_results: [] }]),
        turn('t2', 'IN-SESSION', [
          { type: 'step.intent', turn_id: 't2', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: 'A2' }, tool_results: [{ call_id: 'c1', ok: true, result: 'FILE' }] },
          { type: 'checkpoint', turn_id: 't2', seq: 3, summary: { goal: '阶段一' }, covered_upto: { turn_id: 't2', seq: 3 } },
        ]),
      ],
    }
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session, turn_id: 't2' }))
    assert.equal(value.ok, true)
    const texts = value.messages.map(contentOf)
    assert.ok(!texts.includes('A1') && !texts.includes('OLD'), '被覆盖的往期回合整条丢弃')
    assert.ok(texts.includes('A2'), '本回合在覆盖边界内仍须 T0 保留')
    assert.ok(texts.includes('IN'), '本轮输入保留')
    assert.equal(texts.includes('IN-SESSION'), false, '本轮用户消息不投影')
    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(tool !== undefined, '本回合工具结果不得被 T3 裁掉')
    assert.equal(JSON.parse(contentOf(tool)).result, 'FILE')
    assert.ok(value.manifest.retention.T3 >= 1)
    assert.ok(value.manifest.retention.T0 >= 3)
  } finally {
    drv.close()
  }
})
