// 能力需求的闭包相：`one` 绑定（`commit.body.meta.needs`）按身份名建装配依赖边、跟随 active；
// `many` 不并入单值边。提供方退役 / 缺席使消费方 stale 孤立（fail-closed）。

import { describe, expect, it } from 'vitest'
import { computeAssemblyPlan } from '../index.ts'
import type { World } from '../../../kernel/index.ts'

/** 合成身份规格：`metaNeeds` 给定即把绑定写进 payload def 的 `body.meta.needs`（模拟真实 commit）。 */
interface IdSpec {
  payload: string
  sig: string
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

describe('能力需求 needs：闭包相建依赖边', () => {
  const CONSUMER = { payload: h('consumerP'), sig: h('consumerS') }

  it('one 绑定建边：装配序提供方先于消费方；many 不写绑定', () => {
    const providerA = { payload: h('pAP'), sig: h('pAS') }
    const providerB = { payload: h('pBP'), sig: h('pBS') }
    const world = worldOf({
      consumer: {
        ...CONSUMER,
        // resolved meta.needs 只含 one 绑定；many 不进绑定表
        metaNeeds: { 'cap.one': 'prov-a' },
      },
      'prov-a': providerA,
      'prov-b': providerB,
    })

    const plan = computeAssemblyPlan(world)
    expect(plan.edges).toEqual([{ from: 'consumer', to: 'prov-a' }])
    expect(plan.isolated).toEqual([])
    expect(plan.order.indexOf('prov-a')).toBeLessThan(plan.order.indexOf('consumer'))
    expect(plan.order).toContain('prov-b')
  })

  it('绑定提供方退役：消费方 stale 孤立', () => {
    const world = worldOf({
      consumer: {
        ...CONSUMER,
        metaNeeds: { 'cap.one': 'prov-a' },
      },
      'prov-a': { payload: h('pAP'), sig: h('pAS'), active: null },
    })
    const plan = computeAssemblyPlan(world)
    expect(plan.order).toEqual([])
    expect(plan.isolated).toEqual([{ id: 'consumer', reason: 'stale' }])
  })

  it('绑定目标身份缺席：消费方 stale 孤立（不猜、不静默连接）', () => {
    const world = worldOf({
      consumer: {
        ...CONSUMER,
        metaNeeds: { 'cap.one': 'ghost' },
      },
    })
    const plan = computeAssemblyPlan(world)
    expect(plan.order).toEqual([])
    expect(plan.isolated).toEqual([{ id: 'consumer', reason: 'stale' }])
  })
})
