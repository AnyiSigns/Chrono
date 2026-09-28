// 拒绝留痕形状一致：运行期短路（runNode 的 pre / post / transport 拒绝）与边送拒绝（approval denied）
// 都把本回合最后一步助手消息作为收口步（turn.commit）的 `message` 落进 step.result——助手正文 / 推理 /
// 工具卡不因拒绝而丢。两条通道的收口步记录都必须带同一份助手内容。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function stepResults(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append')
    .map((call) => call.args)
    .filter((record) => record.type === 'step.result')
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

function enqueueCursorOf(service) {
  return service.portCalls.find((call) => call.port === 'approval' && call.method === 'enqueue')?.args?.cursor ?? null
}

test('运行期短路拒绝：助手正文随收口步落账（不因拒绝丢内容）', async () => {
  const service = startService({
    providers: {
      // 同帧带正文与畸形 tool_call：step_post 以 malformed_tool_call 拒绝，正文已发生在 rs.messages。
      'model.chat': () => ({ ok: true, text: '先说一句', tool_calls: [{ id: 'c1', name: '', args: {} }], usage: {} }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1' })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'capability_mismatch')
    const settle = settlesOf(service)[0]
    assert.equal(settle.outcome.kind, 'refused')
    const finalStep = stepResults(service).at(-1)
    assert.ok(finalStep, '拒绝短路仍须落收口步记录')
    assert.equal(finalStep.assistant.content, '先说一句', '助手正文不得因运行期拒绝丢失')
  } finally {
    service.close()
  }
})

test('边送拒绝：approval denied 的助手正文与运行期短路同形落账', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'approved done', tool_calls: [], usage: {} }
      return { ok: true, text: '需要审批', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
  }
  const first = startService({ providers })
  let cursor
  try {
    const result = await first.interpret({ turn_id: 't1', input: { kind: 'chat.message', text: '原始用户消息' } })
    assert.equal(summaryOf(result.value).ended, 'pending')
    cursor = enqueueCursorOf(first)
    assert.ok(cursor, '审批挂起应落 resume 游标')
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
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'denied')
    const settle = settlesOf(second)[0]
    assert.equal(settle.outcome.kind, 'refused')
    assert.equal(settle.outcome.cause.code, 'denied')
    const finalStep = stepResults(second).at(-1)
    assert.ok(finalStep, '边送拒绝仍须落收口步记录')
    assert.equal(finalStep.assistant.content, '需要审批', '助手正文不得因边送拒绝丢失（与运行期短路同形）')
  } finally {
    second.close()
  }
})
