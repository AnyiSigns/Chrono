// 生命周期状态机纯函数级测试：转换表穷举 + 与拓扑无关。schema 声明（loop-policy 数据契约）与本机
// 转换表逐项对齐（跨插件一致性以 fs 读取声明文件核验，不 import 兄弟插件源码）。
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

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'loop-policy', 'schema', 'graph.json'), 'utf8'),
)

/** 声明的目标转换：穷举测试据此判定「已声明 / 未声明」。 */
const INTENDED = {
  assembled: { step: 'stepping', settle: 'settling' },
  stepping: { segment: 'stepping', suspend: 'suspended', settle: 'settling' },
  suspended: {},
  settling: { finalize: 'settled' },
  settled: {},
}

const PROGRESS = { iter: 1, node_index: null, contract_id: null }

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
  const rejected = machine.send('suspend')
  assert.equal(rejected.ok, true)
  assert.equal(machine.state, 'suspended')
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

test('endedOf：stepping 回 stepping、suspended 回 pending、settled 取回合结局', () => {
  assert.equal(endedOf('stepping', 'done'), 'stepping')
  assert.equal(endedOf('suspended', 'done'), 'pending')
  assert.equal(endedOf('settled', 'done'), 'done')
  assert.equal(endedOf('settled', 'refused'), 'refused')
  assert.equal(endedOf('settled', 'cancelled'), 'cancelled')
})
