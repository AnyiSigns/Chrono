// 生命周期协议级测试：段边界回 `stepping`、换图不改变枚举外的生命周期；回合终态回 `settled`。
// 生命周期转换表本身（纯状态机）在 graph-run 侧覆盖；此处只验证门面 + 执行引擎经协议回传的生命周期。
import test from 'node:test'
import assert from 'node:assert/strict'
import { seedModel } from '../execute/seed.ts'
import { startService, directivesOf } from './driver.mjs'

const LIFECYCLE_STATES = ['assembled', 'stepping', 'suspended', 'settling', 'settled']

function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind !== 'extern' || !directive.payload) continue
    // 段终态摘要 kind 为 stepping，回合终态为 interpret；两者都取。
    if (directive.payload.kind === 'interpret' || directive.payload.kind === 'stepping') return directive.payload
  }
  return null
}

test('段边界回 stepping、回合终态回 settled：seed 图与换图共用同一枚举', async () => {
  const seed = seedModel()
  const graph = {
    contracts: seed.contracts,
    nodes: seed.nodes,
    prompts: seed.prompts,
    graph: {
      nodes: ['context.assemble', 'join', 'turn.commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'left'] },
        { from: [1, 'merged'], to: [2, 'message'] },
      ],
      entry_supply: [{ type_id: 'task', role: 'task' }],
      loop: { when: '', max_iter: 'max_turn_iter' },
      sink: 2,
    },
    thresholds: seed.thresholds,
    refusal_codes: seed.refusalCodes,
  }
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.lifecycle, 'settled')
    assert.ok(LIFECYCLE_STATES.includes(summary.lifecycle), '换图不得产生枚举外状态')
    assert.equal(typeof summary.progress.iter, 'number')
    assert.equal(typeof summary.progress.contract_id, 'string', '图内进度带 contract_id 供 UI 映射')
  } finally {
    service.close()
  }
})

test('段边界：一次 interpret 以 chat.resume 续跑收口为 stepping（段终态，不是回合终态）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    // 直接单段调用（不走驱动的自动续跑），观察段边界返回值。
    const result = await service.call('loop-policy', 'interpret', {
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'stepping')
    assert.equal(summary.lifecycle, 'stepping')
    assert.ok(
      directivesOf(result.value).some((item) => item.kind === 'eval' && item.command === 'chat.resume'),
      '段边界必须仍返回 chat.resume 续跑 eval',
    )
    // 续跑 args 带下一段图内进度：chat 在下一段 `chat.turn.started` 上广播，UI 轮次实时前进。
    const resume = directivesOf(result.value).find((item) => item.kind === 'eval' && item.command === 'chat.resume')
    assert.equal(resume.args.turn_id, 't1')
    assert.equal(typeof resume.args.progress.iter, 'number')
    assert.equal(resume.args.progress.iter, summary.progress.iter + 1, 'progress.iter 取下一段序号')
  } finally {
    service.close()
  }
})
