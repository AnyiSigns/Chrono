// 生命周期转换表穷举 + 与拓扑无关：枚举每个 (状态, 事件)，断言声明的转换成立、未声明的一律结构化失败；
// 并断言换一张含 recall 节点的图不改变生命周期枚举；段边界回 `stepping`、挂起回 `suspended`、回合终态回 `settled`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  LifecycleMachine,
  endedOf,
  initialLifecycle,
  transition,
} from '../execute/lifecycle.ts'
import { seedModel } from '../execute/seed.ts'
import { startService, directivesOf } from './driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = JSON.parse(readFileSync(join(HERE, '..', 'schema', 'graph.json'), 'utf8'))

/** 声明的目标转换：穷举测试据此判定「已声明 / 未声明」。 */
const INTENDED = {
  assembled: { step: 'stepping', settle: 'settling' },
  stepping: { segment: 'stepping', suspend: 'suspended', settle: 'settling' },
  suspended: {},
  settling: { finalize: 'settled' },
  settled: {},
}

const PROGRESS = { iter: 1, node_index: null, contract_id: null }

function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind !== 'extern' || !directive.payload) continue
    // 段终态摘要 kind 为 stepping，回合终态为 interpret；两者都取。
    if (directive.payload.kind === 'interpret' || directive.payload.kind === 'stepping') return directive.payload
  }
  return null
}

test('转换表与声明一致：assembled → stepping → suspended | settling → settled', () => {
  assert.deepEqual(LIFECYCLE_TRANSITIONS, INTENDED)
  assert.deepEqual([...LIFECYCLE_STATES], ['assembled', 'stepping', 'suspended', 'settling', 'settled'])
  assert.deepEqual([...LIFECYCLE_EVENTS], ['step', 'segment', 'suspend', 'settle', 'finalize'])
  assert.equal(initialLifecycle(PROGRESS).state, 'assembled')
})

test('穷举每个 (状态, 事件)：声明内转换成立，未声明一律结构化失败且不改状态', () => {
  for (const state of LIFECYCLE_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      const target = INTENDED[state][event]
      const before = { state, progress: { ...PROGRESS } }
      const result = transition(before, event)
      if (target === undefined) {
        assert.equal(result.ok, false, `${state}--${event} 应拒绝`)
        assert.equal(result.failure.code, 'invalid_transition')
        assert.equal(result.failure.from, state)
        assert.equal(result.failure.event, event)
        assert.deepEqual(before, { state, progress: { ...PROGRESS } }, '拒绝不得静默改状态')
      } else {
        assert.equal(result.ok, true, `${state}--${event} 应成立`)
        assert.equal(result.lifecycle.state, target)
      }
    }
  }
})

test('LifecycleMachine：非允许转换是结构化失败，不静默改状态', () => {
  const machine = new LifecycleMachine({ ...PROGRESS })
  machine.send('step')
  assert.equal(machine.state, 'stepping')
  const rejected = machine.send('suspend') // stepping 允许挂起——先验证允许路径
  assert.equal(rejected.ok, true)
  assert.equal(machine.state, 'suspended')
  // suspended 无出边：任何事件都拒绝，且状态与失败原样暴露、不发生静默变更。
  for (const event of LIFECYCLE_EVENTS) {
    const before = machine.state
    const result = machine.send(event)
    assert.equal(result.ok, false, `suspended--${event} 应拒绝`)
    assert.equal(result.failure.code, 'invalid_transition')
    assert.equal(machine.state, before, `suspended--${event} 不得静默改状态`)
    assert.deepEqual(machine.failure, { code: 'invalid_transition', from: 'suspended', event })
  }
})

test('表对目标集完备：从 assembled 可达全部状态、settled 无出边、事件名合法', () => {
  const reachable = new Set(['assembled'])
  let changed = true
  while (changed) {
    changed = false
    for (const state of [...reachable]) {
      for (const target of Object.values(INTENDED[state])) {
        if (!reachable.has(target)) {
          reachable.add(target)
          changed = true
        }
      }
    }
  }
  assert.deepEqual([...reachable].sort(), [...LIFECYCLE_STATES].sort())
  assert.deepEqual(Object.keys(INTENDED.settled), [])
  for (const state of LIFECYCLE_STATES) {
    for (const event of Object.keys(INTENDED[state])) {
      assert.ok(LIFECYCLE_EVENTS.includes(event), `未声明事件 ${event}`)
      assert.ok(LIFECYCLE_STATES.includes(INTENDED[state][event]), `未知目标状态 ${INTENDED[state][event]}`)
    }
  }
})

test('契约声明与运行期实现一致：schema/graph.json 的 lifecycle 与转换表逐项对齐', () => {
  assert.deepEqual(SCHEMA.lifecycle.states, [...LIFECYCLE_STATES])
  assert.deepEqual(SCHEMA.lifecycle.events, [...LIFECYCLE_EVENTS])
  assert.deepEqual(SCHEMA.lifecycle.transitions, INTENDED)
  assert.deepEqual(SCHEMA.lifecycle.terminal, ['settled'])
})

test('段边界回 stepping、回合终态回 settled：seed 图与含 recall 的图共用同一枚举', async () => {
  const seed = seedModel()
  const graph = {
    contracts: seed.contracts,
    nodes: seed.nodes,
    prompts: seed.prompts,
    graph: {
      nodes: ['context.assemble', 'recall', 'turn.commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'task'] },
        { from: [1, 'recall'], to: [2, 'message'] },
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

test('endedOf：stepping 回 stepping、suspended 回 pending、settled 取回合结局', () => {
  assert.equal(endedOf('stepping', 'done'), 'stepping')
  assert.equal(endedOf('suspended', 'done'), 'pending')
  assert.equal(endedOf('settled', 'done'), 'done')
  assert.equal(endedOf('settled', 'refused'), 'refused')
  assert.equal(endedOf('settled', 'cancelled'), 'cancelled')
})
