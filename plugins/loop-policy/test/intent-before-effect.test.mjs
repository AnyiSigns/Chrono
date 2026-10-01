// I4（先写意图再执行、记不下来就停）：step.intent 追加失败时，有副作用的工具不得被派发；
// 回合在下一步边界收口为 refused{owner_unavailable}，不继续调模型与工具。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, portError } from './driver.mjs'

function portSequence(service) {
  return service.portCalls.map((call) => `${call.port}.${call.method}`)
}

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

test('step.intent 追加失败 ⇒ 工具不派发、回合收口 refused{owner_unavailable}', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
      'session.step_append': () => portError('write_failed', 'turn log down'),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1', tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }] })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.ok(!seq.includes('tool-dispatch.dispatch'), `意图写不进不得派发工具：${seq.join(',')}`)
    const settle = settlesOf(service)
    assert.equal(settle.length, 1, '在下一步边界收口，不继续空转')
    assert.equal(settle[0].outcome.kind, 'refused')
    assert.equal(settle[0].outcome.code, 'owner_unavailable')
    assert.equal(settle[0].outcome.attributableTo, 'owner')
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'owner_unavailable')
  } finally {
    service.close()
  }
})
