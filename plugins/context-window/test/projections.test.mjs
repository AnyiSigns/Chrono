// 两个投影与检查点的测试：`view.display`（UI 完整时间线）/ `view.context`（分层保留后的模型消息列）。
// 覆盖：检查点注入 + 「检查点 + covered_upto 之后的步」历史重建、覆盖边界（同回合步号词序）、
// 逐层保留生效、替代去重经协议层可见、配对在老化 / 预算裁剪 / 中断下不破、前缀逐字节稳定。

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

function checkpointStep(turnId, seq, coveredUpto, summary) {
  return { type: 'checkpoint', turn_id: turnId, seq, summary: { ...summary, covered_upto: coveredUpto }, covered_upto: coveredUpto }
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

// ── 检查点：注入 + 覆盖旧回合 ───────────────────────────────────────────────

test('检查点：注入为历史头部，覆盖的旧回合不再逐条回灌，原始记录仍留 display', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const steps = [
      ...toolCallResult('t2', 1, 'c1', 'read', { path: 'src/a.ts' }, { text: 'FILE', lines_returned: 1 }),
      checkpointStep('t2', 9, 9, {
        goal: '修复 foo',
        decisions: [{ what: '改用只读投影', why: '不写世界', at_step: 1 }],
        findings: [{ claim: '缺陷在 foo.ts:42', evidence: { handle: 'h-abc' } }],
      }),
    ]
    const session = turnSession('c1', [
      { turn_id: 't1', user: 'U1', assistant: 'A1' },
      { turn_id: 't2', user: 'U2', assistant: '', parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'FILE', lines_returned: 1 }, status: 'ok' }], steps },
      { turn_id: 't3', user: 'U3', assistant: 'A3' },
    ])
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const texts = value.messages.map(contentOf)
    const checkpoint = texts.find((text) => text.startsWith('[检查点]'))
    assert.ok(checkpoint, '检查点必须注入')
    assert.ok(checkpoint.includes('修复 foo'))
    assert.ok(checkpoint.includes('缺陷在 foo.ts:42'))
    assert.ok(!texts.includes('U1') && !texts.includes('A1'), '被覆盖回合的逐条记录不回灌')
    assert.ok(!texts.includes('U2') && !texts.includes('FILE'), '被覆盖回合的工具结果不回灌')
    assert.ok(texts.includes('U3') && texts.includes('A3'), '未覆盖回合保留')
    assert.equal(value.manifest.retention.T3 >= 1, true)
    assert.ok(value.manifest.degraded.includes('checkpoint_covered_turns'))
  } finally {
    drv.close()
  }
})

test('检查点边界：同回合在 covered_upto 之后仍有步 → 该回合不被整体覆盖', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const steps = [
      checkpointStep('t2', 4, 4, { goal: '阶段一' }),
      { type: 'step.result', turn_id: 't2', seq: 7, assistant: { content: '', parts: [{ type: 'text', text: 'BLUE' }] } },
    ]
    const session = turnSession('c1', [
      { turn_id: 't1', user: 'U1', assistant: 'RED' },
      { turn_id: 't2', user: 'U2', assistant: 'BLUE', steps },
      { turn_id: 't3', user: 'U3', assistant: 'A3' },
    ])
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const texts = value.messages.map(contentOf)
    assert.ok(!texts.includes('RED'), '更早回合被覆盖')
    assert.ok(texts.includes('BLUE'), '检查点所在回合在 covered_upto 之后仍有步，须保留')
    assert.ok(texts.some((text) => text.startsWith('[检查点]')))
  } finally {
    drv.close()
  }
})

// ── 分层保留（协议级） ─────────────────────────────────────────────────────

test('分层保留：近期工具结果老化带句柄；陈旧回合结果丢弃、正文压缩', async () => {
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
    assert.ok(value.manifest.degraded.includes('tier2_compress'))

    const toolTexts = value.messages.filter((message) => message.role === 'tool').map(contentOf)
    const aged = toolTexts.find((text) => text.includes('"aged":true') && text.includes('"dropped"') === false)
    const dropped = toolTexts.find((text) => text.includes('"dropped":true'))
    assert.ok(aged, '近期结果须老化带句柄')
    assert.ok(dropped, '陈旧结果须只留句柄')

    const assistantTexts = value.messages.filter((message) => message.role === 'assistant').map(contentOf)
    const compressed = assistantTexts.find((text) => text === 'A0 第一行')
    assert.ok(compressed, '陈旧助手正文压缩为一行')
    assert.ok(assistantTexts.some((text) => text.includes('\n')), '近期助手正文仍逐字')
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

test('前缀稳定：带回合日志 / 检查点 / 替代去重的 bag 连续两次组装逐字节一致', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = turnSession('c1', [
      {
        turn_id: 't1',
        user: 'U1',
        assistant: 'A1',
        parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'src/a.ts' }, result: { text: 'X', lines_returned: 1 }, status: 'ok' }],
        steps: [
          ...toolCallResult('t1', 1, 'c1', 'read', { path: 'src/a.ts' }, { text: 'X', lines_returned: 1 }),
          checkpointStep('t1', 5, 5, { goal: '目标' }),
        ],
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

// ── 预算：配额真正约束 P1；只有 P0 超窗才硬错 ───────────────────────────────

test('配额：quota.l1 / quota.l2 真正约束 P1，超配额被裁且不硬死', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: { l1: { summary: 'l '.repeat(600) }, l2: { summary: 'w '.repeat(600) } },
        config: { model: 'm1', context_window: 1000, max_output: 100 },
      }),
    )
    assert.equal(value.ok, true)
    assert.equal(value.manifest.sources.l1.count, 0)
    assert.equal(value.manifest.sources.l2.count, 0)
    assert.ok(value.manifest.trimmed.some((entry) => entry.source === 'l1' && entry.reason === 'quota'))
    assert.ok(value.manifest.trimmed.some((entry) => entry.source === 'l2' && entry.reason === 'quota'))

    const hard = await drv.build(
      baseBag({ system_prompt: 'a '.repeat(200), config: { model: 'm1', context_window: 100, max_output: 10 } }),
    )
    assert.equal(hard.ok, false)
    assert.equal(hard.code, 'budget_impossible')
    assert.ok(hard.message.includes('prompt'))
  } finally {
    drv.close()
  }
})
