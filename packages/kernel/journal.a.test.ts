// 逐 op 语义与 batch 原子性、$n 前向引用（journal.a）。
// 注：「args 里出现 seq → bad_form」在 applyEntry 面不可达（内核自取 gens.length，
// 该校验属 validate 前置职责），本文件不含此用例，见审查报告缺口清单。

import { describe, expect, it } from 'vitest'
import type { Entry, Hash, Head, Json, Op, World } from './index.ts'
import { EMPTY_HEAD, EMPTY_WORLD, H, applyEntry, cloneWorld, entryHash, worldRev } from './index.ts'

type Outcome = ReturnType<typeof applyEntry>
type OkOutcome = Extract<Outcome, { ok: true }>

function mkEntry(seq: number, prev: Hash | null, op: Op, args: Json): Entry {
  return { seq, prev, op, args, argsHash: '', by: 'u', at: 1000 + seq }
}

function asOk(r: Outcome): OkOutcome {
  if (!r.ok) throw new Error('期望 ok:true，实为 ' + r.error)
  return r
}

type Harness = {
  w: World
  journal: Entry[]
  readonly head: Head
  push(op: Op, args: Json): Entry
  apply(op: Op, args: Json): { r: Outcome; e: Entry }
}

function harness(): Harness {
  const w = cloneWorld(EMPTY_WORLD)
  const journal: Entry[] = []
  let head: Head = { ...EMPTY_HEAD }
  function apply(op: Op, args: Json): { r: Outcome; e: Entry } {
    const e = mkEntry(head.seq + 1, head.hash, op, args)
    const r = applyEntry(w, e)
    if (r.ok) e.argsHash = r.argsHash // 测试扮演 commit 的回填，不改实现
    return { r, e }
  }
  return {
    w,
    journal,
    get head() {
      return head
    },
    push(op: Op, args: Json): Entry {
      const one = apply(op, args)
      if (!one.r.ok) throw new Error('harness.push 不用于失败用例: ' + one.r.error)
      if (!one.r.isNoop) {
        journal.push(one.e)
        head = { seq: one.e.seq, hash: entryHash(one.e) }
      }
      return one.e
    },
    apply,
  }
}

/** 单 op 语义违例 → 抛 KernelError{code}；违例后世界分文不动。 */
function expectThrow(h: Harness, code: string, op: Op, args: Json): void {
  const before = JSON.stringify(h.w)
  try {
    h.apply(op, args)
    throw new Error('expectThrow: 期望抛 ' + code)
  } catch (err) {
    const c = (err as { code?: unknown }).code // KernelError 不在公共面断言类型，读 code 字段
    expect(typeof c === 'string' ? c : '<非 KernelError>').toBe(code)
  }
  expect(JSON.stringify(h.w)).toBe(before)
}

/** batch 子操作失败 → 返回 { ok:false, error }，整批逆序回滚。 */
function expectFail(h: Harness, code: string, op: Op, args: Json): void {
  const before = JSON.stringify(h.w)
  expect(h.apply(op, args).r).toEqual({ ok: false, error: code })
  expect(JSON.stringify(h.w)).toBe(before)
}

describe('逐 op 基础语义', () => {
  it('put 同内容两次：第二次幂等命中（isNoop、written 空），世界不动', () => {
    const h = harness()
    const def: Json = { body: { v: 'same' } }
    const putEntry = h.push('put', def)
    const before = JSON.stringify(h.w)
    const reuseResult = asOk(h.apply('put', def).r)
    expect(reuseResult.isNoop).toBe(true)
    expect(reuseResult.written).toEqual([])
    expect(reuseResult.argsHash).toBe(putEntry.argsHash) // 键与 argsHash 是同一个值 = H(Def)
    expect(JSON.stringify(h.w)).toBe(before)
    expect(Object.keys(h.w.defs)).toEqual([putEntry.argsHash])
  })

  it('add_identity 重复 id（含 retire 后仍占位）/ schema 缺失 → id_taken / missing_ref', () => {
    const h = harness()
    const schema = h.push('put', { body: { s: 1 } }).argsHash
    h.push('add_identity', { id: 'u1', schema })
    expectThrow(h, 'id_taken', 'add_identity', { id: 'u1', schema })
    expectThrow(h, 'missing_ref', 'add_identity', { id: 'u2', schema: 'f'.repeat(64) })
    h.push('retire', { id: 'u1' })
    expectThrow(h, 'id_taken', 'add_identity', { id: 'u1', schema }) // retired 后 id 仍占位
  })

  it('add_gen 的 payload/sig 不在 defs → missing_ref；无身份 → no_identity', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { p: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const base = { id: 'u1', pins: {}, sig: schemaDef.argsHash }
    expectThrow(h, 'missing_ref', 'add_gen', {
      ...base,
      sig: payloadDef.argsHash,
      payload: 'e'.repeat(64),
    })
    expectThrow(h, 'missing_ref', 'add_gen', {
      ...base,
      payload: payloadDef.argsHash,
      sig: 'd'.repeat(64),
    })
    expectThrow(h, 'no_identity', 'add_gen', {
      ...base,
      payload: payloadDef.argsHash,
      id: 'ghost',
    })
  })

  it('add_gen 连续两次：seq = 0 然后 1（内核在 push 前取自 gens.length），并激活', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const firstGenPayload = h.push('put', { body: { g: 1 } })
    const secondGenPayload = h.push('put', { body: { g: 2 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u1',
      payload: firstGenPayload.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    h.push('add_gen', {
      id: 'u1',
      payload: secondGenPayload.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    expect(h.w.ids.u1.gens.map((g) => g.seq)).toEqual([0, 1])
    expect(h.w.ids.u1.active).toBe(secondGenPayload.argsHash) // add_gen 同时激活
  })

  it('set_active 指向非本身份世代 → not_a_generation；无身份 → no_identity；null 合法', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const otherGenPayload = h.push('put', { body: { g: 2 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_identity', { id: 'u2', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u2',
      payload: otherGenPayload.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    expectThrow(h, 'no_identity', 'set_active', { id: 'ghost', active: null })
    expectThrow(h, 'not_a_generation', 'set_active', { id: 'u1', active: 'c'.repeat(64) })
    expectThrow(h, 'not_a_generation', 'set_active', { id: 'u1', active: otherGenPayload.argsHash }) // 别家世代
    h.push('set_active', { id: 'u1', active: null }) // 0 世代时 null 仍合法（退役）
    expect(h.w.ids.u1.active).toBeNull()
  })

  it('retire ≡ set_active(null)：世界效果相同，但 argsHash/entryHash 各异（历史不折叠）', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u1',
      payload: payloadDef.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    const setActiveEntry = h.push('set_active', { id: 'u1', active: null })
    const rev = worldRev(h.w) // 在退役态上取值（active 进摘要）
    const retireEntry = h.push('retire', { id: 'u1' })
    expect(h.w.ids.u1.active).toBeNull()
    expect(setActiveEntry.argsHash).not.toBe(retireEntry.argsHash)
    expect(entryHash(setActiveEntry)).not.toBe(entryHash(retireEntry))
    expect(worldRev(h.w)).toBe(rev)
  })

  it('fork 带 born.parent；缺 parent / parent 不存在 → missing_parent', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('fork', { id: 'u2', schema: schemaDef.argsHash, parent: 'u1' })
    expect(h.w.ids.u2.born).toEqual({ at: 1002, by: 'u', parent: 'u1' })
    expectThrow(h, 'missing_parent', 'fork', { id: 'u3', schema: schemaDef.argsHash })
    expectThrow(h, 'missing_parent', 'fork', {
      id: 'u3',
      schema: schemaDef.argsHash,
      parent: 'ghost',
    })
  })

  it('note：世界不变、isNoop 恒 false、written 空；ops 缺失/非数组的 batch → bad_form', () => {
    const h = harness()
    const before = JSON.stringify(h.w)
    const r = asOk(h.apply('note', { tag: 'x' }).r)
    expect(r.isNoop).toBe(false)
    expect(r.written).toEqual([])
    expect(JSON.stringify(h.w)).toBe(before)
    expectThrow(h, 'bad_form', 'batch', {})
    expectThrow(h, 'bad_form', 'batch', { ops: 'x' })
  })

  it('未知 op → bad_form（message 与 code 同码，无第二套语义）', () => {
    const h = harness()
    expectThrow(h, 'bad_form', 'nope' as Op, {})
    expect(() => h.apply('nope' as Op, {})).toThrow(/bad_form/)
  })
})

describe('batch：原子性、$n、两段式', () => {
  it('第 3 个子操作失败：整体 ok:false，前 2 个改动不可见，链位置不动', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const before = JSON.stringify(h.w)
    const ops: Json[] = [
      { op: 'put', args: { body: { m: 1 } } },
      { op: 'put', args: { body: { m: 2 } } },
      {
        op: 'add_gen',
        args: { id: 'u1', payload: 'a'.repeat(64), pins: {}, sig: schemaDef.argsHash },
      },
    ]
    expect(h.apply('batch', { ops }).r).toEqual({ ok: false, error: 'missing_ref' })
    expect(JSON.stringify(h.w)).toBe(before)
    const next = h.push('note', { k: 1 }) // 失败无痕：后续照常接链
    expect(next.seq).toBe(2)
  })

  it('$n 前向引用 / 越界 / 非整数 / 字符串 → bad_selfref（预哈希趟即抛，世界分文未动）', () => {
    const h = harness()
    for (const ref of [1, 5, 1.5, -1, '0']) {
      expectThrow(h, 'bad_selfref', 'batch', {
        ops: [
          { op: 'put', args: { body: { i: 1 } } },
          { op: 'note', args: { sig: { $n: ref } } },
        ],
      })
    }
  })

  it('$n 指向无产物子操作（其余 op / 嵌套 batch）→ bad_selfref', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { p: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u1',
      payload: payloadDef.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    const firstOps: Json[] = [
      { op: 'add_identity', args: { id: 'u9', schema: schemaDef.argsHash } },
      {
        op: 'add_gen',
        args: { id: 'u1', payload: payloadDef.argsHash, pins: {}, sig: schemaDef.argsHash },
      },
      {
        op: 'graft',
        args: {
          id: 'u1',
          payload: payloadDef.argsHash,
          pins: {},
          sig: schemaDef.argsHash,
          from: 'u1',
          gen: 0,
        },
      },
      { op: 'set_active', args: { id: 'u1', active: null } },
      { op: 'batch', args: { ops: [{ op: 'put', args: { body: { z: 1 } } }] } },
    ]
    for (const first of firstOps) {
      expectThrow(h, 'bad_selfref', 'batch', {
        ops: [first, { op: 'note', args: { sig: { $n: 0 } } }],
      })
    }
  })

  it('子操作全是已存在 put → 整批 isNoop；argsHash = 子对聚合', () => {
    const h = harness()
    const writtenDef: Json = { body: { n: 1 } }
    const otherWrittenDef: Json = { body: { n: 2 } }
    const freshDef: Json = { body: { n: 3 } }
    h.push('put', writtenDef)
    h.push('put', otherWrittenDef)
    const before = JSON.stringify(h.w)
    const r = asOk(
      h.apply('batch', {
        ops: [
          { op: 'put', args: writtenDef },
          { op: 'put', args: otherWrittenDef },
        ],
      }).r,
    )
    expect(r.isNoop).toBe(true)
    expect(r.written).toEqual([])
    expect(JSON.stringify(h.w)).toBe(before)
    expect(r.argsHash).toBe(
      H({
        ops: [
          ['put', H(writtenDef)],
          ['put', H(otherWrittenDef)],
        ],
      }),
    )
    const mixedBatchResult = asOk(
      h.apply('batch', {
        ops: [
          { op: 'put', args: writtenDef },
          { op: 'put', args: freshDef },
        ],
      }).r,
    )
    expect(mixedBatchResult.isNoop).toBe(false) // 有一个非 noop 即整批非 noop
    expect(mixedBatchResult.written).toEqual([H(freshDef)]) // written = 各 put 子操作的 def 键
  })

  it('批内 add_gen/graft/嵌套批的 adopted.write === 外层批 entry 的 entryHash', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const ops: Json[] = [
      { op: 'put', args: { body: { g: 2 } } },
      {
        op: 'add_gen',
        args: { id: 'u1', payload: payloadDef.argsHash, pins: {}, sig: schemaDef.argsHash },
      },
      {
        op: 'graft',
        args: {
          id: 'u1',
          payload: payloadDef.argsHash,
          pins: {},
          sig: schemaDef.argsHash,
          from: 'u1',
          gen: 0,
        },
      },
      {
        op: 'batch',
        args: {
          ops: [
            { op: 'put', args: { body: { g: 3 } } },
            {
              op: 'add_gen',
              args: { id: 'u1', payload: { $n: 0 }, pins: {}, sig: schemaDef.argsHash },
            },
          ],
        },
      },
    ]
    const e = h.push('batch', { ops })
    const outer = entryHash(e)
    expect(h.w.ids.u1.gens.map((g) => g.seq)).toEqual([0, 1, 2]) // seq 逐子即算 +1
    expect(h.w.ids.u1.gens.every((g) => g.adopted.write === outer)).toBe(true)
    expect(JSON.stringify(e.args)).toBe(JSON.stringify({ ops })) // 日志存**替换前** args
  })

  it('普通 add_gen 的 adopted.write === 自身 entryHash；at/by 取自 Entry', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const e = h.push('add_gen', {
      id: 'u1',
      payload: payloadDef.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    const gen = h.w.ids.u1.gens[0]
    expect(gen.adopted.write).toBe(entryHash(e)) // 自身位置，非外层
    expect(gen.adopted.at).toBe(e.at)
    expect(gen.adopted.by).toBe(e.by)
    expect(gen.graft).toBeUndefined()
  })

  it('批内第二个 add_identity 撞第一个新开的 id → 应用趟失败 id_taken，整批回滚', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    expectFail(h, 'id_taken', 'batch', {
      ops: [
        { op: 'put', args: { body: { z: 1 } } },
        { op: 'add_identity', args: { id: 'nx', schema: schemaDef.argsHash } },
        { op: 'add_identity', args: { id: 'nx', schema: schemaDef.argsHash } },
      ],
    })
    expect(h.w.ids.nx).toBeUndefined() // undo 覆盖 ids（不只是 defs）
    expect(Object.keys(h.w.defs).length).toBe(1)
  })

  it('回滚不落幻影：撞车的那条 batch 重放后，write 指向重放条目的真实位置', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const prefix: Json[] = [
      { op: 'put', args: { body: { g: 1 } } },
      { op: 'add_identity', args: { id: 'dup', schema: schemaDef.argsHash } },
    ]
    expectFail(h, 'id_taken', 'batch', { ops: [...prefix, prefix[1]] })
    const addGen: Json = {
      op: 'add_gen',
      args: { id: 'dup', payload: { $n: 0 }, pins: {}, sig: schemaDef.argsHash },
    }
    const e = h.push('batch', { ops: [...prefix, addGen] })
    expect(h.w.ids.dup.gens[0].adopted.write).toBe(entryHash(e)) // 与链上真实位置同一值
  })

  it('嵌套批：内层失败 → 外层 ok:false，内层已提交改动一并逆序回滚（原子性递归）', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    expectFail(h, 'no_identity', 'batch', {
      ops: [
        { op: 'put', args: { body: { deep: 1 } } },
        {
          op: 'batch',
          args: {
            ops: [
              { op: 'add_identity', args: { id: 'inner', schema: schemaDef.argsHash } },
              { op: 'set_active', args: { id: 'ghost', active: null } },
            ],
          },
        },
      ],
    })
    expect(h.w.ids.inner).toBeUndefined() // 内层提交被外层回滚覆盖（失败后世界逐字节不动）
    expect(Object.keys(h.w.ids)).toEqual(['u1'])
  })
})

describe('snapshot 与 graft 边界', () => {
  it('snapshot：世界与 worldRev 不变、isNoop 恒 false，照常产生审计 entry', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    const before = worldRev(h.w)
    const snap = h.push('snapshot', { world_rev: before })
    expect(h.journal[h.journal.length - 1]).toBe(snap) // 追加审计（若 noop 不会入链）
    expect(snap.argsHash).toBe(H({ world_rev: before }))
    expect(worldRev(h.w)).toBe(before)
  })

  it('snapshot 的 world_rev 与实算不符 → world_rev_mismatch（归档锚点歪不了）', () => {
    const h = harness()
    expectThrow(h, 'world_rev_mismatch', 'snapshot', { world_rev: '0'.repeat(64) })
    const schemaDef = h.push('put', { body: { s: 1 } })
    expectThrow(h, 'world_rev_mismatch', 'snapshot', { world_rev: schemaDef.argsHash })
  })

  it('graft：from/gen 不合法 → missing_parent；成功时 gens 带 graft:{from,gen}', () => {
    const h = harness()
    const schemaDef = h.push('put', { body: { s: 1 } })
    const payloadDef = h.push('put', { body: { g: 1 } })
    h.push('add_identity', { id: 'u1', schema: schemaDef.argsHash })
    h.push('add_identity', { id: 'u2', schema: schemaDef.argsHash })
    h.push('add_gen', {
      id: 'u1',
      payload: payloadDef.argsHash,
      pins: {},
      sig: schemaDef.argsHash,
    })
    const base = { id: 'u2', payload: payloadDef.argsHash, pins: {}, sig: schemaDef.argsHash }
    expectThrow(h, 'missing_parent', 'graft', { ...base, from: 'ghost', gen: 0 })
    expectThrow(h, 'missing_parent', 'graft', { ...base, from: 'u1', gen: 9 })
    h.push('graft', { ...base, from: 'u1', gen: 0 })
    expect(h.w.ids.u2.gens[0].graft).toEqual({ from: 'u1', gen: 0 })
    expect(h.w.ids.u2.active).toBe(payloadDef.argsHash)
  })
})
