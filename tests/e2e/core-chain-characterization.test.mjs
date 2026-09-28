// 核心链路端到端 characterization：真宿主 + 真插件 + 真链路，只在最外层边界放假
// （模型厂商 HTTP 桩、Rust 重插件同身份 toy、原生构建步骤）。
// 每个用例在注释里写明**当前实际观测到的行为**；凡属错误行为的基线，注释标明预期由后续改动翻转，此处只钉不修。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  fixturePluginDir,
  historyMessages,
  externPayloads,
  toolParts,
  toolCallResponder,
  NativeTokenizerMissing,
} from '../harness/index.mjs'

/** 起场景；缺原生 tokenizer 时 skip（需先有 context-window 构建产物）。 */
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

test('正常问答回合：run 收口 done、广播齐全、历史落用户与助手两条消息', async (t) => {
  await withScenario(t, { defaultText: 'hello from stub' }, async ({ recorder }) => {
    const { result } = await recorder.sendTurn('你好', { conversationId: 'c-e2e' })

    // 观测：宿主 run 以 done 收口。
    assert.equal(result.status, 'done')
    const finished = recorder.byTopic('run.finished')
    assert.ok(finished.length > 0)
    assert.equal(finished[finished.length - 1].payload.status, 'done')
    // 观测：回合开始事件在派发前上报（UI 在首 token 前有空窗）。
    assert.ok(recorder.byTopic('chat.turn.started').length >= 1)

    // 观测：session 里恰好两条消息（新→旧：助手、用户），助手正文即模型桩返回文本。
    const messages = historyMessages(await recorder.history('c-e2e'))
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'assistant')
    assert.equal(messages[0].content, 'hello from stub')
    assert.equal(messages[1].role, 'user')
    assert.equal(messages[1].content, '你好')
  })
})

test('下游解释器不可达：run 仍收口 done，但回合已开、用户消息保留、结局经回执与事件送出', async (t) => {
  await withScenario(
    t,
    { overrides: { 'loop-policy': fixturePluginDir('toy-loop-policy-broken') }, defaultText: 'unused' },
    async ({ recorder }) => {
      const { result } = await recorder.sendTurn('你好', { conversationId: 'c-e2e' })

      // 观测：run 内核状态仍是 done（run.finished 只表机械终止，不编码业务结局）。
      assert.equal(result.status, 'done')

      // 观测（已翻转，invariant F1/I6）：回合头在调模型前已开，失败走结局通道——
      // 命令回执携带 refused{loop_unavailable}（归因 transport，下游码进 cause），不再被静默吞掉。
      const payloads = externPayloads(result)
      const refusal = payloads.find((payload) => payload?.ok === false && payload?.outcome?.code === 'loop_unavailable')
      assert.ok(refusal, `未观测到 refused{loop_unavailable}：${JSON.stringify(payloads)}`)
      assert.equal(refusal.outcome.kind, 'refused')
      assert.equal(refusal.outcome.attributableTo, 'transport')
      assert.equal(refusal.turn_id !== undefined, true)

      // 观测（通道 2）：全客户端收到 chat.turn.settled，与回执同 turn_id、同结局。
      const settled = recorder.byTopic('chat.turn.settled')
      assert.ok(settled.length >= 1, '终态回合必须广播 chat.turn.settled')
      assert.equal(settled[settled.length - 1].payload.turn_id, refusal.turn_id)
      assert.equal(settled[settled.length - 1].payload.outcome.code, 'loop_unavailable')

      // 观测（已翻转，invariant I1/F1）：历史里用户那条消息保留（不再是空）。
      const history = await recorder.history('c-e2e')
      assert.equal(history.conversation, 'c-e2e')
      const messages = historyMessages(history)
      assert.equal(messages.length, 1)
      assert.equal(messages[0].role, 'user')
      assert.equal(messages[0].content, '你好')
    },
  )
})

test('工具已跑但收口失败：run 收口 done，已完成步骤与工具内容保留（不再什么都不留）', async (t) => {
  await withScenario(
    t,
    { overrides: { session: fixturePluginDir('toy-session-broken') }, responder: toolCallResponder() },
    async ({ recorder }) => {
      const { result } = await recorder.sendTurn('read src/foo.ts', { conversationId: 'c-e2e' })

      // 观测：工具确实派发过（tool.start 至少一次）。
      const toolStarts = recorder.events.filter((event) => event.topic === 'tool.start')
      assert.ok(toolStarts.length >= 1)

      // 观测：外层 run 仍是 done；回合内容已先落步记录，只有收口（turn_settle）失败。
      assert.equal(result.status, 'done')
      const summary = externPayloads(result).find((payload) => payload?.kind === 'interpret')
      assert.ok(summary)
      assert.equal(summary.ended, 'done')
      assert.equal(summary.outcome.kind, 'committed')
      assert.equal(summary.settled, false, '收口失败：settled=false')
      assert.equal(recorder.byTopic('chat.turn.settled').length, 0, '未终态不收口、不广播')

      // 观测（已翻转，invariant F2/I4）：完成步骤与工具内容保留——用户消息 + 助手消息（工具卡 status=ok）。
      const history = await recorder.history('c-e2e')
      const messages = historyMessages(history)
      assert.equal(messages.length, 2, '不再什么都不留')
      assert.equal(messages[1].role, 'user')
      assert.equal(messages[0].role, 'assistant')
      const parts = toolParts(messages[0])
      assert.equal(parts.length, 1)
      assert.equal(parts[0].status, 'ok', '工具结果随结果步定稿')
      // 步记录（intent 先于执行、result 随后）都在回合记录里。
      const steps = Array.isArray(history.turns) && history.turns.length > 0 ? history.turns[0].steps : []
      assert.ok(steps.some((step) => step.type === 'step.intent'), '意图步保留')
      assert.ok(steps.some((step) => step.type === 'step.result'), '结果步保留')
    },
  )
})

test('连续两回合读同一资源：第二回合不重读，上一回合工具结果以老化消息回灌', async (t) => {
  await withScenario(
    t,
    { responder: toolCallResponder({ afterToolText: 'final answer after tool' }) },
    async ({ recorder, stub }) => {
      const first = await recorder.sendTurn('read src/foo.ts', { conversationId: 'c-x' })
      assert.equal(first.result.status, 'done')
      const afterFirst = stub.requests.length

      const second = await recorder.sendTurn('read src/foo.ts again', { conversationId: 'c-x' })
      assert.equal(second.result.status, 'done')

      // 观测（当前现实，与旧设计描述相反）：第二回合首个模型请求已带上第一回合的工具结果
      // （老化形态：handle + tail），模型据此直接作答，未再派发 read。
      const turnTwoRequests = stub.requests.slice(afterFirst)
      assert.ok(turnTwoRequests.length >= 1)
      assert.ok(JSON.stringify(turnTwoRequests[0]).includes('toy-read:src/foo.ts'))
      assert.equal(turnTwoRequests.length, 1)

      // 观测：历史里两条助手消息都带工具卡；第一回合那条 status=ok。
      const messages = historyMessages(await recorder.history('c-x'))
      const assistantWithTool = messages.filter((message) => toolParts(message).length > 0)
      assert.equal(assistantWithTool.length, 1)
      assert.equal(toolParts(assistantWithTool[0])[0].status, 'ok')
    },
  )
})

test('挂起续跑后：同一回合的助手消息原地更新，工具卡从 pending 更新为 ok', async (t) => {
  await withScenario(
    t,
    {
      responder: toolCallResponder({ args: { path: 'C:/outside/secret.txt' }, afterToolText: 'final after approval' }),
      config: { permission: 'review' },
      extraPlugins: [{ name: 'toy-approval-admin', path: fixturePluginDir('toy-approval-admin') }],
    },
    async ({ recorder, client }) => {
      const first = await recorder.sendTurn('read outside', { conversationId: 'c-appr' })
      assert.equal(first.result.status, 'done')

      // 观测：审批准入使段以 pending 结束；历史里一条 partial 助手消息，工具卡 status=null。
      const pending = externPayloads(first.result).find((payload) => payload?.id !== undefined && payload?.pending !== undefined)
      assert.ok(pending, '未观测到审批挂起')
      const afterSuspend = historyMessages(await recorder.history('c-appr'))
      const suspendedAssistant = afterSuspend.filter((message) => message.role === 'assistant')
      assert.equal(suspendedAssistant.length, 1)
      assert.equal(toolParts(suspendedAssistant[0])[0].status, null)

      // 裁决 accepted，再用返回的游标续跑同一回合。
      const decided = await client.command('e2e.approve', { id: pending.id, verdict: 'accept' })
      const decision = externPayloads(decided).find((payload) => payload?.resume !== undefined)
      assert.ok(decision?.resume, '裁决未返回续跑游标')
      const resumed = await client.command('chat.resume', {
        ...decision.resume.args,
        thread: 't1',
        payload: { verdict: 'accept' },
      })
      assert.equal(resumed.status, 'done')

      // 观测（已翻转，invariant I1）：续跑续用同一 turn_id，助手消息**原地更新**——
      // 只此一条助手消息，工具卡 status 由 null 更新为 ok；不再产生第二条冻结在 pending 的消息。
      const afterResume = historyMessages(await recorder.history('c-appr'))
      const assistants = afterResume.filter((message) => message.role === 'assistant')
      assert.equal(assistants.length, 1, '一个 turn_id 只有一条助手消息')
      assert.equal(assistants[0].content, 'final after approval')
      assert.equal(toolParts(assistants[0])[0].status, 'ok', '工具卡状态已更新')
      // 事件通道：续跑终态同样广播 chat.turn.settled，且与开始事件同 turn_id。
      const started = recorder.byTopic('chat.turn.started')
      const settledEvents = recorder.byTopic('chat.turn.settled')
      assert.ok(settledEvents.length >= 1, '续跑收口广播 chat.turn.settled')
      assert.equal(settledEvents[settledEvents.length - 1].payload.turn_id, started[0].payload.turn_id)
      assert.equal(settledEvents[settledEvents.length - 1].payload.outcome.kind, 'committed')
    },
  )
})
