// 取消（协作式）端到端：真宿主 + 真插件 + 真链路，只在模型厂商 HTTP 桩放假。
// 场景：取消一个在途工具回合——模型前两轮各派发一次工具，第三轮长静默在途时用户取消。
// 断言：工具计数停增、在途 HTTP 被中止（桩观测连接关闭）、cancelled 收口唯一、重载历史无完整回复。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  externPayloads,
  historyMessages,
  lastEvalValue,
  NativeTokenizerMissing,
} from '../harness/index.mjs'

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await delay(25)
  }
}

test('I10：取消在途工具回合——工具停派发、在途 HTTP 中止、cancelled 唯一、重载无完整回复', async (t) => {
  const responder = (body) => {
    // 标题旁路段无工具声明：回纯文本，不参与工具回合。
    if (!Array.isArray(body?.tools) || body.tools.length === 0) return { type: 'text', text: 'title' }
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const toolResults = messages.filter((message) => message && message.role === 'tool').length
    if (toolResults === 0) {
      return { type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', arguments: { path: 'src/foo.ts' } }] }
    }
    if (toolResults === 1) {
      return { type: 'tool_calls', calls: [{ id: 'call-2', name: 'read', arguments: { path: 'src/bar.ts' } }] }
    }
    // 第三轮长静默：在途 HTTP 请求，等取消销毁。
    return { type: 'silence', ms: 60000 }
  }

  await withScenario(t, { responder }, async ({ recorder, stub, world, client }) => {
    const sendPromise = recorder.sendTurn('read files', { conversationId: 'c-cancel' })
    let sendSettled = false
    sendPromise.then(() => {
      sendSettled = true
    })
    const started = await recorder.waitForEvent('chat.turn.started')
    const turnId = started.payload.turn_id
    assert.ok(typeof turnId === 'string' && turnId.length > 0)

    // 前两轮各派发一次工具后，第三轮模型调用在途（silence）。
    // 以「消息里已含两条工具结果」定位 silence 请求（标题段请求无工具结果，不干扰计数）。
    await waitFor(
      () => stub.requests.some((body) => (Array.isArray(body?.messages) ? body.messages : []).filter((message) => message && message.role === 'tool').length >= 2),
      60000,
    )
    const requestsAtCancel = stub.requests.length
    const toolCountAtCancel = recorder.events.filter((event) => event.topic === 'tool.start').length
    assert.ok(toolCountAtCancel >= 2, `取消前应已派发工具，实际 ${toolCountAtCancel}`)

    const cancel = await client.command('chat.cancel', { turn_id: turnId, thread: 't1' })
    // 取消必须在 send 仍在途时完成：串行声明会让取消排队到 send 结束后，永远到不了。
    assert.equal(sendSettled, false, '取消完成时 chat.send 应仍未返回')
    const receipt = externPayloads(cancel).find((payload) => payload?.turn_id === turnId)
    assert.ok(receipt, `未观测到取消回执：${JSON.stringify(externPayloads(cancel))}`)
    assert.equal(receipt.cancelled, true)
    assert.equal(receipt.outcome.kind, 'cancelled')

    const sent = await sendPromise
    assert.equal(sent.result.status, 'done', '宿主 run 仍是机械 done')

    // 在途 HTTP 请求被真正销毁（模型桩观测到连接在写完前关闭）。
    assert.ok(stub.aborted.length >= 1, `模型桩未观测到中止：${JSON.stringify(stub.aborted)}`)
    // 不重试：中止不可重试，不再发新请求。
    assert.equal(stub.requests.length, requestsAtCancel)

    // 工具调用计数停止增长。
    await delay(500)
    assert.equal(
      recorder.events.filter((event) => event.topic === 'tool.start').length,
      toolCountAtCancel,
      '取消后不得再派发工具',
    )

    // 收口唯一：session 回合记录为 settled/cancelled；事件通道同值。
    const settleEvents = recorder.byTopic('chat.turn.settled').filter((event) => event.payload.turn_id === turnId)
    assert.ok(settleEvents.length >= 1, '取消必须广播 chat.turn.settled')
    assert.equal(settleEvents[settleEvents.length - 1].payload.outcome.kind, 'cancelled')
    const history = await recorder.history('c-cancel')
    const turn = (Array.isArray(history.turns) ? history.turns : []).find((item) => item.turn_id === turnId)
    assert.ok(turn, '回合记录存在')
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'cancelled')
    assert.ok((turn.late_settles ?? []).length <= 1, '至多一条僵尸收口被记档')
    assert.equal((turn.late_settles ?? []).every((outcome) => outcome.kind !== 'committed'), true, '僵尸提交未被接受')

    // 重载（新客户端）历史：该回合没有完整回复。
    const reloaded = await world.connect()
    try {
      const freshHistory = lastEvalValue(await reloaded.command('chat.history', { conversation: 'c-cancel' }))
      const assistants = historyMessages(freshHistory).filter((message) => message.role === 'assistant')
      for (const message of assistants) {
        assert.equal((message.content ?? '').length, 0, '取消回合不得留下完整回复')
      }
    } finally {
      reloaded.close()
    }
  })
})
