// 两会话并发端到端：两个会话同时发送，第二个不被第一个的长回合阻塞（跨会话并发放开的回归锚点）。
// 真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。
// 本文件钉的不变量：进程串行链不再是全平台唯一的互斥；跨会话可并发。
// 两个会话在会话 `current` 尚为空时同时开回合，各自认领自己的 conversation_id（这就是 UI 多窗口/
// 多客户端并发的真实边界）；同一会话的互斥由会话属主的 turn_open CAS 承担，不在本文件断言范围。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootScenario, NativeTokenizerMissing } from '../harness/index.mjs'

async function withScenario(t, options, fn) {
  let scenario
  try {
    scenario = await bootScenario(options)
  } catch (err) {
    if (err instanceof NativeTokenizerMissing) {
      t.skip('缺少 context-window 原生 tokenizer 产物，跳过真实回合')
      return
    }
    throw err
  }
  try {
    await fn(scenario)
  } finally {
    await scenario.dispose()
  }
}

/** 含 `SLOW` 且带工具声明的主调用长静默；标题旁路段（无工具）与其它请求立即回文本。 */
function slowForFirstResponder(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
  const slow = messages.some((message) => typeof message?.content === 'string' && message.content.includes('SLOW'))
  if (hasTools && slow) return { type: 'silence', ms: 120000 }
  return { type: 'text', text: 'quick answer' }
}

test('两会话并发：第二个会话在第一个长回合仍在途时完成（互不阻塞）', async (t) => {
  await withScenario(t, { responder: slowForFirstResponder }, async ({ recorder, client }) => {
    // 两个会话同时起回合：慢的回合在模型调用上长静默，保持 in-flight。
    const slowPromise = recorder.sendTurn('SLOW first', { thread: 't1', conversationId: 'c-conc-a' })
    let slowSettled = false
    slowPromise.then(() => {
      slowSettled = true
    })
    const fast = await recorder.sendTurn('fast second', { thread: 't2', conversationId: 'c-conc-b' })
    assert.equal(fast.result.status, 'done')
    assert.equal(slowSettled, false, '第二个回合完成时第一个仍在途（未被串行链阻塞）')

    // 两个会话各自开回合、各归各的会话。
    const started = recorder.byTopic('chat.turn.started')
    const fastStarted = started.find((event) => event.payload.conversation === 'c-conc-b')
    const slowStarted = started.find((event) => event.payload.conversation === 'c-conc-a')
    assert.ok(fastStarted, '第二个会话应有自己的回合开始事件')
    assert.ok(slowStarted, '第一个会话应有自己的回合开始事件')

    // 第二个回合已收口 committed（第一个仍未收口）。
    const fastSettled = recorder
      .byTopic('chat.turn.settled')
      .find((event) => event.payload.turn_id === fastStarted.payload.turn_id)
    assert.ok(fastSettled, '第二个会话应已收口')
    assert.equal(fastSettled.payload.outcome.kind, 'committed')
    assert.equal(
      recorder.byTopic('chat.turn.settled').some((event) => event.payload.turn_id === slowStarted.payload.turn_id),
      false,
      '第一个回合收口前不应有它的结局事件',
    )
    // 第二个会话的历史独立落账（用户 + 助手两条）。
    const fastHistory = await recorder.history('c-conc-b')
    assert.equal(fastHistory.conversation, 'c-conc-b')
    assert.equal((fastHistory.messages ?? []).length, 2)

    // 清理在途的长回合：取消后 send 收口为 cancelled。
    const cancelled = await client.command('chat.cancel', {
      turn_id: slowStarted.payload.turn_id,
      thread: 't1',
    })
    const receipt = (Array.isArray(cancelled.observations) ? cancelled.observations : [])
      .map((observation) => observation?.payload)
      .find((payload) => payload?.turn_id === slowStarted.payload.turn_id)
    assert.ok(receipt, '取消应有回执')
    assert.equal(receipt.outcome?.kind, 'cancelled')
    const slow = await slowPromise
    assert.equal(slow.result.status, 'done', '宿主 run 机械 done')
  })
})
