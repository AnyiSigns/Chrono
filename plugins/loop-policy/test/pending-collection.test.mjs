// 挂起（approval.wait 返回 pending）收口测试：本轮已发生的用户 / 助手消息必须在挂起时落账，
// 挂起收口必须显式（带挂起原因 + resume 游标），续跑只追加助手 / 系统消息（不重复用户消息），
// 且跨宿主重启可由持久化游标裁决续跑。覆盖 approved / denied / pending 三种非终结裁决的收口完备性。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

/** 取回合尾摘要 extern（payload.kind === 'interpret'）。 */
function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') {
      return directive.payload
    }
  }
  return null
}

function stepsOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'step_append').map((call) => call.args)
}

function stepResults(service) {
  return stepsOf(service).filter((record) => record.type === 'step.result')
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

function enqueueCursorOf(service) {
  return service.portCalls.find((call) => call.port === 'approval' && call.method === 'enqueue')?.args?.cursor ?? null
}

/** escalate 路径：模型请求 edit，guard 判升级。 */
function escalateProviders() {
  return {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'approved done', tool_calls: [], usage: {} }
      return { ok: true, text: '需要审批', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })),
    }),
  }
}

test('回归：approval pending 时本轮助手消息（含工具卡）进入挂起收口落账', async () => {
  const service = startService({ providers: escalateProviders() })
  try {
    const result = await service.interpret({ turn_id: 't1', input: { kind: 'chat.message', text: '原始用户消息' } })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'pending', '本回合应以显式挂起收口')
    assert.equal(summary.pending, 'approval')
    assert.equal(settlesOf(service).length, 0, '段终态不收口（不写 turn.settle）')

    const partial = stepResults(service).find((record) => record.assistant?.parts)
    assert.ok(partial, '挂起时助手承接帧先落盘（用户消息归 chat.turn_open，不由本插件写）')
    assert.equal(partial.assistant.content, '需要审批', '助手消息进入落账')
    const toolPart = partial.assistant.parts.find((part) => part.type === 'tool')
    assert.equal(toolPart.tool, 'edit')
    assert.equal(toolPart.call_id, 'c1')
    assert.equal(toolPart.result, null, '审批未决，工具结果留空')
    assert.equal(toolPart.status, null, '审批未决，工具状态留空')
    const enqueue = service.portCalls.find((call) => call.port === 'approval' && call.method === 'enqueue')
    assert.equal(enqueue.args.cursor.kind, 'approval', '挂起收口带 resume 游标')
    assert.equal(enqueue.args.cursor.turn_id, 't1', '游标携带回合身份')
  } finally {
    service.close()
  }
})

test('非终结裁决收口完备：approved / denied / pending 都有显式收口且结局可区分', async () => {
  // 首轮一律走 escalate → approval.wait，必须以 pending 显式收口并落账本轮消息。
  const providers = escalateProviders()
  const first = startService({ providers })
  let cursor
  try {
    const result = await first.interpret({ turn_id: 't1', input: { kind: 'chat.message', text: '原始用户消息' } })
    assert.equal(summaryOf(result.value).ended, 'pending', 'pending 结局')
    assert.equal(settlesOf(first).length, 0, 'pending 不 settle（不静默丢本轮，内容已落步记录）')
    cursor = enqueueCursorOf(first)
    assert.ok(cursor, '裁决续跑依赖队列项游标')
  } finally {
    first.close()
  }

  for (const item of [
    { verdict: 'approved', ending: 'done', kind: 'committed' },
    { verdict: 'denied', ending: 'refused', kind: 'refused' },
  ]) {
    const service = startService({ providers })
    try {
      const resumed = await service.interpret({
        turn_id: 't1',
        input: { kind: 'chat.message', text: '原始用户消息' },
        resume: { cursor, thread: 't1', payload: { verdict: item.verdict } },
      })
      assert.equal(summaryOf(resumed.value).ended, item.ending, `${item.verdict} 结局`)
      assert.equal(settlesOf(service).length, 1, `${item.verdict} 必须有显式收口`)
      assert.equal(settlesOf(service)[0].outcome.kind, item.kind)
    } finally {
      service.close()
    }
  }
})

test('跨重启续跑：从持久化游标裁决续跑，只追加助手消息、不重复用户消息', async () => {
  const providers = escalateProviders()
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({ input: { kind: 'chat.message', text: '原始用户消息' } })
    cursor = enqueueCursorOf(first)
    assert.ok(cursor, '挂起态与 resume 游标已随队列项持久化')
  } finally {
    first.close()
  }

  const second = startService({ providers })
  try {
    const result = await second.interpret({
      turn_id: 't1',
      input: { kind: 'chat.message', text: '原始用户消息' },
      resume: { cursor, thread: 't1', payload: { verdict: 'approved' } },
    })
    assert.equal(summaryOf(result.value).ended, 'done')
    assert.equal(settlesOf(second)[0].outcome.kind, 'committed', '续跑收口同一回合')
    const finalStep = stepResults(second).at(-1)
    assert.ok(finalStep, '续跑收口落盘最终助手步记录')
    assert.equal(finalStep.assistant.content, 'approved done')
    const toolPart = finalStep.assistant.parts.find((part) => part.type === 'tool')
    assert.equal(toolPart.status, 'ok', '已执行工具结果随续跑收口落盘')
    assert.deepEqual(toolPart.result, { path: 'a.txt' })
  } finally {
    second.close()
  }
})

test('denied 续跑：追加 system 拒绝消息（append），不重写用户消息', async () => {
  const providers = escalateProviders()
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({ input: { kind: 'chat.message', text: '原始用户消息' } })
    cursor = enqueueCursorOf(first)
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    const result = await second.interpret({
      turn_id: 't1',
      input: { kind: 'chat.message', text: '原始用户消息' },
      resume: { cursor, thread: 't1', payload: { verdict: 'denied' } },
    })
    assert.equal(summaryOf(result.value).ended, 'refused')
    const settle = settlesOf(second)[0]
    assert.ok(settle, '拒绝也要收口（保住本轮已发生事实）')
    assert.equal(settle.outcome.kind, 'refused')
    assert.equal(settle.outcome.attributableTo, 'approval')
    assert.equal(settle.outcome.cause.code, 'denied', '下游码原样进 cause')
  } finally {
    second.close()
  }
})

test('提问续跑：用户消息只落一次（续跑 append），助手承接帧含工具结果', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return { ok: true, text: '需要澄清', tool_calls: [{ id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } }], usage: {} }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { status: 'pending' } })),
    }),
  }
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({ input: { kind: 'chat.message', text: '原始用户消息' } })
    cursor = first.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')?.args?.cursor ?? null
    assert.ok(cursor, '提问游标随队列项落世界')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    await second.interpret({
      turn_id: 't1',
      input: { kind: 'chat.message', text: '原始用户消息' },
      resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } },
    })
    assert.equal(settlesOf(second)[0].outcome.kind, 'committed', '提问续跑收口落账')
    const finalStep = stepResults(second).at(-1)
    assert.ok(finalStep, '续跑收口落盘最终助手步记录')
    assert.equal(finalStep.assistant.content, 'answered')
  } finally {
    second.close()
  }
})
