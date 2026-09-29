// 针尖测试（adapted-with-limitation）：压缩之后，模型仍能答出压缩前做的决定。
// 真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。
//
// 做法：把检查点软阈压到极低，使一次工具回合在段边界必然写一条结构化检查点；检查点由
// `compress.summarize(semantic)`（图外独立模型调用）从整段会话切片产出 `findings`，其中含用户在
// 回合开头的决定句。下一回合提问时，上下文组装把该检查点渲染成一条「发现：…」消息带进模型请求。
//
// 限制（如实登记）：检查点在段边界产出，而回合在检查点之后仍会继续（补段标记与收尾步），
// 故检查点所在回合的 `covered_upto` 永远小于该回合最大步号，`coveredTurnIds` 不会覆盖它——
// 原始历史与本回合的检查点会同时出现在请求里。因此本文件钉的是「后续请求携带检查点蒸馏出的
// 决定」，不是「原始历史被检查点取代」；后者需检查点在回合终态前收口，超出当前实现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  loopPolicyBudgetBody,
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

/** 首回合派发一次 read；认出工具结果后收尾。次回合（问决定）直接文本作答。 */
function decisionResponder(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  // 图外压缩调用（semantic 摘要系统提示）：回结构化摘要 JSON，钉住「压缩前的决定被蒸馏进 findings」。
  if (messages.some((message) => typeof message?.content === 'string' && message.content.includes('上下文压缩器'))) {
    return {
      type: 'text',
      text: JSON.stringify({ goal: '', decisions: [], facts: ['决定：使用蓝色主题'], open_questions: [], files: [], next_steps: [] }),
    }
  }
  if (messages.some((message) => message && message.role === 'tool')) {
    return { type: 'text', text: '已记录决定' }
  }
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
  if (hasTools) {
    return { type: 'tool_calls', calls: [{ id: 'call-1', name: 'read', arguments: { path: 'src/foo.ts' } }] }
  }
  return { type: 'text', text: 'plain' }
}

test('针尖：压缩后仍能从检查点答出压缩前的决定（检查点记录存在且后续请求携带蒸馏决定）', async (t) => {
  await withScenario(t, { responder: decisionResponder }, async ({ recorder, client, stub }) => {
    // 软阈压到 0.01：任何非零上下文压力都在段边界触发一次结构化检查点。
    await seedIdentityBody(client, 'loop-policy', loopPolicyBudgetBody({ checkpointSoftRatio: 0.01 }))

    const first = await recorder.sendTurn('决定：使用蓝色主题。请读取文件。', { conversationId: 'c-needle' })
    assert.equal(first.result.status, 'done')

    // 检查点记录存在，且蒸馏出的 findings 含决定句。
    const afterFirst = await recorder.history('c-needle')
    const turn = (Array.isArray(afterFirst.turns) ? afterFirst.turns : []).find((item) =>
      (item.steps ?? []).some((step) => step.type === 'checkpoint' && step.summary?.findings !== undefined),
    )
    assert.ok(turn, '应写出一条结构化检查点步记录')
    const checkpoint = (turn.steps ?? []).find((step) => step.type === 'checkpoint' && step.summary?.findings !== undefined)
    const claims = (checkpoint.summary.findings ?? []).map((item) => item.claim)
    assert.ok(
      claims.some((claim) => claim.startsWith('决定：使用蓝色主题')),
      `检查点 findings 应含决定句：${JSON.stringify(claims)}`,
    )

    // 下一回合提问：模型请求应携带检查点渲染出的「发现：…」段与决定句。
    const afterFirstSend = stub.requests.length
    const second = await recorder.sendTurn('我之前决定的主题是什么？', { conversationId: 'c-needle' })
    assert.equal(second.result.status, 'done')
    const secondRequests = stub.requests.slice(afterFirstSend)
    assert.ok(secondRequests.length >= 1, '第二回合应有模型调用')
    const carried = secondRequests.some((body) => JSON.stringify(body).includes('发现：'))
    assert.ok(carried, '第二回合模型请求应携带检查点渲染的「发现：」段')
    assert.ok(
      secondRequests.some((body) => JSON.stringify(body).includes('决定：使用蓝色主题')),
      '第二回合模型请求应携带检查点蒸馏出的决定',
    )
  })
})
