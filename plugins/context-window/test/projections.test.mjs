// 上下文投影（分层保留后的模型消息列）测试。
// 覆盖：逐层保留生效、替代去重经协议层可见、配对在老化 / 预算裁剪 / 中断下不破、前缀逐字节稳定。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, contentOf, startService } from './driver.mjs'

/** 由回合日志构造 session 切片（链 + turns），消息 id 按 `msg-<conv>-<turn>-<role>`。 */
function turnSession(conv, turns) {
  const refs = {}
  let prev = null
  const out = []
  for (const turn of turns) {
    const uid = `msg-${conv}-${turn.turn_id}-user`
    refs[uid] = { id: uid, role: 'user', content: turn.user, prev: prev === null ? null : { def: prev } }
    prev = uid
    const aid = `msg-${conv}-${turn.turn_id}-assistant`
    if (turn.assistant !== undefined || turn.parts !== undefined) {
      refs[aid] = {
        id: aid,
        role: 'assistant',
        content: turn.assistant ?? '',
        prev: { def: prev },
        ...(turn.parts === undefined ? {} : { parts: turn.parts }),
      }
      prev = aid
    }
    let steps = turn.steps === undefined ? stepsFromParts(turn) : turn.steps.slice()
    if (turn.assistant !== undefined && turn.assistant !== '' && !steps.some((step) => step.type === 'step.result' && step.assistant?.content === turn.assistant)) {
      const maxSeq = steps.reduce((max, step) => (typeof step.seq === 'number' && step.seq > max ? step.seq : max), 0)
      steps = [...steps, { type: 'step.result', turn_id: turn.turn_id, seq: maxSeq + 1, assistant: { content: turn.assistant }, tool_results: [] }]
    }
    out.push({
      turn_id: turn.turn_id,
      conv,
      at: turn.at ?? '2026-01-01T00:00:00.000Z',
      state: turn.state ?? 'settled',
      outcome: turn.outcome ?? { kind: 'committed', retryable: false },
      user_message: {
        content: turn.user,
        ...(turn.parts === undefined ? {} : {}),
      },
      steps,
    })
  }
  return { head: prev, refs, turns: out }
}

/** 无显式 steps 时，按展示 parts 推断步记录（工具卡 → intent + result）。 */
function stepsFromParts(turn) {
  const parts = Array.isArray(turn.parts) ? turn.parts : []
  const toolCards = parts.filter((part) => part !== null && typeof part === 'object' && part.type === 'tool')
  if (toolCards.length === 0) return []
  const calls = toolCards.map((card, index) => ({ id: card.call_id ?? `call-${index}`, name: card.tool ?? '', arguments: card.args ?? {} }))
  const results = []
  for (const card of toolCards) {
    const callId = card.call_id
    if (typeof callId !== 'string') continue
    if (card.status === null && card.result === null) continue
    const ok = card.status !== 'error'
    results.push(ok ? { call_id: callId, ok: true, result: card.result ?? null } : { call_id: callId, ok: false, error: card.result ?? null })
  }
  const assistant = { content: turn.assistant ?? '' }
  const assistantParts = parts.filter((part) => part.type !== 'tool')
  if (assistantParts.length > 0) assistant.parts = assistantParts
  return [
    { type: 'step.intent', turn_id: turn.turn_id, seq: 1, kind: 'tool.dispatch', tool_calls: calls },
    { type: 'step.result', turn_id: turn.turn_id, seq: 1, assistant, tool_results: results },
  ]
}

function toolCallResult(turnId, seq, callId, tool, args, result) {
  const call = { id: callId, name: tool, arguments: args }
  const assistant = {
    content: '',
    parts: [{ type: 'tool', call_id: callId, tool, args, result, status: 'ok' }],
  }
  return [
    { type: 'step.intent', turn_id: turnId, seq, kind: 'tool.dispatch', tool_calls: [call] },
    { type: 'step.result', turn_id: turnId, seq, assistant, tool_results: [{ call_id: callId, ok: true, result }] },
  ]
}

// ── 分层保留（协议级） ─────────────────────────────────────────────────────

test('分层保留：近期工具结果老化带句柄；陈旧回合结果丢弃', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 6 回合，距离 5..0；policy recent_turns=4 ⇒ 距离 ≥4 为 T2。
    const turns = []
    for (let index = 0; index < 6; index += 1) {
      const turnId = `t${index}`
      const steps = toolCallResult(turnId, index + 1, `c${index}`, 'read', { path: `src/f${index}.ts` }, { text: 'L\n'.repeat(300), lines_returned: 300 })
      turns.push({
        turn_id: turnId,
        user: `U${index}`,
        assistant: `A${index} 第一行\nA${index} 第二行`,
        parts: [
          { type: 'text', text: `A${index} 第一行\nA${index} 第二行` },
          { type: 'tool', call_id: `c${index}`, tool: 'read', args: { path: `src/f${index}.ts` }, result: { text: 'L\n'.repeat(300), lines_returned: 300 }, status: 'ok' },
        ],
        steps,
      })
    }
    const session = turnSession('c1', turns)
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    assert.ok(value.manifest.retention.T2 >= 1, `陈旧回合应落 T2：${JSON.stringify(value.manifest.retention)}`)

    const toolTexts = value.messages.filter((message) => message.role === 'tool').map(contentOf)
    const aged = toolTexts.find((text) => text.includes('"aged":true') && text.includes('"dropped"') === false)
    const dropped = toolTexts.find((text) => text.includes('"dropped":true'))
    assert.ok(aged, '近期结果须老化带句柄')
    assert.ok(dropped, '陈旧结果须只留句柄')

    const assistantTexts = value.messages.filter((message) => message.role === 'assistant').map(contentOf)
    assert.ok(assistantTexts.some((text) => text.includes('A0 第一行')), '陈旧助手正文仍逐字（不再做文本压缩）')
  } finally {
    drv.close()
  }
})

// ── 替代去重（协议级） ─────────────────────────────────────────────────────

test('替代去重：同资源两次读取，早前塌成「已被第 N 步替代」，最后一份完整', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = turnSession('c1', [
      {
        turn_id: 't1',
        user: 'U1',
        assistant: '',
        parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'OLD', lines_returned: 1 }, status: 'ok' }],
        steps: toolCallResult('t1', 3, 'c1', 'read', { path: 'src/a.ts' }, { text: 'OLD', lines_returned: 1 }),
      },
      {
        turn_id: 't2',
        user: 'U2',
        assistant: '',
        parts: [{ type: 'tool', call_id: 'c2', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'NEW', lines_returned: 1 }, status: 'ok' }],
        steps: toolCallResult('t2', 17, 'c2', 'read', { path: 'src/a.ts' }, { text: 'NEW', lines_returned: 1 }),
      },
    ])
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const toolTexts = value.messages.filter((message) => message.role === 'tool').map(contentOf)
    const replaced = toolTexts.map((text) => JSON.parse(text)).find((entry) => entry.replaced === true)
    assert.ok(replaced, `须有被替代的读取：${toolTexts.join(' | ')}`)
    assert.equal(replaced.path, 'src/a.ts')
    assert.equal(replaced.replaced_by_step, 17)
    assert.ok(String(replaced.handle).startsWith('h-'))
    assert.ok(value.manifest.degraded.includes('replacement_dedupe'))
  } finally {
    drv.close()
  }
})

// ── 配对不变量 ─────────────────────────────────────────────────────────────

test('配对：历史工具卡无结果（中断）合成 interrupted 占位，配对不破', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = turnSession('c1', [
      {
        turn_id: 't1',
        user: 'U1',
        assistant: '',
        parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: null, status: null }],
      },
      { turn_id: 't2', user: 'U2', assistant: 'A2' },
    ])
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.equal(contentOf(tool), JSON.stringify({ ok: false, error: 'interrupted' }))
    // 每个 tool_call 都有配对结果
    for (let index = 0; index < value.messages.length; index += 1) {
      const calls = Array.isArray(value.messages[index].tool_calls) ? value.messages[index].tool_calls : []
      for (const call of calls) {
        const paired = value.messages.slice(index + 1).some((message) => message.role === 'tool' && message.tool_call_id === call.id)
        assert.equal(paired, true, `call ${call.id} 须有配对结果`)
      }
    }
  } finally {
    drv.close()
  }
})

// ── 前缀稳定 ───────────────────────────────────────────────────────────────

test('前缀稳定：带回合日志 / 替代去重的 bag 连续两次组装逐字节一致', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = turnSession('c1', [
      {
        turn_id: 't1',
        user: 'U1',
        assistant: 'A1',
        parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'X', lines_returned: 1 }, status: 'ok' }],
        steps: toolCallResult('t1', 1, 'c1', 'read', { path: 'src/a.ts' }, { text: 'X', lines_returned: 1 }),
      },
      {
        turn_id: 't2',
        user: 'U2',
        assistant: 'A2',
        parts: [{ type: 'tool', call_id: 'c2', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'Y', lines_returned: 1 }, status: 'ok' }],
        steps: toolCallResult('t2', 8, 'c2', 'read', { path: 'src/a.ts' }, { text: 'Y', lines_returned: 1 }),
      },
    ])
    const bag = baseBag({ input: 'IN', system_prompt: 'P', session, tools: [{ name: 'z' }, { name: 'a' }] })
    const first = await drv.build(bag)
    const second = await drv.build(bag)
    assert.equal(JSON.stringify(first), JSON.stringify(second))
  } finally {
    drv.close()
  }
})
