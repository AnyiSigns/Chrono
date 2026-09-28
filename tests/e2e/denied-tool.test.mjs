// 工具被拒绝的端到端语义：门禁 deny 作工具结果回灌、回合继续（不是 refused）。
// 真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。
// 本文件钉的不变量：拒绝一次工具调用是一次成功执行的 run；拒绝内容必须到达模型，助手正文不得丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  externPayloads,
  historyMessages,
  seedIdentityBody,
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

/** 首轮派发一次 read；认出工具结果后改用纯文本收尾。 */
function denyThenAnswerResponder(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.some((message) => message && message.role === 'tool')) {
    return { type: 'text', text: '改用别的方案' }
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return { type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', arguments: { path: 'src/foo.ts' } }] }
  }
  return { type: 'text', text: 'plain' }
}

test('门禁 deny：作工具结果回灌、回合继续并 committed，助手正文与拒绝内容都在', async (t) => {
  await withScenario(t, { responder: denyThenAnswerResponder }, async ({ recorder, client, stub }) => {
    // 覆盖 guard 规则数据：明确禁止 (tool-fs, read)。deny 优先于档位，不需要 review 档。
    await seedIdentityBody(client, 'guard', {
      deny: { calls: [{ port: 'tool-fs', tool: 'read' }], allowed_ports: null },
    })

    const { result } = await recorder.sendTurn('读一下文件', { conversationId: 'c-deny' })
    assert.equal(result.status, 'done', '宿主 run 机械 done')

    // 通道一：命令回执带 committed 结局。
    const receipt = externPayloads(result).find((payload) => payload?.outcome !== undefined)
    assert.ok(receipt, `回执未带结局：${JSON.stringify(externPayloads(result))}`)
    assert.equal(receipt.outcome.kind, 'committed')
    assert.notEqual(receipt.outcome.attributableTo, 'guard', 'deny 不是 refused{guard}')

    // 通道二：chat.turn.settled 广播同结局。
    const settled = recorder.byTopic('chat.turn.settled').at(-1)?.payload
    assert.ok(settled, '终态回合必须广播 chat.turn.settled')
    assert.equal(settled.outcome.kind, 'committed')
    assert.equal(settled.turn_id, receipt.turn_id)

    // 通道三：session 回合记录同值、state=settled。
    const history = await recorder.history('c-deny')
    const turn = (Array.isArray(history.turns) ? history.turns : []).find((item) => item.turn_id === receipt.turn_id)
    assert.ok(turn, '回合记录存在')
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'committed')

    // 拒绝作工具结果回灌：模型在后续请求里观察到含 denied 的工具消息。
    const deniedRequests = stub.requests.filter((body) =>
      (Array.isArray(body?.messages) ? body.messages : []).some(
        (message) => message && message.role === 'tool' && JSON.stringify(message.content).includes('denied'),
      ),
    )
    assert.ok(deniedRequests.length >= 1, '模型必须收到被拒绝的工具结果')

    // 拒绝不让工具有机会真正执行：dispatch 节点未被激活。
    assert.equal(recorder.events.filter((event) => event.topic === 'tool.start').length, 0)

    // 助手正文不被丢：最终助手消息即模型换方案后的答复。
    const assistants = historyMessages(history).filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, 1)
    assert.equal(assistants[0].content, '改用别的方案')
  })
})
