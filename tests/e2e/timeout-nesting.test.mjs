// 超时嵌套（F10 锚点）：外层安全网严格大于内层，内层先收口、无幽灵提交。
//
// 现实：真实到期需要「多分钟慢调用 + 外层小时级计时器」的等待，e2e 不可行（method_timeouts 见
// chat.send 6_300_000 / loop-policy.interpret 6_000_000 / model.chat 3_600_000 / tools.dispatch
// 1_800_000）。故本文件钉两条**可达**的不变量：
//   1. 运行时：一次「慢但仍在推进」的内层模型调用（stub 延迟 1.5s 后正常回包）在预算内正常收口，
//      且**不被重试**（只发一次请求）——内层一开始就不再被外层提前判死、也不再补发。
//   2. 声明层：读真实插件声明，断言外层计时严格大于内层（chat.send > interpret > model.chat >
//      tools.dispatch），且 session / context-window 显式声明了 method_timeouts（不落 30s 缺省）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootScenario, historyMessages, REPO_ROOT, NativeTokenizerMissing } from '../harness/index.mjs'

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

function readTimeoutTable(...segments) {
  const body = JSON.parse(readFileSync(join(REPO_ROOT, ...segments), 'utf8'))
  return body['method_timeouts'] ?? {}
}

test('内层慢调用：预算内正常收口且不重试（无幽灵提交）', async (t) => {
  await withScenario(
    t,
    { responder: () => ({ type: 'text', text: 'slow answer', delayMs: 1500 }) },
    async ({ recorder, stub }) => {
      const { result } = await recorder.sendTurn('慢调用', { conversationId: 'c-timeout' })
      assert.equal(result.status, 'done')

      // 收口 committed，且只有一条助手消息（无幽灵 / 无重复收口）。
      const settled = recorder.byTopic('chat.turn.settled').at(-1)?.payload
      assert.ok(settled)
      assert.equal(settled.outcome.kind, 'committed')
      const messages = historyMessages(await recorder.history('c-timeout'))
      assert.equal(messages.filter((message) => message.role === 'assistant').length, 1)

      // 不重试：首条消息的标题旁路段 + 主调用各一次，共两次请求；开始的调用不再补发。
      assert.equal(stub.requests.length, 2, `慢调用不应被重试：实际 ${stub.requests.length} 次请求`)
      assert.equal(stub.aborted.length, 0, '未被提前判死（无中止）')
    },
  )
})

test('声明层：外层计时严格大于内层，且 session / context-window 显式声明超时', () => {
  const chat = readTimeoutTable('plugins', 'chat', 'schema', 'wiring.json')
  const loop = readTimeoutTable('plugins', 'loop-policy', 'schema', 'graph.json')
  const model = readTimeoutTable('plugins', 'model-protocol', 'schema', 'protocol.json')
  const tools = readTimeoutTable('plugins', 'tools', 'schema', 'tools.json')
  const session = readTimeoutTable('plugins', 'session', 'schema', 'session.json')
  const context = readTimeoutTable('plugins', 'context-window', 'schema', 'policy.json')

  // 同步嵌套链：chat.send → interpret → model.chat → tools.dispatch，逐层严格收紧。
  assert.ok(chat['chat.send'] > loop['loop-policy.interpret'], 'chat.send 外层须大于 interpret')
  assert.ok(loop['loop-policy.interpret'] > model['model.chat'], 'interpret 外层须大于 model.chat')
  assert.ok(model['model.chat'] > tools['tools.dispatch'], 'model.chat 外层须大于 tools.dispatch')

  // 叶子 owner 显式声明，不落 30s 缺省（大 jsonl fsync / 组装会造幽灵）。
  assert.ok(session['session.step_append'] >= 120000, 'session 显式声明步追加超时')
  assert.ok(session['session.turn_settle'] >= 120000, 'session 显式声明收口超时')
  assert.ok(context['context.build'] >= 120000, 'context-window 显式声明组装超时')
})
