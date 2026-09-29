// 能力需求的闭包相不变量：`needs` 只住 `commit.body.meta.needs`，不进 `gen.pins`，
// 因而不产生任何装配依赖边——提供方退役 / 缺席只影响该能力调用，不连坐消费方。

import { describe, expect, it } from 'vitest'
import { computeAssemblyPlan } from '../index.ts'
import type { World } from '../../../kernel/index.ts'

/** 合成身份规格：`metaNeeds` 给定即把绑定写进 payload def 的 `body.meta.needs`（模拟真实 commit）。 */
interface IdSpec {
  payload: string
  sig: string
  pins?: Record<string, string>
  metaNeeds?: Record<string, string>
  active?: string | null
}

function h(s: string): string {
  return s.repeat(64)
}

function worldOf(specs: Record<string, IdSpec>): World {
  const defs: World['defs'] = {}
  const ids: World['ids'] = {}
  for (const [id, spec] of Object.entries(specs)) {
    defs[spec.payload] = {
      body: spec.metaNeeds === undefined ? null : { meta: { needs: spec.metaNeeds } },
      sig: spec.sig,
    }
    defs[spec.sig] = { body: null }
    ids[id] = {
      id,
      schema: '',
      gens: [
        {
          seq: 0,
          payload: spec.payload,
          pins: spec.pins ?? {},
          sig: spec.sig,
          adopted: { at: 0, by: '', write: '' },
        },
      ],
      active: spec.active === undefined ? spec.payload : spec.active,
      born: { at: 0, by: '' },
    }
  }
  return { defs, ids }
}

describe('能力需求 needs：闭包相不建边', () => {
  const CONSUMER = { payload: h('consumerP'), sig: h('consumerS') }

  it('有 / 无 needs 的同一世界：装配计划逐项相同，无涉及消费方的边', () => {
    const providerA = { payload: h('pAP'), sig: h('pAS') }
    const providerB = { payload: h('pBP'), sig: h('pBS') }
    const base = worldOf({
      consumer: { ...CONSUMER, pins: {} },
      'prov-a': providerA,
      'prov-b': providerB,
    })
    const withNeeds = worldOf({
      consumer: {
        ...CONSUMER,
        pins: {},
        metaNeeds: { 'cap.one': 'prov-a', 'cap.many': 'prov-b' },
      },
      'prov-a': providerA,
      'prov-b': providerB,
    })

    const planBase = computeAssemblyPlan(base)
    const planNeeds = computeAssemblyPlan(withNeeds)
    expect(planNeeds).toEqual(planBase)
    expect(planNeeds.edges).toEqual([])
    expect(planNeeds.isolated).toEqual([])
    expect(planNeeds.order).toContain('consumer')
    // 绑定只住 meta，不写 gen.pins
    expect(withNeeds.ids['consumer'].gens[0].pins).toEqual({})
  })

  it('绑定提供方退役：消费方仍在启动序、不被隔离', () => {
    const world = worldOf({
      consumer: {
        ...CONSUMER,
        pins: {},
        metaNeeds: { 'cap.one': 'prov-a' },
      },
      'prov-a': { payload: h('pAP'), sig: h('pAS'), active: null },
    })
    const plan = computeAssemblyPlan(world)
    expect(plan.order).toEqual(['consumer'])
    expect(plan.isolated).toEqual([])
    expect(plan.edges).toEqual([])
  })

  it('对照：显式 pins 指向退役身份仍连坐（needs 才解耦）', () => {
    const retiredPayload = h('pAP')
    const world = worldOf({
      consumer: { ...CONSUMER, pins: { 'cap.one': retiredPayload } },
      'prov-a': { payload: retiredPayload, sig: h('pAS'), active: null },
    })
    const plan = computeAssemblyPlan(world)
    expect(plan.order).toEqual([])
    expect(plan.isolated).toEqual([{ id: 'consumer', reason: 'stale' }])
  })
})
