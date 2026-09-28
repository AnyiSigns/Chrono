// 预算超限的端到端语义：用户预算在步边界主动收口，回合以 `committed` + `stop_reason` 结束（不是 `refused`），
// 已完成步骤保留。真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。
// 本文件钉的不变量：预算用尽是主动停，不是失败；内容不因停而丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  externPayloads,
  historyMessages,
  loopPolicyBudgetBody,
  seedIdentityBody,
  toolParts,
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

/** 永远派发下一个 read（不自行收尾）：由预算把它停下。 */
function alwaysToolResponder(body) {
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return { type: 'tool_calls', calls: [{ id: 'call-x', name: 'read', arguments: { path: 'src/foo.ts' } }] }
  }
  return { type: 'text', text: 'title' }
}

test('预算超限：committed + stop_reason=turn_iter，已完成步骤保留（不是 refused）', async (t) => {
  await withScenario(t, { responder: alwaysToolResponder }, async ({ recorder, client }) => {
    // 覆盖 loop-policy 阈值：把回合迭代预算压到 2，使预算先于任何机械上限收口。
    await seedIdentityBody(client, 'loop-policy', loopPolicyBudgetBody({ maxTurnIter: 2 }))

    const { result } = await recorder.sendTurn('一直读文件', { conversationId: 'c-budget' })
    assert.equal(result.status, 'done', '宿主 run 机械 done')

    // 通道一：命令回执携带 committed + stop_reason。
    const receipt = externPayloads(result).find((payload) => payload?.outcome !== undefined)
    assert.ok(receipt, `回执未带结局：${JSON.stringify(externPayloads(result))}`)
    assert.equal(receipt.outcome.kind, 'committed', '预算停不是 refused')
    assert.equal(receipt.outcome.stop_reason, 'turn_iter', 'stop_reason 命名用尽的预算维度')

    // 通道二：chat.turn.settled 广播同结局。
    const settled = recorder.byTopic('chat.turn.settled').at(-1)?.payload
    assert.ok(settled, '终态回合必须广播 chat.turn.settled')
    assert.equal(settled.outcome.kind, 'committed')
    assert.equal(settled.outcome.stop_reason, 'turn_iter')
    assert.equal(settled.turn_id, receipt.turn_id)

    // 通道三：session 回合记录同结局。
    const history = await recorder.history('c-budget')
    const turn = (Array.isArray(history.turns) ? history.turns : []).find((item) => item.turn_id === receipt.turn_id)
    assert.ok(turn)
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'committed')
    assert.equal(turn.outcome.stop_reason, 'turn_iter')

    // 已完成步骤保留：意图 / 结果步都在，工具卡 status=ok。
    const steps = Array.isArray(turn.steps) ? turn.steps : []
    assert.ok(steps.some((step) => step.type === 'step.intent'), '意图步保留')
    assert.ok(steps.some((step) => step.type === 'step.result'), '结果步保留')
    const assistants = historyMessages(history).filter((message) => message.role === 'assistant')
    const cards = assistants.flatMap((message) => toolParts(message))
    assert.ok(cards.length >= 1, '预算停不得丢弃已完成工具卡')
    assert.equal(cards.every((card) => card.status === 'ok'), true)

    // 跑到了预算边界：至少两次工具派发（每段一次）。
    assert.ok(recorder.events.filter((event) => event.topic === 'tool.start').length >= 2)
  })
})
