// 链与世界的内容行为不变量：纯函数双跑、重放逐字段复现、可回滚、幂等、深冻结入参。
// 分工：只打公共面 ./index.ts；运行时源码扫描断言在 invariants.scan.test.ts。
import { describe, expect, it } from 'vitest'
import {
  EMPTY_WORLD,
  H,
  applyEntry,
  cloneWorld,
  commit,
  entryHash,
  replay,
  run,
  verify,
  worldRev,
} from '../index.ts'
import type {
  Def,
  Directive,
  Entry,
  Hash,
  Json,
  KernelInput,
  Op,
  World,
  WriteRequest,
} from '../index.ts'

const J = (v: unknown): Json => v as Json
type Head = Parameters<typeof commit>[0]
const RUN_ID = 'run-chain'
const NOW = 777
const dRec = (body: Json): Json => ({ body })
const dKey = (body: Json): Hash => H(dRec(body))
const SCHEMA = dKey('schema')
const PAY = dKey('payload')
const SIG = dKey('sig')
const PAY_ALT = dKey('payload-alt')
const SIG_ALT = dKey('sig-alt')
const req = (id: string, op: Op, args: Json, pos: Hash | null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest
const snap = (x: unknown): string => JSON.stringify(x)

function link(head: Head, world: World, r: WriteRequest): Head {
  const o = commit(head, world, r, NOW)
  if (!o.verdict.ok || o.entry === null) {
    throw new Error('seed refused: ' + o.verdict.reasons.join(','))
  }
  return { seq: o.entry.seq, hash: o.hash as Hash }
}
function worldWith(...defs: Json[]): World {
  const w = cloneWorld(EMPTY_WORLD)
  for (const d of defs) w.defs[H(d)] = d as unknown as Def
  return w
}
/** 身份 x + gen0（pins.p = SIG）；generations=2 时追加 gen 一代。 */
function seeded(generations = 1): { world: World; head: Head } {
  const world = worldWith(
    dRec('schema'),
    dRec('payload'),
    dRec('sig'),
    dRec('payload-alt'),
    dRec('sig-alt'),
  )
  let head: Head = { seq: -1, hash: null }
  head = link(head, world, req('ident', 'add_identity', J({ id: 'x', schema: SCHEMA }), head.hash))
  head = link(
    head,
    world,
    req('gen-a', 'add_gen', J({ id: 'x', payload: PAY, pins: { p: SIG }, sig: SIG }), head.hash),
  )
  if (generations > 1) {
    head = link(
      head,
      world,
      req('gen-b', 'add_gen', J({ id: 'x', payload: PAY_ALT, pins: {}, sig: SIG_ALT }), head.hash),
    )
  }
  return { world, head }
}
function input(over: Partial<KernelInput> = {}): KernelInput {
  return {
    world: cloneWorld(EMPTY_WORLD),
    head: { seq: -1, hash: null },
    run: RUN_ID,
    directives: [],
    results: {},
    limits: { gas: 5_000, depth: 16 },
    caps: { fs: true },
    now: NOW,
    ...over,
  } as unknown as KernelInput
}
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.getOwnPropertyNames(v)) deepFreeze((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

describe('纯函数：同输入重跑输出哈希一致，重放期逐字段复现 run 的世界', () => {
  it('同一 batch 写入跑两次、缺引用幻影 eval 再各跑两次：world / journal / head 等逐字段同哈希', () => {
    const batch = J({
      ops: [
        J({ op: 'put', args: dRec('batch-schema') }),
        J({ op: 'add_identity', args: J({ id: 'x', schema: { $n: 0 } }) }),
      ],
    })
    const mk = (): KernelInput =>
      input({
        directives: [
          { kind: 'write', request: req('boot-batch', 'batch', batch, null) } as Directive,
        ],
      })
    const a = run(mk())
    const b = run(mk())
    expect(a.status).toBe('done')
    const ghost = (): KernelInput =>
      input({
        directives: [
          { kind: 'eval', entry: 'a'.repeat(64), args: J(1), ctx: J(null) } as Directive,
        ],
      })
    const ghostFirst = run(ghost())
    const ghostSecond = run(ghost())
    expect(ghostFirst.status).toBe('refused')
    for (const [x, y] of [
      [a, b],
      [ghostFirst, ghostSecond],
    ]) {
      expect([H(J(x.world)), H(J(x.journal)), H(J(x.head))]).toEqual([
        H(J(y.world)),
        H(J(y.journal)),
        H(J(y.head)),
      ])
    }
    const o = run(mk())
    expect([H(J(o.pending)), H(J(o.observations)), H(J(o.usage)), o.status]).toEqual([
      H(J(b.pending)),
      H(J(b.observations)),
      H(J(b.usage)),
      b.status,
    ])
  })
  it('replay(journal) 从空世界逐字段复现（含 ids 的履历 at / by / write）', () => {
    const batch = J({
      ops: [
        J({ op: 'put', args: dRec('batch-schema') }),
        J({ op: 'put', args: dRec('gen-payload') }),
        J({ op: 'put', args: dRec('gen-sig') }),
        J({ op: 'add_identity', args: J({ id: 'x', schema: { $n: 0 } }) }),
        J({
          op: 'add_gen',
          args: J({ id: 'x', payload: { $n: 1 }, pins: {}, sig: { $n: 2 } }),
        }),
      ],
    })
    const o = run(
      input({
        directives: [
          { kind: 'write', request: req('full-batch', 'batch', batch, null) } as Directive,
        ],
      }),
    )
    expect([o.status, o.journal.length]).toEqual(['done', 1])
    const r = replay(o.journal)
    expect([snap(r), H(J(r))]).toEqual([snap(o.world), H(J(o.world))])
    const gen = o.world.ids['x'].gens[0]
    expect([gen.adopted.at, gen.adopted.by, gen.adopted.write]).toEqual([
      NOW,
      'tester',
      entryHash(o.journal[0]),
    ])
    expect(o.world.ids['x'].born).toEqual({ at: NOW, by: 'tester' }) // batch 内 add_identity 同点生效
  })
})

describe('可回滚：set_active 指回历史世代，gens 不缩、旧世代可再激活', () => {
  it('双世代来回切 + 退役后回切：gens 长度恒 2、active 可逆', () => {
    const { world, head } = seeded(2)
    const len0 = world.ids['x'].gens.length
    const setBackFirst = link(
      head,
      world,
      req('back', 'set_active', J({ id: 'x', active: PAY }), head.hash),
    )
    expect([world.ids['x'].gens.length, world.ids['x'].active]).toEqual([len0, PAY])
    const setForwardSecond = link(
      setBackFirst,
      world,
      req('fwd', 'set_active', J({ id: 'x', active: PAY_ALT }), setBackFirst.hash),
    )
    expect(world.ids['x'].active).toBe(PAY_ALT)
    const off = link(
      setForwardSecond,
      world,
      req('off', 'retire', J({ id: 'x' }), setForwardSecond.hash),
    )
    expect(world.ids['x'].active).toBeNull()
    link(off, world, req('redo', 'set_active', J({ id: 'x', active: PAY }), off.hash))
    expect([world.ids['x'].gens.length, world.ids['x'].active, off.seq]).toEqual([
      len0,
      PAY,
      off.seq,
    ])
  })
})

describe('幂等：同内容重复写入不追加日志、世界不动', () => {
  it('put 重复：世界不变、entry === null、pos 不动', () => {
    const world = worldWith()
    const first = commit(
      { seq: -1, hash: null },
      world,
      req('put-1', 'put', dRec('dup-probe'), null),
      NOW,
    )
    const head: Head = { seq: 0, hash: first.hash as Hash }
    const before = [snap(world), worldRev(world)]
    const again = commit(head, world, req('put-2', 'put', dRec('dup-probe'), head.hash), NOW)
    expect([again.entry, again.hash, again.verdict.reasons, again.verdict.pos]).toEqual([
      null,
      null,
      ['dup'],
      head.hash,
    ])
    expect([snap(world), worldRev(world)]).toEqual(before)
  })
  it('batch 全幂等重提：日志不追加、世界逐字节不动', () => {
    const world = worldWith()
    const ops = J({
      ops: [J({ op: 'put', args: dRec('alpha') }), J({ op: 'put', args: dRec('beta') })],
    })
    const first = commit({ seq: -1, hash: null }, world, req('batch-1', 'batch', ops, null), NOW)
    const head: Head = { seq: 0, hash: first.hash as Hash }
    const [before, rev] = [snap(world), worldRev(world)]
    const again = commit(head, world, req('batch-2', 'batch', ops, head.hash), NOW)
    expect([again.entry, again.verdict.reasons, snap(world), worldRev(world)]).toEqual([
      null,
      ['dup'],
      before,
      rev,
    ])
  })
})

describe('深冻结入参：applyEntry / batch / 嵌套 batch / verify / replay 逐字节不动传入 entry', () => {
  const entry = (op: Op, args: Json, seq: number, prev: Hash | null): Entry =>
    ({ seq, prev, op, args, argsHash: '', by: 'tester', at: NOW }) as Entry
  it('深冻结后逐字节一致；严格模式下任何就地改写会当场抛（红）', () => {
    const plainWorld = cloneWorld(EMPTY_WORLD)
    const frozenPut = deepFreeze(entry('put', dRec('frozen-probe'), 0, null))
    const beforePut = snap(frozenPut)
    expect(applyEntry(plainWorld, frozenPut).ok).toBe(true)
    expect(snap(frozenPut)).toBe(beforePut)
    const nested = deepFreeze(
      entry(
        'batch',
        J({
          ops: [
            J({ op: 'batch', args: J({ ops: [J({ op: 'put', args: dRec('nested-put') })] }) }),
            J({ op: 'add_identity', args: J({ id: 'n', schema: SCHEMA }) }),
            J({ op: 'note', args: J({}) }),
          ],
        }),
        0,
        null,
      ),
    )
    const nestedWorld = worldWith(dRec('nested-put'), dRec('schema'))
    const beforeN = snap(nested)
    const r = applyEntry(nestedWorld, nested)
    expect([r.ok, snap(nested)]).toEqual([true, beforeN])
    expect(r.ok && r.argsHash.length).toBe(64) // argsHash 走返回值，绝不回填传入的 e
  })
  it('verify / replay 吃冻结 entry：通过且入参零漂移（batch + $n 全路径)', () => {
    const { world, head } = seeded(1)
    const base = cloneWorld(world)
    const ops = J({
      ops: [
        J({ op: 'put', args: dRec('verify-put') }),
        J({ op: 'add_gen', args: J({ id: 'x', payload: { $n: 0 }, pins: {}, sig: SIG }) }),
      ],
    })
    const o = commit(head, world, req('verify-batch', 'batch', ops, head.hash), NOW)
    expect([o.verdict.ok, o.entry !== null]).toEqual([true, true])
    const e = deepFreeze({ ...o.entry } as Entry)
    const frozen = snap(e)
    const anchor = { world: base, head }
    expect(verify([e], anchor)).toEqual({ ok: true })
    expect(snap(e)).toBe(frozen)
    const w = replay([e], anchor.world)
    expect([snap(e), w.ids['x'].gens.length, snap(w)]).toEqual([frozen, 2, snap(world)])
  })
})
