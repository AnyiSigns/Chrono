// 提问往返的端到端语义（不变量）。
// 真宿主 + 真插件 + 真链路，只在最外层边界放假（模型厂商 HTTP 桩）。
//
// 不变量：
//   1. 工具 question 入队后段以 `awaiting` 收束（挂起事件 `chat.turn.pending`），回合保持 open、
//      不收口——`awaiting` 是段终态，不是回合终态；
//   2. 作答经 `chat.resume`（新 run、同 `turn_id`）续跑：答案回灌为该工具调用的结果，重入的段
//      重跑上下文组装与模型步，模型请求里能看到答案（`question_id`），并据此继续；
//   3. 回合恰好收口一次（CAS 生效），助手消息只有一条且正文非空，工具卡状态由挂起更新为结果。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  historyMessages,
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

/** 首轮用 `question` 工具向用户提问；认出工具结果（作答回灌）后纯文本收尾。 */
function questionThenAnswerResponder(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  if (messages.some((message) => message && message.role === 'tool')) {
    return { type: 'text', text: '收到答案，继续' }
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return {
      type: 'tool_calls',
      calls: [
        {
          id: 'call-q',
          name: 'question',
          arguments: {
            questions: [
              {
                id: 'q1',
                header: '方案确认',
                question: '用哪个方案？',
                options: [{ label: 'A' }, { label: 'B' }],
                multiple: false,
                custom: false,
              },
            ],
          },
        },
      ],
    }
  }
  return { type: 'text', text: 'plain' }
}

test('提问往返：段以 awaiting 挂起、作答续跑把答案回灌模型、同一 turn_id 恰好收口一次', async (t) => {
  await withScenario(t, { responder: questionThenAnswerResponder }, async ({ recorder, client, stub }) => {
    const first = await recorder.sendTurn('需要你确认一下', { conversationId: 'c-q' })
    assert.equal(first.result.status, 'done', '宿主 run 机械 done')
    const afterFirstSend = stub.requests.length

    const started = recorder.byTopic('chat.turn.started')
    assert.ok(started.length >= 1, '回合开始事件已上报')
    const turnId = started[0].payload.turn_id

    const pending = recorder.byTopic('question.pending').at(-1)?.payload
    assert.ok(pending, '入队时上行 question.pending')
    assert.equal(typeof pending.id, 'string')

    // 挂起：段以 awaiting 收束、回合保持 open，不收口；广播挂起事件供 UI 保留在途回合。
    const enqueueSettles = recorder.byTopic('chat.turn.settled')
    assert.equal(enqueueSettles.length, 0, '段终态不收口（无 chat.turn.settled）')
    const turnPending = recorder.byTopic('chat.turn.pending').at(-1)?.payload
    assert.ok(turnPending, '挂起时广播 chat.turn.pending')
    assert.equal(turnPending.pending, 'question')
    assert.equal(turnPending.turn_id, turnId)

    // 一次 send 后历史里只有一条助手消息，问题的工具卡 status=ok（入队成功，尚未作答）。
    const suspended = historyMessages(await recorder.history('c-q'))
    const partial = suspended.filter((message) => message.role === 'assistant')
    assert.equal(partial.length, 1)
    assert.equal(toolParts(partial[0])[0].status, 'ok')
    const beforeAnswer = (await recorder.history('c-q')).turns.find((item) => item.turn_id === turnId)
    assert.equal(beforeAnswer.state, 'open', '答问之前回合仍是 open（awaiting 不是回合终态）')

    // 作答：写作答槽后调 question.answer 命令（入口 term 产续跑计划，宿主执行 chat.resume）。
    await recorder.writeSlot('t1', {
      kind: 'question.answer',
      id: pending.id,
      answers: [{ question_id: 'q1', selected: ['A'] }],
    })
    const answered = await client.command('question.answer', null, { thread: 't1' })
    assert.equal(answered.status, 'done')

    // 续跑续同一 turn_id：所有段启动共用同一 turn_id，收口事件都属于该回合并为 committed。
    const allStarted = new Set(recorder.byTopic('chat.turn.started').map((event) => event.payload.turn_id))
    assert.deepEqual([...allStarted], [turnId], '作答续跑不重铸 turn_id')
    assert.ok(recorder.byTopic('chat.turn.started').some((event) => event.payload.source === 'resume'), '存在续跑段')
    const settled = recorder.byTopic('chat.turn.settled')
    assert.equal(settled.length, 1, '回合恰好收口一次（CAS 只落定一次）')
    assert.equal(settled[0].payload.turn_id, turnId)
    assert.equal(settled[0].payload.outcome.kind, 'committed')

    // 历史：ONE 助手消息（不产生第二条），正文非空、工具卡已更新为结果。
    const final = historyMessages(await recorder.history('c-q'))
    const assistants = final.filter((message) => message.role === 'assistant')
    assert.equal(assistants.length, 1, '一个 turn_id 只有一条助手消息')
    assert.equal(assistants[0].content, '收到答案，继续', '助手正文由该回合收口段写定')

    // 作答后续跑段真的调了模型，且答案进入模型请求（工具结果键 `question_id` 出现）。
    const resumedRequests = stub.requests.slice(afterFirstSend)
    assert.ok(resumedRequests.length >= 1, '作答续跑应有一次模型调用')
    assert.equal(
      resumedRequests.some((body) => JSON.stringify(body).includes('question_id')),
      true,
      '答案须回灌模型上下文',
    )

    // 通道三：session 回合记录 state=settled、outcome=committed。
    const history = await recorder.history('c-q')
    const turn = (Array.isArray(history.turns) ? history.turns : []).find((item) => item.turn_id === turnId)
    assert.ok(turn)
    assert.equal(turn.state, 'settled')
    assert.equal(turn.outcome.kind, 'committed')
  })
})
