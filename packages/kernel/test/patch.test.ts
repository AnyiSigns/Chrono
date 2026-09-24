// 补丁原语与补丁世代：assembleBody 三种操作 / fail-closed；add_gen base 语义；
// 混用整份与补丁；压扁（flattenPatches）与回收协同（无悬挂 base）。
// 只打公共面 ../index.ts。

import { describe, expect, it } from 'vitest'
import type { Entry, Hash, Head, Json, Op, World } from '../index.ts'
import {
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  applyEntry,
  assembleBody,
  cloneWorld,
  entryHash,
  flattenPatches,
  readPatchOps,
  recycleWorld,
  replay,
  validate,
  verify,
  worldRev,
} from '../index.ts'
import type { PatchOp } from '../index.ts'

type Outcome = ReturnType<typeof applyEntry>

function mkEntry(seq: number, prev: Hash | null, op: Op, args: Json): Entry {
  return { seq, prev, op, args, argsHash: '', by: 'u', at: 1000 + seq }
}

type Harness = {
  w: World
  head: Head
  journal: Entry[]
  push(op: Op, args: Json): Entry
  apply(op: Op, args: Json): Outcome
}

function harness(): Harness {
  const w = cloneWorld(EMPTY_WORLD)
  const journal: Entry[] = []
  let head: Head = { ...EMPTY_HEAD }
  function apply(op: Op, args: Json): Outcome {
    const e = mkEntry(head.seq + 1, head.hash, op, args)
    const r = applyEntry(w, e)
    if (r.ok) {
      e.argsHash = r.argsHash
      if (!r.isNoop) head = { seq: e.seq, hash: entryHash(e) }
    }
    return r
  }
  return {
    w,
    journal,
    get head() {
      return head
    },
    apply,
    push(op: Op, args: Json): Entry {
      const e = mkEntry(head.seq + 1, head.hash, op, args)
      const r = applyEntry(w, e)
      if (!r.ok) throw new Error('push 失败: ' + r.error)
      e.argsHash = r.argsHash
      if (!r.isNoop) {
        journal.push(e)
        head = { seq: e.seq, hash: entryHash(e) }
      }
      return e
    },
  }
}

describe('assembleBody：append / replace / delete', () => {
  it('append 列表追加、字符串拼接；路径不存在按值建列表', () => {
    expect(assembleBody({ list: [1] }, [{ op: 'append', path: ['list'], value: 2 }])).toEqual({
      list: [1, 2],
    })
    expect(assembleBody({ text: 'a' }, [{ op: 'append', path: ['text'], value: 'b' }])).toEqual({
      text: 'ab',
    })
    expect(assembleBody({}, [{ op: 'append', path: ['list'], value: 7 }])).toEqual({ list: [7] })
  })

  it('replace 整体替换并自动建中间容器；delete 幂等', () => {
    expect(assembleBody({}, [{ op: 'replace', path: ['a', 'b'], value: 1 }])).toEqual({ a: { b: 1 } })
    expect(assembleBody({ a: { b: 1 } }, [{ op: 'replace', path: ['a', 'b'], value: 2 }])).toEqual({
      a: { b: 2 },
    })
    expect(assembleBody({ a: 1 }, [{ op: 'delete', path: ['a'] }])).toEqual({})
    // 路径缺失 → 静默成功
    expect(assembleBody({}, [{ op: 'delete', path: ['x', 'y'] }])).toEqual({})
  })

  it('数组按索引 replace / delete；delete 从后向前删不漂移', () => {
    const base = { xs: ['a', 'b', 'c'] }
    expect(assembleBody(base, [{ op: 'replace', path: ['xs', 1], value: 'B' }])).toEqual({
      xs: ['a', 'B', 'c'],
    })
    expect(
      assembleBody(base, [
        { op: 'delete', path: ['xs', 2] },
        { op: 'delete', path: ['xs', 0] },
      ]),
    ).toEqual({ xs: ['b'] })
  })

  it('纯函数：不改 base / 补丁，产物不共享补丁 value 引用', () => {
    const base = { list: [1] }
    const value = { deep: [2] }
    const ops: PatchOp[] = [{ op: 'append', path: ['list'], value }]
    const out = assembleBody(base, ops) as { list: Json[] }
    expect(base).toEqual({ list: [1] })
    expect(ops[0].value).toEqual({ deep: [2] })
    ;(out.list[1] as { deep: number[] }).deep.push(9)
    expect(ops[0].value).toEqual({ deep: [2] })
  })

  it('fail-closed：未知 op / 空路径 / append 目标非法 / 穿过标量 → bad_patch', () => {
    const bad: PatchOp[] = [
      { op: 'nope' as unknown as 'append', path: ['a'], value: 1 },
    ]
    expect(() => assembleBody({}, bad)).toThrowError(/bad_patch/)
    expect(() => assembleBody({}, [{ op: 'replace', path: [], value: 1 }])).toThrowError(/bad_patch/)
    expect(() => assembleBody({ a: 1 }, [{ op: 'append', path: ['a'], value: 2 }])).toThrowError(
      /bad_patch/,
    )
    expect(() =>
      assembleBody({ a: 1 }, [{ op: 'replace', path: ['a', 'b'], value: 2 }]),
    ).toThrowError(/bad_patch/)
  })

  it('readPatchOps：合法补丁体返回 ops，非法返回 null', () => {
    expect(readPatchOps({ ops: [{ op: 'replace', path: ['a'], value: 1 }] })).toHaveLength(1)
    expect(readPatchOps({ ops: [] })).toBeNull()
    expect(readPatchOps({ ops: [{ op: 'x', path: ['a'] }] })).toBeNull()
    expect(readPatchOps({ ops: [{ op: 'replace', path: [] }] })).toBeNull()
    expect(readPatchOps({ body: 1 })).toBeNull()
  })
})

/** 建身份 + 整份世代，返回 payload 键。 */
function seedFullGen(h: Harness, id: string, body: Json): Hash {
  const schema = h.push('put', { body: { s: 1 } }).argsHash
  h.push('add_identity', { id, schema })
  const payload = h.push('put', { body }).argsHash
  h.push('add_gen', { id, payload, sig: payload, pins: {} })
  return payload
}

describe('补丁世代：add_gen base', () => {
  it('base 指向整份世代：Gen.base 落地，payload 指向补丁 def', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const patch = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: patch, sig: patch, pins: {}, base: 0 })
    const gen = h.w.ids['u1'].gens[1]
    expect(gen.base).toBe(0)
    expect(gen.payload).toBe(patch)
    // worldRev 覆盖 base：改 base 改摘要
    const rev = worldRev(h.w)
    h.w.ids['u1'].gens[1].base = undefined
    expect(worldRev(h.w)).not.toBe(rev)
  })

  it('混用整份 + 补丁：补丁 base 可指向补丁世代，链式组装', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const p1 = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p1, sig: p1, pins: {}, base: 0 })
    const p2 = h.push('put', { body: { ops: [{ op: 'append', path: ['tags'], value: 'x' }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p2, sig: p2, pins: {}, base: 1 })
    // 第三个是整份世代（回落 base 缺失）
    const full2 = h.push('put', { body: { n: 9 } }).argsHash
    h.push('add_gen', { id: 'u1', payload: full2, sig: full2, pins: {} })
    expect(h.w.ids['u1'].gens.map((g) => g.base)).toEqual([undefined, 0, 1, undefined])
  })

  it('base 越界 → missing_parent；payload 非补丁体 → bad_patch；世界分文不动', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const full = h.push('put', { body: { n: 2 } }).argsHash
    const badPatch = h.push('put', { body: { not_ops: true } }).argsHash
    const before = JSON.stringify(h.w)
    const codeOf = (args: Json): string => {
      try {
        h.apply('add_gen', args)
        return '<no-throw>'
      } catch (err) {
        return typeof (err as { code?: unknown }).code === 'string'
          ? ((err as { code: string }).code)
          : '<non-kernel>'
      }
    }
    expect(codeOf({ id: 'u1', payload: full, sig: full, pins: {}, base: 5 })).toBe('missing_parent')
    expect(codeOf({ id: 'u1', payload: badPatch, sig: badPatch, pins: {}, base: 0 })).toBe('bad_patch')
    // 失败未落地世代，世界分文不动
    expect(h.w.ids['u1'].gens).toHaveLength(1)
    expect(JSON.stringify(h.w)).toBe(before)
  })

  it('补丁世代可重放：replay 逐字段一致，verify 通过', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const p1 = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p1, sig: p1, pins: {}, base: 0 })
    const p2 = h.push('put', { body: { ops: [{ op: 'append', path: ['tags'], value: 'x' }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p2, sig: p2, pins: {}, base: 1 })
    const replayed = replay(h.journal)
    expect(worldRev(replayed)).toBe(worldRev(h.w))
    expect(replayed.ids['u1'].gens.map((g) => g.base)).toEqual([undefined, 0, 1])
    expect(verify(h.journal).ok).toBe(true)
  })

  it('形态：base 非整数 / 负 / graft 携带 base → bad_form', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const full = h.push('put', { body: { n: 2 } }).argsHash
    const head = h.head
    const w = h.w
    const req = (args: Json) => ({
      id: 'r',
      op: 'add_gen' as const,
      target: { expect_pos: head.hash },
      args,
      by: 'u',
    })
    expect(validate(head, w, req({ id: 'u1', payload: full, sig: full, pins: {}, base: -1 })).ok).toBe(
      false,
    )
    expect(
      validate(head, w, req({ id: 'u1', payload: full, sig: full, pins: {}, base: 1.5 })).ok,
    ).toBe(false)
    expect(
      validate(head, w, req({ id: 'u1', payload: full, sig: full, pins: {}, base: '0' })).ok,
    ).toBe(false)
  })
})

describe('压扁 flattenPatches', () => {
  /** 整份 + 两条线性补丁。 */
  function linearChain(): Harness {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1, tags: [] })
    const p1 = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p1, sig: p1, pins: {}, base: 0 })
    const p2 = h.push('put', { body: { ops: [{ op: 'append', path: ['tags'], value: 'x' }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p2, sig: p2, pins: {}, base: 1 })
    return h
  }

  it('线性链折叠为整份世代：组装结果不变、active 重指、无 base 残留', () => {
    const h = linearChain()
    const before = h.w
    const { world, flattened } = flattenPatches(before)
    expect(flattened).toBe(1)
    const gens = world.ids['u1'].gens
    expect(gens).toHaveLength(1)
    expect(gens[0].base).toBeUndefined()
    expect(world.defs[gens[0].payload].body).toEqual({ n: 2, tags: ['x'] })
    expect(world.ids['u1'].active).toBe(gens[0].payload)
    // 纯函数：原世界不变
    expect(before.ids['u1'].gens).toHaveLength(3)
    expect(worldRev(world)).not.toBe(worldRev(before))
  })

  it('active 指向链内非末代 → 不折叠（保守）', () => {
    const h = linearChain()
    // active 指回第一条补丁（中间态）
    h.w.ids['u1'].active = h.w.ids['u1'].gens[1].payload
    const { world, flattened } = flattenPatches(h.w)
    expect(flattened).toBe(0)
    expect(world.ids['u1'].gens).toHaveLength(3)
  })
})

describe('回收协同：补丁世代 base 不悬挂', () => {
  it('genWindow 淘汰 base 时一并保留 base 世代', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const p1 = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p1, sig: p1, pins: {}, base: 0 })
    const p2 = h.push('put', { body: { ops: [{ op: 'append', path: ['tags'], value: 'x' }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p2, sig: p2, pins: {}, base: 1 })
    const { world } = recycleWorld(h.w, { genWindow: 1 })
    const gens = world.ids['u1'].gens
    for (const gen of gens) {
      if (gen.base === undefined) continue
      expect(gen.base).toBeGreaterThanOrEqual(0)
      expect(gen.base).toBeLessThan(gens.length)
    }
  })

  it('flattenChain 阈值：折叠后回收不悬挂 base', () => {
    const h = harness()
    seedFullGen(h, 'u1', { n: 1 })
    const p1 = h.push('put', { body: { ops: [{ op: 'replace', path: ['n'], value: 2 }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p1, sig: p1, pins: {}, base: 0 })
    const p2 = h.push('put', { body: { ops: [{ op: 'append', path: ['tags'], value: 'x' }] } }).argsHash
    h.push('add_gen', { id: 'u1', payload: p2, sig: p2, pins: {}, base: 1 })
    const { world } = recycleWorld(h.w, { genWindow: 1, flattenChain: 2 })
    const gens = world.ids['u1'].gens
    expect(gens.every((gen) => gen.base === undefined)).toBe(true)
    expect(world.defs[gens[gens.length - 1].payload].body).toEqual({ n: 2, tags: ['x'] })
  })
})
