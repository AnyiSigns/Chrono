// 有界化回收验收：世代窗口边界、可达闭包正确性、graft 下标改写、保守 / 严格两口径。
// 只打公共面 ./index.ts（recycleWorld 经 index 转口）。
import { describe, expect, it } from 'vitest'

import type { Gen, Hash, Json, World } from '../index.ts'
import { EMPTY_HEAD, commit, recycleWorld } from '../index.ts'

/** 合成 64-hex 键（测试夹具；内核不校验键与内容哈希一致）。 */
function h(ch: string): Hash {
  return ch.repeat(64)
}

function gen(
  payload: Hash,
  sig: Hash,
  opts: { pins?: Record<string, Hash>; graft?: Gen['graft']; seq?: number } = {},
): Gen {
  const out: Gen = {
    seq: opts.seq ?? 0,
    payload,
    pins: opts.pins ?? {},
    sig,
    adopted: { at: 1, by: 'test', write: h('0') },
  }
  if (opts.graft !== undefined) out.graft = opts.graft
  return out
}

function world(defs: Hash[], ids: World['ids']): World {
  const table: World['defs'] = {}
  for (const key of defs) table[key] = { body: {} }
  return { defs: table, ids }
}

function bodyOf(w: World, key: Hash, body: Json): void {
  w.defs[key] = { body }
}

function seqs(identity: World['ids'][string]): number[] {
  return identity.gens.map((g) => g.seq)
}

describe('recycleWorld：世代窗口', () => {
  const S = h('s')
  const A = h('a')
  const B = h('b')
  const D = h('d')

  function base(): World {
    return world([S, A, B, D], {
      x: {
        id: 'x',
        schema: S,
        gens: [gen(A, S, { seq: 0 }), gen(B, S, { seq: 1 })],
        active: B,
        born: { at: 1, by: 'test' },
      },
    })
  }

  it('窗口只留最近 N 代 + active；未达 def 按可达性回收（保守：不碰无根 def）', () => {
    const w = base()
    bodyOf(w, B, { next: { def: h('c') } })
    w.defs[h('c')] = { body: {} }
    const { world: out, stats } = recycleWorld(w, { genWindow: 1 })
    expect(stats.droppedGens).toBe(1)
    expect(stats.removedDefs).toBe(1)
    expect(out.ids.x.gens).toHaveLength(1)
    expect(out.ids.x.gens[0].payload).toBe(B)
    expect(seqs(out.ids.x)).toEqual([0])
    expect(out.defs[A]).toBeUndefined() // 仅被淘汰世代引用
    expect(out.defs[B]).toBeDefined()
    expect(out.defs[h('c')]).toBeDefined() // 保留世代 body 标记可达
    expect(out.defs[D]).toBeDefined() // 无根 def 保守保留
    expect(out.defs[S]).toBeDefined() // schema 恒为根
  })

  it('active 落在窗口外也恒保留', () => {
    const w = base()
    w.ids.x.active = A
    const { world: out, stats } = recycleWorld(w, { genWindow: 1 })
    // 保留集 = 窗口内 B + active A；按原链序保留（[A,B]），seq 重编号
    expect(out.ids.x.gens.map((g) => g.payload)).toEqual([A, B])
    expect(seqs(out.ids.x)).toEqual([0, 1])
    expect(stats.droppedGens).toBe(0)
  })

  it('严格模式回收所有不在保留闭包内的 def（含无根 def）', () => {
    const w = base()
    const { world: out, stats } = recycleWorld(w, { genWindow: 1, strict: true })
    expect(stats.removedDefs).toBe(2) // A + D
    expect(out.defs[A]).toBeUndefined()
    expect(out.defs[D]).toBeUndefined()
    expect(out.defs[B]).toBeDefined()
  })

  it('genWindow<=0 且无根 = 空操作（返回入参世界引用）', () => {
    const w = base()
    const result = recycleWorld(w, { genWindow: 0 })
    expect(result.world).toBe(w)
    expect(result.stats).toEqual({ removedDefs: 0, droppedGens: 0, keptDefs: 4 })
  })
})

describe('recycleWorld：pins / graft 闭包', () => {
  it('pins 指向的被依赖世代（窗口外）随引用强留', () => {
    const S = h('s')
    const P0 = h('1')
    const P1 = h('2')
    const X = h('x')
    const w = world([S, P0, P1, X], {
      dep: {
        id: 'dep',
        schema: S,
        gens: [gen(P0, S), gen(P1, S)],
        active: P1,
        born: { at: 1, by: 'test' },
      },
      user: {
        id: 'user',
        schema: S,
        gens: [gen(X, S, { pins: { dep: P0 } })],
        active: X,
        born: { at: 1, by: 'test' },
      },
    })
    const { world: out } = recycleWorld(w, { genWindow: 1 })
    // user 的 pin 指向 dep 的旧世代 P0 ⇒ P0 世代强留（即便在 dep 窗口外）
    expect(out.ids.dep.gens.map((g) => g.payload)).toEqual([P0, P1])
    expect(out.defs[P0]).toBeDefined()
  })

  it('graft 来源世代强留并按下标改写', () => {
    const S = h('s')
    const P0 = h('1')
    const P1 = h('2')
    const P2 = h('3')
    const A = h('a')
    const B = h('b')
    const w = world([S, P0, P1, P2, A, B], {
      src: {
        id: 'src',
        schema: S,
        gens: [gen(P0, S), gen(P1, S), gen(P2, S)],
        active: P2,
        born: { at: 1, by: 'test' },
      },
      dst: {
        id: 'dst',
        schema: S,
        gens: [gen(A, S), gen(B, S, { graft: { from: 'src', gen: 1 } })],
        active: B,
        born: { at: 1, by: 'test' },
      },
    })
    const { world: out } = recycleWorld(w, { genWindow: 1 })
    // src 窗口留 P2；graft 引用 src#1(P1) 强留 ⇒ 保留 [P1,P2]，P0 淘汰
    expect(out.ids.src.gens.map((g) => g.payload)).toEqual([P1, P2])
    expect(seqs(out.ids.src)).toEqual([0, 1])
    // dst 窗口留 B；graft 来源下标 1 → 改写为 0
    expect(out.ids.dst.gens).toHaveLength(1)
    expect(out.ids.dst.gens[0].graft).toEqual({ from: 'src', gen: 0 })
    expect(out.defs[P0]).toBeUndefined()
    expect(out.defs[P1]).toBeDefined()
  })
})

describe('recycleWorld：外部根（审计索引）', () => {
  it('keepRoots 强留；dropRoots 独有的可达 def 才回收', () => {
    const S = h('s')
    const K = h('e')
    const G = h('f')
    const w = world([S, K, G], {
      x: { id: 'x', schema: S, gens: [], active: null, born: { at: 1, by: 'test' } },
    })
    bodyOf(w, K, { child: { def: G } })
    const result = recycleWorld(w, {
      genWindow: 0,
      keepRoots: [K],
      dropRoots: [G],
    })
    // G 被 dropRoots 直接引用，但 K 的 body 标记也引用 G ⇒ 仍被保留闭包覆盖
    expect(result.world.defs[G]).toBeDefined()
    const dropped = recycleWorld(w, { genWindow: 0, dropRoots: [h('9')] })
    expect(dropped.world).toBe(w) // dropRoots 无独有可达 = 空操作
  })
})

describe('recycleWorld：keepGens 机械并集', () => {
  it('窗口外显式保留世代（含其标记闭包）不裁，下标重映射正确', () => {
    const S = h('s')
    const D = h('d')
    const C = h('c')
    const A = h('a')
    const w = world([S, D, C, A], {
      x: {
        id: 'x',
        schema: S,
        gens: [gen(D, S, { seq: 0 }), gen(A, S, { seq: 1 })],
        active: A,
        born: { at: 1, by: 'test' },
      },
    })
    bodyOf(w, D, { child: { def: C } })
    // 无 keepGens：窗口只留 A，D 及其闭包 C 被回收
    const plain = recycleWorld(w, { genWindow: 1 })
    expect(plain.world.ids.x.gens.map((g) => g.payload)).toEqual([A])
    expect(plain.world.defs[D]).toBeUndefined()
    expect(plain.world.defs[C]).toBeUndefined()

    // keepGens 并入 D 世代：D 与其 body 标记闭包 C 一并保留，重映射为 [D,A] → [0,1]
    const { world: out } = recycleWorld(w, { genWindow: 1, keepGens: [{ id: 'x', seq: 0 }] })
    expect(out.ids.x.gens.map((g) => g.payload)).toEqual([D, A])
    expect(seqs(out.ids.x)).toEqual([0, 1])
    expect(out.defs[D]).toBeDefined()
    expect(out.defs[C]).toBeDefined()
  })

  it('keepGens 指向补丁世代时其 base 世代随固定点一并保留', () => {
    const S = h('s')
    const F = h('f')
    const P = h('p')
    const A = h('a')
    const w = world([S, F, P, A], {
      x: {
        id: 'x',
        schema: S,
        gens: [gen(F, S, { seq: 0 }), { ...gen(P, S), base: 0, seq: 1 }, gen(A, S, { seq: 2 })],
        active: A,
        born: { at: 1, by: 'test' },
      },
    })
    bodyOf(w, P, { ops: [{ op: 'replace', path: ['n'], value: 2 }] })
    const { world: out } = recycleWorld(w, { genWindow: 1, keepGens: [{ id: 'x', seq: 1 }] })
    // 保留补丁世代 P（index1）与其 base F（index0）+ 窗口内 A → [F,P,A]
    expect(out.ids.x.gens.map((g) => g.payload)).toEqual([F, P, A])
    expect(out.ids.x.gens[1].base).toBe(0)
  })
})

describe('recycleWorld：淘汰世代引用拒绝（fail-closed）', () => {
  /** 两身份各三代，回收窗口 1 → 每身份只留末代（下标 0）。键用合法 64-hex（commit 形态门禁）。 */
  function recycled(): World {
    const S = h('a')
    const P0 = h('1')
    const P1 = h('2')
    const P2 = h('3')
    const Q0 = h('4')
    const Q1 = h('5')
    const Q2 = h('6')
    const w = world([S, P0, P1, P2, Q0, Q1, Q2], {
      x: {
        id: 'x',
        schema: S,
        gens: [gen(P0, S), gen(P1, S), gen(P2, S)],
        active: P2,
        born: { at: 1, by: 'test' },
      },
      src: {
        id: 'src',
        schema: S,
        gens: [gen(Q0, S), gen(Q1, S), gen(Q2, S)],
        active: Q2,
        born: { at: 1, by: 'test' },
      },
    })
    const { world: out } = recycleWorld(w, { genWindow: 1 })
    expect(out.ids.x.gens).toHaveLength(1)
    expect(out.ids.src.gens).toHaveLength(1)
    return out
  }

  /** 回收后对已淘汰世代发引用；返回内核错误码（判据可能来自 validate 判决或 apply 抛出）。 */
  function codeOf(w: World, op: 'set_active' | 'add_gen' | 'graft', args: Json): string {
    try {
      const outcome = commit(
        EMPTY_HEAD,
        w,
        { id: 't', op, target: { expect_pos: EMPTY_HEAD.hash }, args, by: 't' },
        1,
      )
      if (outcome.verdict.ok) return '<no-throw>'
      return outcome.verdict.reasons[0] ?? '<no-reason>'
    } catch (err) {
      return typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : '<non-kernel>'
    }
  }

  it('已淘汰 payload 的 set_active → not_a_generation', () => {
    const w = recycled()
    const P0 = h('1')
    expect(codeOf(w, 'set_active', { id: 'x', active: P0 })).toBe('not_a_generation')
  })

  it('已淘汰 base 下标发 add_gen → missing_parent；保留下标可写', () => {
    const w = recycled()
    const patch = h('7')
    w.defs[patch] = { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }
    // 原 index 1 的世代已淘汰，回收后下标越界
    expect(codeOf(w, 'add_gen', { id: 'x', payload: patch, sig: h('a'), pins: {}, base: 1 })).toBe(
      'missing_parent',
    )
    // 保留下标 0 合法
    expect(codeOf(w, 'add_gen', { id: 'x', payload: patch, sig: h('a'), pins: {}, base: 0 })).toBe(
      '<no-throw>',
    )
  })

  it('graft 指向已淘汰来源世代 → missing_parent；保留下标可嫁接', () => {
    const w = recycled()
    const payload = h('8')
    w.defs[payload] = { body: { grafted: true } }
    expect(
      codeOf(w, 'graft', { id: 'x', payload, sig: h('a'), pins: {}, from: 'src', gen: 1 }),
    ).toBe('missing_parent')
    expect(
      codeOf(w, 'graft', { id: 'x', payload, sig: h('a'), pins: {}, from: 'src', gen: 0 }),
    ).toBe('<no-throw>')
  })
})
