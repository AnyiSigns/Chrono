import { describe, expect, it } from 'vitest'
import type { AssemblyPlan, DependencyEdge, IsolatedIdentity } from '../index.ts'
import { buildOwnerIndex, computeAssemblyPlan } from '../index.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function h(s: string): string {
  return s.repeat(64)
}

function def(body: Json, sig?: string): { body: Json; sig: string } {
  return { body, sig: sig ?? h('d') }
}

function gen(
  payload: string,
  sig = h('g'),
  pins: Record<string, string> = {},
): {
  seq: number
  payload: string
  pins: Record<string, string>
  sig: string
  adopted: { at: number; by: string; write: string }
} {
  return { seq: 0, payload, pins, sig, adopted: { at: 0, by: '', write: '' } }
}

function makeWorld(
  ids: Record<
    string,
    {
      id: string
      schema: string
      gens: ReturnType<typeof gen>[]
      active: string | null
      born: { at: number; by: string }
    }
  >,
  defs?: Record<string, { body: Json; sig: string }>,
): {
  defs: Record<string, { body: Json; sig: string }>
  ids: Record<
    string,
    {
      id: string
      schema: string
      gens: ReturnType<typeof gen>[]
      active: string | null
      born: { at: number; by: string }
    }
  >
} {
  return {
    defs: defs ?? {},
    ids,
  }
}

describe('闭包 closure', () => {
  describe('buildOwnerIndex', () => {
    it('仅 payload 映射到属主；sig 不在索引中', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const world = makeWorld({
        A: { id: 'A', schema: '', gens: [gen(pA, sA, {})], active: pA, born: { at: 0, by: '' } },
        B: { id: 'B', schema: '', gens: [gen(pB, sB, {})], active: pB, born: { at: 0, by: '' } },
      })
      const index = buildOwnerIndex(world)
      expect(index.get(pA)).toBe('A')
      expect(index.get(pB)).toBe('B')
      expect(index.get(sA)).toBeUndefined()
      expect(index.get(sB)).toBeUndefined()
    })

    it('活跃世代 payload 优先；历史世代 payload 也进索引', () => {
      const p0 = h('p0')
      const p1 = h('p1')
      const world = makeWorld({
        B: {
          id: 'B',
          schema: '',
          gens: [gen(p0, h('s0'), {}), gen(p1, h('s1'), {})],
          active: p1,
          born: { at: 0, by: '' },
        },
      })
      const index = buildOwnerIndex(world)
      expect(index.get(p1)).toBe('B')
      expect(index.get(p0)).toBe('B')
    })

    it('payload-only：历史 gens 的 sig 均不在索引', () => {
      const p0 = h('p0')
      const s0 = h('s0')
      const p1 = h('p1')
      const s1 = h('s1')
      const world = makeWorld({
        B: {
          id: 'B',
          schema: '',
          gens: [gen(p0, s0, {}), gen(p1, s1, {})],
          active: p1,
          born: { at: 0, by: '' },
        },
      })
      const index = buildOwnerIndex(world)
      expect(index.get(p0)).toBe('B')
      expect(index.get(p1)).toBe('B')
      expect(index.get(s0)).toBeUndefined()
      expect(index.get(s1)).toBeUndefined()
    })

    it('身份 id 字典序决定同 key 多属主时的归属（确定性）', () => {
      const shared = h('shared')
      const world = makeWorld({
        Z: {
          id: 'Z',
          schema: '',
          gens: [gen(shared, h('sz'), {})],
          active: shared,
          born: { at: 0, by: '' },
        },
        A: {
          id: 'A',
          schema: '',
          gens: [gen(shared, h('sa'), {})],
          active: shared,
          born: { at: 0, by: '' },
        },
      })
      const index = buildOwnerIndex(world)
      expect(index.get(shared)).toBe('A')
    })
  })

  describe('computeAssemblyPlan', () => {
    const d = (
      name: string,
      payload: string,
      sig = h(name),
      pins: Record<string, string> = {},
      active: string | null = payload,
    ): {
      id: string
      schema: string
      gens: ReturnType<typeof gen>[]
      active: string | null
      born: { at: number; by: string }
    } => ({
      id: name,
      schema: '',
      gens: [{ seq: 0, payload, pins, sig, adopted: { at: 0, by: '', write: '' } }],
      active,
      born: { at: 0, by: '' },
    })

    // ---------- 1. 线性链 A←B←C（B pins A，C pins B） ----------
    it('线性链：启动序为 A,B,C；无孤立/环', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        { A: d('A', pA, sA, {}), B: d('B', pB, sB, { dep: pA }), C: d('C', pC, sC, { dep: pB }) },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['A', 'B', 'C'])
      expect(plan.isolated).toEqual([])
      expect(plan.cycles).toEqual([])
      expect(plan.edges).toEqual([
        { from: 'B', to: 'A' },
        { from: 'C', to: 'B' },
      ])
    })

    // ---------- 1b. 保留 pin host：不建边、不孤立 ----------
    it('保留 pin host：不建依赖边、不置 depFailed、身份照常加载', () => {
      const pA = h('pA')
      const sA = h('sA')
      const world = makeWorld(
        { A: d('A', pA, sA, { host: 'host' }) },
        { [pA]: def(null, sA), [sA]: def(null) },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['A'])
      expect(plan.isolated).toEqual([])
      expect(plan.edges).toEqual([])
    })

    // ---------- 2. 菱形 D pins B,C；B,C pins A ----------
    it('菱形：A 先于 B/C，B/C 先于 D', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const pD = h('pD')
      const sD = h('sD')
      const world = makeWorld(
        {
          A: d('A', pA, sA, {}),
          B: d('B', pB, sB, { dep: pA }),
          C: d('C', pC, sC, { dep: pA }),
          D: d('D', pD, sD, { x: pB, y: pC }),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
          [pD]: def(null, sD),
          [sD]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      const order = plan.order
      expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'))
      expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'))
      expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'))
      expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'))
      expect(plan.isolated).toEqual([])
      expect(plan.cycles).toEqual([])
    })

    // ---------- 3. 缺失 pin ----------
    it('缺失 pin：被依赖身份孤立 stale，依赖者也 stale，独立身份仍在序中', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        {
          A: d('A', pA, sA, {}),
          B: d('B', pB, sB, { dep: h('ghost') }),
          C: d('C', pC, sC, { dep: pB }),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['A'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['B', 'C'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'stale')).toBe(true)
    })

    // ---------- 4. 退役依赖 ----------
    it('退役依赖：依赖 retired 身份的身份被孤立 stale', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, {}, null),
          C: d('C', pC, sC, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['C'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'stale')).toBe(true)
    })

    // ---------- 5. 成环 A↔B，C 依赖 A ----------
    it('成环：环成员及其依赖者均 cycle 孤立，独立身份正常加载', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const pD = h('pD')
      const sD = h('sD')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, { dep: pA }),
          C: d('C', pC, sC, { dep: pA }),
          D: d('D', pD, sD, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
          [pD]: def(null, sD),
          [sD]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['D'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A', 'B', 'C'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'cycle')).toBe(true)
      expect(plan.cycles).toEqual([['A', 'B']])
      expect(plan.edges).toEqual(
        expect.arrayContaining([
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
          { from: 'C', to: 'A' },
        ]),
      )
    })

    // ---------- 6. 自 pin ----------
    it('自 pin：孤立 cycle', () => {
      const pA = h('pA')
      const sA = h('sA')
      const world = makeWorld(
        { A: d('A', pA, sA, { self: pA }) },
        { [pA]: def(null, sA), [sA]: def(null) },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated).toEqual([{ id: 'A', reason: 'cycle' }])
      expect(plan.cycles).toEqual([['A']])
    })

    // ---------- 7. 版本漂移：A pin B 旧 payload，B.active 已移到新 payload ----------
    it('版本漂移：pin 历史 payload 仍解析到同身份，不孤立', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB0 = h('pB0')
      const sB0 = h('sB0')
      const pB1 = h('pB1')
      const sB1 = h('sB1')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB0 }),
          B: {
            id: 'B',
            schema: '',
            gens: [gen(pB0, sB0, {}), gen(pB1, sB1, {})],
            active: pB1,
            born: { at: 0, by: '' },
          },
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB0]: def(null, sB0),
          [sB0]: def(null),
          [pB1]: def(null, sB1),
          [sB1]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['B', 'A'])
      expect(plan.isolated).toEqual([])
      expect(plan.edges).toEqual([{ from: 'A', to: 'B' }])
    })

    // ---------- 8. 自完整性：active payload 不在 defs ----------
    it('自完整性失败：active payload 缺少 def → stale 孤立', () => {
      const pA = h('pA')
      const sA = h('sA')
      const world = makeWorld({ A: d('A', pA, sA, {}) }, { [sA]: def(null) })
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated).toEqual([{ id: 'A', reason: 'stale' }])
      expect(plan.cycles).toEqual([])
    })

    // ---------- 9. 确定性：两次调用返回深度相等的计划 ----------
    it('确定性：同世界两次计算返回深度相等的计划', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const world = makeWorld(
        { A: d('A', pA, sA, {}), B: d('B', pB, sB, { dep: pA }) },
        { [pA]: def(null, sA), [sA]: def(null), [pB]: def(null, sB), [sB]: def(null) },
      )
      const a = computeAssemblyPlan(world)
      const b = computeAssemblyPlan(world)
      expect(a).toEqual(b)
      expect(a).not.toBe(b)
    })

    // ---------- 10. events kinds 与 reasons 完全镜像 ----------
    it('events 的 kind 与 isolated 的 reason 完全镜像', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, { dep: h('ghost') }),
          C: d('C', pC, sC, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.events).toEqual(
        plan.isolated.map((entry: IsolatedIdentity) => ({ kind: entry.reason, id: entry.id })),
      )
    })

    // ---------- 附加：isolated 按 id 排序 ----------
    it('isolated 按 id 排序，events 与 isolated 长度一致', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        {
          C: d('C', pC, sC, { dep: h('ghost') }),
          B: d('B', pB, sB, { dep: pC }),
          A: d('A', pA, sA, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      const ids = plan.isolated.map((x: IsolatedIdentity) => x.id)
      expect(ids).toEqual([...ids].sort())
      expect(plan.events).toHaveLength(plan.isolated.length)
    })

    // ---------- 附加：cycle 优先 stale（同身份 stale+cycle 记 cycle） ----------
    it('同身份同时 stale+cycle 时 reason 为 cycle', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: h('ghost'), loop: pB }),
          B: d('B', pB, sB, { dep: pA }),
        },
        { [pA]: def(null, sA), [sA]: def(null), [pB]: def(null, sB), [sB]: def(null) },
      )
      const plan = computeAssemblyPlan(world)
      const entry = plan.isolated.find((x: IsolatedIdentity) => x.id === 'A')
      expect(entry?.reason).toBe('cycle')
    })

    // ---------- 附加：缺失 pin 且 pin 值碰巧是某身份的 sig → 仍 stale（fail-closed） ----------
    it('缺失 pin 且值为某身份 sig：仍 stale，不静默连接', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      // A 的 dep pin 碰巧等于 B 的 gen.sig（不是 payload）→ ownerIndex 不含 sB → undefined → stale
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: sB }),
          B: d('B', pB, sB, {}),
          C: d('C', pC, sC, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['B', 'C'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'stale')).toBe(true)
    })

    // ---------- 附加：payload-def stale — sig 不匹配 ----------
    it('payload-def stale：def.sig ≠ gen.sig → 身份 stale', () => {
      const pA = h('pA')
      const sA = h('sA')
      const wrongSig = h('wrong')
      const world = makeWorld(
        { A: d('A', pA, sA, {}) },
        { [pA]: def(null, wrongSig), [sA]: def(null) },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated).toEqual([{ id: 'A', reason: 'stale' }])
    })

    it('payload-def stale：def.sig = gen.sig 且 def.pins 匹配 → 正常加载', () => {
      const pA = h('pA')
      const sA = h('sA')
      const world = makeWorld({ A: d('A', pA, sA, {}) }, { [pA]: def(null, sA), [sA]: def(null) })
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['A'])
      expect(plan.isolated).toEqual([])
    })

    it('payload-def stale：def.pins 值与 gen.pins 不匹配 → stale', () => {
      const pA = h('pA')
      const sA = h('sA')
      const wrongPin = h('wrongpin')
      const world = makeWorld(
        { A: d('A', pA, sA, {}) },
        {
          [pA]: { body: null as Json, sig: sA, pins: { foo: wrongPin } } as {
            body: Json
            sig: string
          },
          [sA]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated).toEqual([{ id: 'A', reason: 'stale' }])
    })

    // ---------- 附加：复杂 DAG 全序约束验证 ----------
    it('复杂 DAG：A→B, A→C, B→D, C→D, D→E；所有边约束满足', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const pD = h('pD')
      const sD = h('sD')
      const pE = h('pE')
      const sE = h('sE')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { b: pB, c: pC }),
          B: d('B', pB, sB, { d: pD }),
          C: d('C', pC, sC, { d: pD }),
          D: d('D', pD, sD, { e: pE }),
          E: d('E', pE, sE, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
          [pD]: def(null, sD),
          [sD]: def(null),
          [pE]: def(null, sE),
          [sE]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      const order = plan.order
      const pos = new Map(order.map((id, i) => [id, i]))
      // E before D; D before B and C; B and C before A
      expect(pos.get('E')!).toBeLessThan(pos.get('D')!)
      expect(pos.get('D')!).toBeLessThan(pos.get('B')!)
      expect(pos.get('D')!).toBeLessThan(pos.get('C')!)
      expect(pos.get('B')!).toBeLessThan(pos.get('A')!)
      expect(pos.get('C')!).toBeLessThan(pos.get('A')!)
      expect(order).toEqual(['E', 'D', 'B', 'C', 'A'])
      expect(plan.isolated).toEqual([])
      expect(plan.cycles).toEqual([])
    })

    // ---------- 附加：退役依赖距离 ≥2 ----------
    it('退役依赖距离>=2：B retired，A 依赖 B，C 依赖 A → A 和 C 均 stale', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const world = makeWorld(
        {
          C: d('C', pC, sC, { dep: pA }),
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, {}, null),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A', 'C'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'stale')).toBe(true)
    })

    // ---------- 附加：多个独立环 ----------
    it('多个独立环：A↔B 与 C↔D 均 cycle 孤立，E 正常加载', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const pD = h('pD')
      const sD = h('sD')
      const pE = h('pE')
      const sE = h('sE')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, { dep: pA }),
          C: d('C', pC, sC, { dep: pD }),
          D: d('D', pD, sD, { dep: pC }),
          E: d('E', pE, sE, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
          [pD]: def(null, sD),
          [sD]: def(null),
          [pE]: def(null, sE),
          [sE]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['E'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A', 'B', 'C', 'D'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'cycle')).toBe(true)
      expect(plan.cycles).toEqual([
        ['A', 'B'],
        ['C', 'D'],
      ])
    })

    // ---------- 附加：3 节点环 + 距离 2 依赖者 ----------
    it('3 节点环 A→B→C→A，D 依赖 B → A,B,C,D 均 cycle 孤立', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const pC = h('pC')
      const sC = h('sC')
      const pD = h('pD')
      const sD = h('sD')
      const pE = h('pE')
      const sE = h('sE')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pC }),
          B: d('B', pB, sB, { dep: pA }),
          C: d('C', pC, sC, { dep: pB }),
          D: d('D', pD, sD, { dep: pB }),
          E: d('E', pE, sE, {}),
        },
        {
          [pA]: def(null, sA),
          [sA]: def(null),
          [pB]: def(null, sB),
          [sB]: def(null),
          [pC]: def(null, sC),
          [sC]: def(null),
          [pD]: def(null, sD),
          [sD]: def(null),
          [pE]: def(null, sE),
          [sE]: def(null),
        },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual(['E'])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A', 'B', 'C', 'D'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'cycle')).toBe(true)
      expect(plan.cycles).toEqual([['A', 'B', 'C']])
    })

    // ---------- 附加：所有根都在环中 → order 空 ----------
    it('所有根均在环中：order 为空，全部 cycle 孤立', () => {
      const pA = h('pA')
      const sA = h('sA')
      const pB = h('pB')
      const sB = h('sB')
      const world = makeWorld(
        {
          A: d('A', pA, sA, { dep: pB }),
          B: d('B', pB, sB, { dep: pA }),
        },
        { [pA]: def(null, sA), [sA]: def(null), [pB]: def(null, sB), [sB]: def(null) },
      )
      const plan = computeAssemblyPlan(world)
      expect(plan.order).toEqual([])
      expect(plan.isolated.map((x: IsolatedIdentity) => x.id).sort()).toEqual(['A', 'B'])
      expect(plan.isolated.every((x: IsolatedIdentity) => x.reason === 'cycle')).toBe(true)
      expect(plan.cycles).toEqual([['A', 'B']])
    })
  })
})
