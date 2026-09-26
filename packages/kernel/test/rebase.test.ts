// 压扁（flattenPatches）的世代重映射验收：折叠后 active / base / graft 的旧→新映射，
// 以及共享的 remapGens 对跨身份 graft 的改写。只打公共面 ../index.ts。
import { describe, expect, it } from 'vitest'

import { H, flattenPatches, remapGens } from '../index.ts'
import type { Gen, Hash, Json, World } from '../index.ts'

const WRITE = '0'.repeat(64)

function def(body: Json): { body: Json; key: Hash } {
  return { body, key: H({ body }) }
}

function gen(payload: Hash, sig: Hash, opts: { base?: number; graft?: Gen['graft'] } = {}): Gen {
  const out: Gen = {
    seq: 0,
    payload,
    pins: {},
    sig,
    adopted: { at: 1, by: 'test', write: WRITE },
  }
  if (opts.base !== undefined) out.base = opts.base
  if (opts.graft !== undefined) out.graft = opts.graft
  return out
}

function world(defs: { key: Hash; body: Json }[], ids: World['ids']): World {
  const table: World['defs'] = {}
  for (const entry of defs) table[entry.key] = { body: entry.body }
  return { defs: table, ids }
}

const SCHEMA = def({ type: 'object' })

/** 一个身份 x：gens 已按 seq 顺序给出，active 由参数指定。 */
function identity(gens: Gen[], active: Hash): World['ids'] {
  return {
    x: {
      id: 'x',
      schema: SCHEMA.key,
      gens: gens.map((g, seq) => ({ ...g, seq })),
      active,
      born: { at: 1, by: 'test' },
    },
  }
}

describe('flattenPatches：世代重映射', () => {
  it('active 指向被折叠链：折叠后改指组装世代，无 base 残留', () => {
    const full = def({ n: 1 })
    const patch = def({ ops: [{ op: 'replace', path: ['n'], value: 2 }] })
    const w = world(
      [SCHEMA, full, patch],
      identity([gen(full.key, full.key), gen(patch.key, patch.key, { base: 0 })], patch.key),
    )
    const { world: out, flattened } = flattenPatches(w, 2)
    expect(flattened).toBe(1)
    const gens = out.ids.x.gens
    expect(gens).toHaveLength(1)
    expect(gens[0].base).toBeUndefined()
    expect(out.ids.x.active).toBe(gens[0].payload)
    expect(out.defs[gens[0].payload].body).toEqual({ n: 2 })
  })

  it('链外补丁的 base 指向被折叠链末代：base 下标随折叠重映射', () => {
    const full0 = def({ n: 1 })
    const patch1 = def({ ops: [{ op: 'replace', path: ['n'], value: 2 }] })
    const full2 = def({ m: 9 })
    const patch3 = def({ ops: [{ op: 'replace', path: ['m'], value: 10 }] })
    const w = world(
      [SCHEMA, full0, patch1, full2, patch3],
      identity(
        [
          gen(full0.key, full0.key),
          gen(patch1.key, patch1.key, { base: 0 }),
          gen(full2.key, full2.key),
          gen(patch3.key, patch3.key, { base: 1 }),
        ],
        patch3.key,
      ),
    )
    const { world: out } = flattenPatches(w, 2)
    const gens = out.ids.x.gens
    // [0,1] 折叠为 index0；full2 → index1；patch3 → index2，base 由旧 1 改指新 0
    expect(gens).toHaveLength(3)
    expect(gens[0].base).toBeUndefined()
    expect(gens[1].base).toBeUndefined()
    expect(gens[2].base).toBe(0)
    expect(out.defs[gens[0].payload].body).toEqual({ n: 2 })
  })

  it('跨身份 graft 指向被折叠链末代：graft.gen 随折叠重映射', () => {
    const full = def({ n: 1 })
    const patch = def({ ops: [{ op: 'replace', path: ['n'], value: 2 }] })
    const grafted = def({ grafted: true })
    const w = world([SCHEMA, full, patch, grafted], {
      x: {
        id: 'x',
        schema: SCHEMA.key,
        gens: [gen(full.key, full.key), gen(patch.key, patch.key, { base: 0 })],
        active: patch.key,
        born: { at: 1, by: 'test' },
      },
      y: {
        id: 'y',
        schema: SCHEMA.key,
        gens: [gen(grafted.key, grafted.key, { graft: { from: 'x', gen: 1 } })],
        active: grafted.key,
        born: { at: 1, by: 'test' },
      },
    })
    const { world: out } = flattenPatches(w, 2)
    expect(out.ids.x.gens).toHaveLength(1)
    expect(out.ids.y.gens[0].graft).toEqual({ from: 'x', gen: 0 })
  })
})

describe('remapGens：base / graft / active 三支路', () => {
  it('按下标映射重写 base 与 graft，按 payload 映射重写 active', () => {
    const p0 = def({ n: 1 })
    const p1 = def({ n: 2 })
    const q0 = def({ q: 1 })
    const assembled = def({ n: 2 })
    const ids: World['ids'] = {
      x: {
        id: 'x',
        schema: SCHEMA.key,
        gens: [gen(assembled.key, assembled.key, { base: 0 })],
        active: assembled.key,
        born: { at: 1, by: 'test' },
      },
      y: {
        id: 'y',
        schema: SCHEMA.key,
        gens: [gen(q0.key, q0.key, { graft: { from: 'x', gen: 1 } })],
        active: q0.key,
        born: { at: 1, by: 'test' },
      },
    }
    // x 的旧 [p0,p1] 折叠为单个新下标 0；y 的旧下标 0 保持
    remapGens(
      ids,
      new Map([
        [
          'x',
          new Map([
            [0, 0],
            [1, 0],
          ]),
        ],
        ['y', new Map([[0, 0]])],
      ]),
      new Map([
        [
          'x',
          new Map([
            [p0.key, assembled.key],
            [p1.key, assembled.key],
          ]),
        ],
        ['y', new Map([[q0.key, q0.key]])],
      ]),
    )
    expect(ids.x.gens[0].base).toBe(0)
    expect(ids.y.gens[0].graft).toEqual({ from: 'x', gen: 0 })
    expect(ids.x.active).toBe(assembled.key)
  })

  it('无 payload 映射时不改 active（回收口径）', () => {
    const p0 = def({ n: 1 })
    const ids: World['ids'] = {
      x: {
        id: 'x',
        schema: SCHEMA.key,
        gens: [gen(p0.key, p0.key, { base: 0 })],
        active: p0.key,
        born: { at: 1, by: 'test' },
      },
    }
    remapGens(ids, new Map([['x', new Map([[0, 0]])]]))
    expect(ids.x.gens[0].base).toBe(0)
    expect(ids.x.active).toBe(p0.key)
  })
})
