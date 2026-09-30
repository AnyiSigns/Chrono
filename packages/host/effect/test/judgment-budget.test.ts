// 判定总预算（F-09）：一次判定调用的累计 gas、总墙钟（`timeoutMs`）与效果迭代上限各自 fail-closed；
// 预算恰好 / 超 1 的边界与正常判定（既有「攒 results、重求值」续跑）不受影响。

import { describe, expect, it } from 'vitest'
import { createJudgmentRunner } from '../judgment.ts'
import type { JudgmentTarget } from '../judgment.ts'
import type { Def, EffResult, Hash, Json, World } from '../../../kernel/index.ts'

const ENTRY: Hash = 'e'.repeat(64)
const TARGET: JudgmentTarget = {
  owner: 'judge',
  gen: 'g'.repeat(64),
  cap: 'self',
  method: 'm',
  entry: ENTRY,
}

const EFF: Json = ['eff', 'self', 'm', ['c', 1]]

function worldOf(body: Json): World {
  return { defs: { [ENTRY]: { body } as Def }, ids: {} }
}

/** 顺序发射 `count` 条效果（每条各引来一次挂起-回灌）的 term。 */
function effList(count: number): Json {
  return ['list', Array.from({ length: count }, () => EFF as Json)]
}

function countingInvoke(counter: { calls: number }, value?: Json): () => Promise<EffResult> {
  return async () => {
    counter.calls += 1
    return { ok: true, value: value === undefined ? null : value }
  }
}

describe('判定总预算', () => {
  it('累计 gas：跨多次重求值扣减至耗尽 → code gas', async () => {
    const counter = { calls: 0 }
    const runner = createJudgmentRunner({ gas: 2, depth: 64 }, { invoke: countingInvoke(counter) })
    const result = await runner(worldOf(EFF), TARGET, null, 1000)
    expect(result).toEqual({ ok: false, code: 'gas', message: 'judgment failed: gas' })
    expect(counter.calls).toBe(1)
  })

  it('预算恰好：单 eff 判定 gas=4 成功、gas=3 超 1 收口', async () => {
    const counter = { calls: 0 }
    const make = (gas: number) =>
      createJudgmentRunner({ gas, depth: 64 }, { invoke: countingInvoke(counter) })
    const exact = await make(4)(worldOf(EFF), TARGET, null, 1000)
    expect(exact).toEqual({ ok: true, value: null })
    const over = await make(3)(worldOf(EFF), TARGET, null, 1000)
    expect(over).toEqual({ ok: false, code: 'gas', message: 'judgment failed: gas' })
  })

  it('总墙钟：迭代间越过 deadline → code timeout（单次迭代仍由 gas 约束）', async () => {
    let clock = 0
    const runner = createJudgmentRunner(
      { gas: 1_000_000, depth: 64 },
      {
        invoke: async () => {
          clock += 100
          return { ok: true, value: null }
        },
      },
      { now: () => clock },
    )
    const result = await runner(worldOf(EFF), TARGET, null, 10)
    expect(result).toEqual({ ok: false, code: 'timeout', message: 'judgment exceeded time budget' })
  })

  it('效果迭代数超限 → code gas（保留 MAX_JUDGMENT_EFFECTS 语义）', async () => {
    const counter = { calls: 0 }
    const runner = createJudgmentRunner(
      { gas: 1_000_000, depth: 64 },
      { invoke: countingInvoke(counter) },
      { maxEffects: 3 },
    )
    const result = await runner(worldOf(effList(5)), TARGET, null, 1000)
    expect(result).toEqual({ ok: false, code: 'gas', message: 'too many judgment effects' })
    expect(counter.calls).toBe(3)
  })

  it('正常判定不受影响：多 eff 续跑至完成，回灌值按序可见', async () => {
    const counter = { calls: 0 }
    let seq = 0
    const runner = createJudgmentRunner(
      { gas: 1_000_000, depth: 64 },
      {
        invoke: async () => {
          counter.calls += 1
          seq += 1
          return { ok: true, value: seq }
        },
      },
    )
    const result = await runner(worldOf(effList(3)), TARGET, null, 1000)
    expect(result).toEqual({ ok: true, value: [1, 2, 3] })
    expect(counter.calls).toBe(3)
  })

  it('纯项判定：无 eff、无 invoke 依赖也成功，且不触发墙钟收口', async () => {
    const runner = createJudgmentRunner({ gas: 8, depth: 64 })
    const result = await runner(worldOf(['c', 42]), TARGET, null, 1000)
    expect(result).toEqual({ ok: true, value: 42 })
  })
})
