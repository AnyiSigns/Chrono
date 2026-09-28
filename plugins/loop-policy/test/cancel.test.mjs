// 取消（协作式）：`cancel(turn_id)` 置进程内标志，运行中的 interpret 在派发边界查、命中即停。
// 覆盖入口检查、派发前检查（不派发新工具）、派发后检查（模型调用被中止）与标志清除。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf } from './driver.mjs'

function sequence(service) {
  return service.portCalls.map((call) => `${call.port}.${call.method}`)
}

/** 取本回合已落步记录（驱动侧代收的 `session.step_append`），供段续跑重建。 */
function stepsOf(service, turnId) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append' && call.args?.turn_id === turnId)
    .map((call) => call.args)
}

/** 计划里是否有自续跑 eval（段终态标志）。 */
function continuationOf(value) {
  return directivesOf(value).find(
    (item) => item.kind === 'eval' && item.command === 'chat.resume' && item.args && typeof item.args.turn_id === 'string' && !item.args.cursor,
  )
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

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('取消：进入解释前已置标志 ⇒ 不派发任何节点，收口 cancelled', async () => {
  const service = startService()
  try {
    const cancelled = await service.call('loop-policy', 'cancel', { turn_id: 't-early' })
    assert.equal(cancelled.kind, 'result')
    assert.equal(cancelled.value.cancelled, true)
    const result = await service.interpret({ turn_id: 't-early', tools: [] })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = sequence(service)
    assert.ok(!seq.includes('model.chat'), `取消后不得调模型：${seq.join(',')}`)
    assert.ok(!seq.includes('tools.dispatch'), `取消后不得派发工具：${seq.join(',')}`)
    assert.equal(summaryOf(result.value).ended, 'cancelled')
    const settle = settlesOf(service)
    assert.equal(settle.length, 1)
    assert.equal(settle[0].outcome.kind, 'cancelled')
  } finally {
    service.close()
  }
})

test('取消：派发前命中标志 ⇒ 不派发工具，回合收口 cancelled', async () => {
  let releaseGuard
  const guardGate = new Promise((resolve) => {
    releaseGuard = resolve
  })
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () =>
        guardGate.then(() => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } })),
    },
  })
  try {
    const pending = service.interpret({
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    await waitFor(() => service.portCalls.some((call) => call.port === 'model' && call.method === 'chat'))
    const cancelled = await service.call('loop-policy', 'cancel', { turn_id: 't1' })
    assert.equal(cancelled.value.cancelled, true)
    releaseGuard()
    const result = await pending
    const seq = sequence(service)
    assert.ok(!seq.includes('tools.dispatch'), `取消后不得派发工具：${seq.join(',')}`)
    const settle = settlesOf(service)
    assert.equal(settle.length, 1)
    assert.equal(settle[0].outcome.kind, 'cancelled')
    assert.equal(summaryOf(result.value).ended, 'cancelled')
  } finally {
    service.close()
  }
})

test('取消标志在回合返回后清除，不泄漏到后续回合', async () => {
  const service = startService()
  try {
    await service.call('loop-policy', 'cancel', { turn_id: 't-leak' })
    const first = await service.interpret({ turn_id: 't-leak', tools: [] })
    assert.equal(summaryOf(first.value).ended, 'cancelled')
    const before = service.portCalls.length
    const second = await service.interpret({ turn_id: 't-leak', tools: [] })
    assert.equal(summaryOf(second.value).ended, 'done')
    assert.ok(
      service.portCalls.slice(before).some((call) => call.port === 'model' && call.method === 'chat'),
      '清除标志后后续回合应正常调模型',
    )
    assert.equal(settlesOf(service)[1].outcome.kind, 'committed')
  } finally {
    service.close()
  }
})

test('取消落在两段之间：下一段不派发任何节点，回合收口 cancelled', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    const tools = [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }]
    // 第一段：派发工具后段尾未完，计划带自续跑 eval（不自动驱动到终态）。
    const first = await service.call('loop-policy', 'interpret', { turn_id: 't1', tools })
    assert.equal(first.kind, 'result', JSON.stringify(first))
    assert.ok(continuationOf(first.value), '段尾应带自续跑 eval')
    assert.ok(
      service.portCalls.some((call) => call.port === 'tools' && call.method === 'dispatch'),
      '第一段应已派发工具',
    )

    // 取消落在段与段之间：置进程内标志并收口（模拟 chat.cancel 的顺序）。
    const cancelled = await service.call('loop-policy', 'cancel', { turn_id: 't1' })
    assert.equal(cancelled.value.cancelled, true)

    // 第二段：入口检查即命中取消，不派发任何模型 / 工具节点，收口 cancelled。
    const before = service.portCalls.length
    const second = await service.call('loop-policy', 'interpret', {
      turn_id: 't1',
      tools,
      resume: { continuation: true, turn_id: 't1' },
      session: { turns: [{ turn_id: 't1', steps: stepsOf(service, 't1') }] },
    })
    const after = service.portCalls.slice(before).map((call) => `${call.port}.${call.method}`)
    assert.ok(!after.includes('model.chat'), `取消后下一段不得调模型：${after.join(',')}`)
    assert.ok(!after.includes('tools.dispatch'), `取消后下一段不得派发工具：${after.join(',')}`)
    assert.equal(continuationOf(second.value), undefined, '取消段不得再自续跑')
    assert.equal(summaryOf(second.value).ended, 'cancelled')
    const settle = settlesOf(service)
    assert.equal(settle[0].outcome.kind, 'cancelled')
  } finally {
    service.close()
  }
})

test('取消：缺 turn_id 是结构化拒绝，不是协议错误', async () => {
  const service = startService()
  try {
    const result = await service.call('loop-policy', 'cancel', {})
    assert.equal(result.kind, 'result')
    assert.equal(result.value.ok, false)
    assert.equal(result.value.reason, 'bad_args')
  } finally {
    service.close()
  }
})
