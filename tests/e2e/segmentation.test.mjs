// 长回合分段端到端：一次 `chat.send` 的长回合被切成多段，每段一次 `interpret`，经段尾 `chat.resume`
// 自续跑在同一 run 内跑完；回合身份不变、收口唯一、助手消息原地更新（不是每段各一条）。
// 真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootScenario, historyMessages, toolParts, NativeTokenizerMissing } from '../harness/index.mjs'

/** 多步工具应答：每次收到一个工具结果就再调下一个工具，够步数后收尾。 */
function multiStepResponder(steps) {
  return (body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const toolCount = messages.filter((message) => message && message.role === 'tool').length
    if (toolCount >= steps) return { type: 'text', text: 'all steps done' }
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      const next = toolCount + 1
      return { type: 'tool_calls', calls: [{ id: `call-${next}`, name: 'read', arguments: { path: `src/f${next}.ts` } }] }
    }
    return { type: 'text', text: 'plain' }
  }
}

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

test('长回合分段：同一 run 同一 turn_id 跑完，逐段计时，助手消息单条原地更新', async (t) => {
  await withScenario(t, { responder: multiStepResponder(3) }, async ({ recorder, stub }) => {
    const { result } = await recorder.sendTurn('read three files', { conversationId: 'c-seg' })

    // 观测：一次 send 覆盖整回合，run 收口 done（段经同 run 内自续跑 eval 连起来）。
    assert.equal(result.status, 'done')

    // 观测：每段各上报一次 chat.turn.started；都属同一 run、同一 turn_id（回合身份不重铸）。
    const started = recorder.byTopic('chat.turn.started')
    assert.ok(started.length >= 4, `三段工具 + 收尾共至少四次段启动：${started.length}`)
    const turnIds = new Set(started.map((event) => event.payload.turn_id))
    const runs = new Set(started.map((event) => event.payload.run))
    assert.equal(turnIds.size, 1, '所有段共用同一 turn_id')
    assert.equal(runs.size, 1, '所有段在同一 run 内')
    assert.ok(started.some((event) => event.payload.source === 'resume'), '存在段续跑段')
    assert.equal(recorder.byTopic('chat.turn.settled').length, 1, '整回合只收口一次')

    // 观测：三段各派发一次工具（逐段推进，而非一个调用跑完）。
    const toolStarts = recorder.events.filter((event) => event.topic === 'tool.start')
    assert.equal(toolStarts.length, 3)

    // 观测：模型收 4 次（三次工具 + 收尾），每次一段，无单次调用跨整回合。
    const chatRequests = stub.requests.filter((body) => Array.isArray(body.tools) && body.tools.length > 0)
    assert.equal(chatRequests.length, 4)

    // 观测：历史只有用户 + 一条助手消息；助手消息带全部三张工具卡（原地更新，不是每段一条）。
    const history = await recorder.history('c-seg')
    const messages = historyMessages(history)
    assert.equal(messages.length, 2)
    assert.equal(messages[1].role, 'user')
    assert.equal(messages[0].role, 'assistant')
    assert.equal(messages[0].content, 'all steps done')
    const parts = toolParts(messages[0])
    assert.equal(parts.length, 3)
    assert.ok(parts.every((part) => part.status === 'ok'))
  })
})
