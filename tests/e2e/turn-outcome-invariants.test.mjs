// 回合结局不变量（e2e）：run.finished 只表机械终止；业务结局经三通道送出且与回合记录一致。
// 本文件钉 I3（UI 收束规则：done 无业务结局是契约违背）与录得结局的一致性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bootScenario,
  fixturePluginDir,
  externPayloads,
  foldDisplayOutcome,
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

test('I3：done + 无业务结局是契约违背；有结局则三通道一致', async (t) => {
  await withScenario(
    t,
    { overrides: { 'loop-policy': fixturePluginDir('toy-loop-policy-broken') }, defaultText: 'unused' },
    async ({ recorder }) => {
      const { result } = await recorder.sendTurn('你好', { conversationId: 'c-i3' })
      assert.equal(result.status, 'done', '机械状态仍是 done')

      const refusal = externPayloads(result).find((payload) => payload?.outcome?.kind === 'refused')
      const settled = recorder.byTopic('chat.turn.settled').at(-1)?.payload
      assert.ok(refusal, '命令回执携带业务结局')
      assert.ok(settled, 'chat.turn.settled 广播业务结局')

      // 收束规则：done 必须伴随业务结局；无结局即契约违背（不得静默按成功显示）。
      assert.equal(foldDisplayOutcome('done', null).kind, 'contract_violation')
      assert.deepEqual(foldDisplayOutcome('done', refusal.outcome), refusal.outcome)

      // 三通道一致性：回执 · 事件 · 回合记录同值。
      assert.deepEqual(settled.outcome, refusal.outcome)
      assert.equal(settled.turn_id, refusal.turn_id)
      const history = await recorder.history('c-i3')
      const turn = Array.isArray(history.turns) ? history.turns[0] : null
      assert.ok(turn, '回合记录存在')
      assert.equal(turn.state, 'settled')
      assert.deepEqual(turn.outcome, refusal.outcome, '结局与 session 回合记录一致')
    },
  )
})
