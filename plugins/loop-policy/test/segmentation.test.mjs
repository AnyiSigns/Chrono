// 分段执行的预算与模型参数对齐：有回合身份时一段一个 iter，预算（max_turn_iter）跨段累加先于
// 机械轮数上限收口；上下文组装算出的 max_output 对齐进模型 config.params.max_tokens。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

function stepResults(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append')
    .map((call) => call.args)
    .filter((record) => record.type === 'step.result')
}

test('多段回合：预算先于机械轮数上限收口，settle committed + stop_reason，已完成步骤保留', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const summary = summaryOf(result.value)
    // 用户预算主动停不是失败：回合不 refused，保留内容并以 committed + stop_reason 收口。
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(summary.refused_at, null)
    assert.equal(summary.outcome.kind, 'committed')
    assert.equal(summary.outcome.stop_reason, 'turn_iter')
    const settle = settlesOf(service).at(-1)
    assert.equal(settle.outcome.kind, 'committed')
    assert.equal(settle.outcome.stop_reason, 'turn_iter')
    // 已完成步骤保留：收口前已落多批 step.result，证明内容不因预算停而丢。
    assert.ok(stepResults(service).length > 0, '预算停不得丢弃已完成步骤')
    assert.ok(summary.iters >= 2, `应有多次分段：iters=${summary.iters}`)
  } finally {
    service.close()
  }
})

test('模型参数对齐：上下文组装算出的 max_output 进模型 config.params.max_tokens', async () => {
  let seen = null
  const service = startService({
    providers: {
      'context.build': () => ({ messages: [{ role: 'user', content: 'hi' }], params: { model: 'm', max_output: 1234 } }),
      'model.chat': (args) => {
        seen = args
        return { ok: true, text: 'done', tool_calls: [], usage: {} }
      },
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1', config: { model: 'm', params: { temperature: 0 } } })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.ok(seen !== null, '应已调用模型')
    assert.equal(seen.config.params.max_tokens, 1234, 'max_output 应覆盖适配器默认输出上限')
  } finally {
    service.close()
  }
})
