// R1 回归：本轮回合（`bag.turn_id`）的用户消息必须保留为 P0 `input`，不得被投影成可裁剪历史项；
// 本轮其余记录（assistant 工具帧 / 工具结果）标本轮口径，排在 input 之后、不被分层老化/丢弃。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, contentOf, startService } from './driver.mjs'

function toolCallsOf(message) {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

function pairingHolds(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    for (const call of toolCallsOf(messages[index])) {
      const found = messages
        .slice(index + 1)
        .some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      if (!found) return false
    }
  }
  return true
}

function currentTurnSession() {
  return {
    turns: [
      {
        turn_id: 't1',
        conv: 'c1',
        at: '2026-01-01T00:00:00.000Z',
        state: 'settled',
        user_message: { content: 'OLD-IN' },
        steps: [{ type: 'step.result', turn_id: 't1', seq: 1, assistant: { content: 'OLD-REPLY' }, tool_results: [] }],
      },
      {
        turn_id: 't2',
        conv: 'c1',
        at: '2026-01-01T00:00:01.000Z',
        state: 'open',
        user_message: { content: 'CUR-IN' },
        steps: [
          { type: 'step.intent', turn_id: 't2', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          { type: 'step.result', turn_id: 't2', seq: 1, assistant: { content: '' }, tool_results: [{ call_id: 'c1', ok: true, result: 'FILE' }] },
        ],
      },
    ],
  }
}

test('R1：本轮用户消息只出现一次且为 P0 input，本轮工具帧排在 input 之后', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'CUR-IN',
        turn_id: 't2',
        system_prompt: 'P',
        session: currentTurnSession(),
        config: { model: 'm1', context_window: 2000, max_output: 100, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)

    const texts = value.messages.map(contentOf)
    const inputCount = texts.filter((text) => text === 'CUR-IN').length
    assert.equal(inputCount, 1, `本轮输入必须恰好一次：${JSON.stringify(texts)}`)
    assert.equal(value.manifest.sources.input.count, 1)
    // 上回合逐条历史 + 本轮 input；本轮 user 不得再作为 history 副本
    assert.equal(value.manifest.sources.history.count, 2)

    const inputIndex = texts.indexOf('CUR-IN')
    const toolIndex = value.messages.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(toolIndex >= 0, '本轮工具结果必须回灌')
    assert.ok(inputIndex >= 0 && inputIndex < toolIndex, `input 须在工具帧之前：input=${inputIndex} tool=${toolIndex}`)
    for (const text of ['OLD-IN', 'OLD-REPLY']) {
      assert.ok(texts.indexOf(text) < inputIndex, `${text} 属历史，应在 input 之前`)
    }
    assert.equal(pairingHolds(value.messages), true)
  } finally {
    drv.close()
  }
})

test('R1：本轮超长输入走显式收缩（而非被当历史裁剪或硬错）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const huge = 'X'.repeat(20000)
    const session = {
      turns: [
        {
          turn_id: 't1',
          conv: 'c1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'open',
          user_message: { content: huge },
          steps: [],
        },
      ],
    }
    const value = await drv.build(
      baseBag({
        input: huge,
        turn_id: 't1',
        system_prompt: 'P',
        session,
        config: { model: 'm1', context_window: 200, max_output: 1, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)
    // 超长本轮输入不得被当可裁剪历史整条丢弃、也不得硬错；由显式“过大输入/截断”路径收缩。
    assert.ok(
      value.manifest.degraded.includes('trim_oversized_user') || value.manifest.degraded.includes('truncate_input'),
      `超长本轮输入须走显式收缩：${JSON.stringify(value.manifest.degraded)}`,
    )
    assert.ok(value.manifest.used <= value.manifest.budget)
    assert.equal(value.manifest.sources.input.count, 1)
    const surviving = value.messages.find((message) => message.role === 'user')
    assert.ok(surviving !== undefined, '本轮输入不得整条消失')
    assert.ok(contentOf(surviving).length < huge.length, '超长输入须被显式收缩')
  } finally {
    drv.close()
  }
})
