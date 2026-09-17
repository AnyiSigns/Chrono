// commit.ts 验收：只打公共面 ./index.ts。
// applyEntry / entryHash 计数桩：journal.ts 是转口母文件，故 vi.mock('../journal.ts')
// 包一层透传计数；桩内不解构绑定。
import { describe, expect, it, vi, afterEach } from 'vitest'

const counters = vi.hoisted(() => ({
  applyEntry: 0,
  entryHash: 0,
  seen: [] as unknown[],
  atCall: [] as unknown[],
  returned: [] as unknown[],
}))

vi.mock('../journal.ts', async (importOriginal) => {
  const o = (await importOriginal()) as Record<string, unknown>
  return {
    ...o,
    applyEntry: (...args: unknown[]) => {
      counters.applyEntry += 1
      counters.seen.push(args[1])
      counters.atCall.push((args[1] as { argsHash: unknown }).argsHash)
      const r = (o.applyEntry as (...a: unknown[]) => unknown)(...args)
      counters.returned.push(r)
      return r
    },
    entryHash: (...args: unknown[]) => {
      counters.entryHash += 1
      return (o.entryHash as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import {
  commit,
  entryOf,
  validate,
  entryHash,
  H,
  EMPTY_HEAD,
  EMPTY_WORLD,
  cloneWorld,
  worldRev,
} from '../index.ts'
import type { Def, Hash, Json, World, WriteRequest } from '../index.ts'

const NOW = 1_234_567
const asJson = (v: unknown): Json => v as Json
/** commit 的 head 形参类型（Head 未在此面单独命名，取公共面签名即等价类型）。 */
type Head = Parameters<typeof commit>[0]
const buildDef = (body: Json): Record<string, Json> => ({ body })
const defKey = (body: Json): Hash => H(buildDef(body))
const SCHEMA_KEY = defKey('schema')
const PAYLOAD_KEY = defKey('payload')
const SIG_KEY = defKey('sig')
const NEXT_PAYLOAD_KEY = defKey('payloadNext')
const NEXT_SIG_KEY = defKey('sigNext')
const GHOST = 'ab'.repeat(32)

const opReq = (op: string, args: Json, pos: Hash | null = null): WriteRequest =>
  ({ id: 'r1', op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest
const putReq = (body: Json, pos: Hash | null = null): WriteRequest =>
  opReq('put', buildDef(body), pos)

function worldWith(...defs: Record<string, Json>[]): World {
  const w = cloneWorld(EMPTY_WORLD)
  for (const d of defs) w.defs[H(asJson(d))] = d as unknown as Def
  return w
}
const snap = (w: World): string => JSON.stringify(w)

function link(head: Head, world: World, req: WriteRequest): Head {
  const out = commit(head, world, req, NOW)
  if (!out.verdict.ok || out.entry === null) {
    throw new Error('seed commit refused: ' + out.verdict.reasons.join(','))
  }
  return { seq: out.entry.seq, hash: out.hash as Hash }
}

function genReq(
  id: string,
  payload: Hash,
  sig: Hash,
  pos: Hash | null,
  pins: Record<string, Hash> = { p: sig },
): WriteRequest {
  return opReq('add_gen', asJson({ id, payload, pins, sig }), pos)
}

/** 世界：5 条 def + 身份 x + gen0{payload,pins{p:sig},sig}；nGen>1 加 gen1；retire 退役。 */
function seeded(nGen = 1, retire = false): { world: World; head: Head } {
  const world = worldWith(
    buildDef('schema'),
    buildDef('payload'),
    buildDef('sig'),
    buildDef('payloadNext'),
    buildDef('sigNext'),
  )
  let head: Head = EMPTY_HEAD
  head = link(
    head,
    world,
    opReq('add_identity', asJson({ id: 'x', schema: SCHEMA_KEY }), head.hash),
  )
  head = link(head, world, genReq('x', PAYLOAD_KEY, SIG_KEY, head.hash))
  if (nGen > 1)
    head = link(
      head,
      world,
      genReq('x', NEXT_PAYLOAD_KEY, NEXT_SIG_KEY, head.hash, {
        p: NEXT_PAYLOAD_KEY,
      }),
    )
  if (retire)
    head = link(head, world, opReq('set_active', asJson({ id: 'x', active: null }), head.hash))
  return { world, head }
}

function win(): void {
  counters.applyEntry = 0
  counters.entryHash = 0
  counters.seen = []
  counters.atCall = []
  counters.returned = []
}

afterEach(win)

describe('validate 四步：形态 → 引用 → 位置 → 不变量', () => {
  it('形态 正例：put / note / expect_pos=null 全过', () => {
    expect(validate(EMPTY_HEAD, EMPTY_WORLD, putReq('a'))).toEqual({
      ok: true,
      reasons: [],
      pos: null,
      written: [],
    })
    expect(validate(EMPTY_HEAD, EMPTY_WORLD, opReq('note', asJson({})))).toMatchObject({ ok: true })
  })

  it('形态 反例：未知 op / args 缺 body / expect_pos 非 64-hex → bad_form', () => {
    const world = worldWith(buildDef('a'))
    const bads = [
      opReq('nope', asJson({})),
      opReq('put', asJson({ pins: {} })),
      opReq('put', buildDef('a'), GHOST.slice(0, 62)),
    ]
    for (const bad of bads) {
      expect(validate(EMPTY_HEAD, world, bad).reasons).toEqual(['bad_form'])
    }
  })

  it('正例：put.sig / put.pins / request.ref / add_identity.schema 均在 defs', () => {
    const world = worldWith(buildDef('a'), buildDef('sig'), buildDef('schema'), buildDef('payload'))
    const body = asJson({ body: buildDef('a'), sig: SIG_KEY, pins: { k: SCHEMA_KEY } })
    expect(validate(EMPTY_HEAD, world, opReq('put', body))).toMatchObject({ ok: true })
    expect(validate(EMPTY_HEAD, world, { ...putReq('a'), ref: SIG_KEY })).toMatchObject({
      ok: true,
    })
    expect(
      validate(EMPTY_HEAD, world, opReq('add_identity', asJson({ id: 'z', schema: SCHEMA_KEY }))),
    ).toMatchObject({ ok: true })
    expect(
      validate(EMPTY_HEAD, world, genReq('x', PAYLOAD_KEY, SIG_KEY, null, { k: SCHEMA_KEY })),
    ).toMatchObject({
      ok: true,
    })
  })

  it('引用 反例：内核认识的字段坏引用一律 missing_ref', () => {
    const world = worldWith(buildDef('a'))
    const bads: WriteRequest[] = [
      opReq('add_identity', asJson({ id: 'z', schema: GHOST })),
      opReq('put', asJson({ body: buildDef('a'), sig: GHOST })),
      opReq('put', asJson({ body: buildDef('a'), pins: { k: GHOST } })),
      { ...putReq('a'), ref: GHOST },
      genReq('x', GHOST, SIG_KEY, null, {}),
    ]
    for (const b of bads) expect(validate(EMPTY_HEAD, world, b).reasons).toEqual(['missing_ref'])
  })

  it('位置：expect_pos 过期 → pos_conflict；相等则过', () => {
    const { world, head } = seeded()
    expect(validate(head, world, putReq('new', head.hash))).toMatchObject({ ok: true })
    const v = validate(head, world, putReq('new', SIG_KEY))
    expect([v.ok, v.reasons, v.pos]).toEqual([false, ['pos_conflict'], head.hash])
  })

  it('身份唯一性：新 id 过；已在 ids 与 retired 占位 → id_taken', () => {
    const { world, head } = seeded()
    expect(
      validate(
        head,
        world,
        opReq('add_identity', asJson({ id: 'y', schema: SCHEMA_KEY }), head.hash),
      ),
    ).toMatchObject({ ok: true })
    expect(
      validate(
        head,
        world,
        opReq('add_identity', asJson({ id: 'x', schema: SCHEMA_KEY }), head.hash),
      ).reasons,
    ).toEqual(['id_taken'])
    const { world: retiredWorld, head: retiredHead } = seeded(1, true)
    expect(retiredWorld.ids['x'].active).toBeNull()
    expect(
      validate(
        retiredHead,
        retiredWorld,
        opReq('add_identity', asJson({ id: 'x', schema: SCHEMA_KEY }), retiredHead.hash),
      ).reasons,
    ).toEqual(['id_taken'])
  })

  it('父身份：fork/graft 缺父或 gen 越界 → missing_parent；父在则过', () => {
    const { world, head } = seeded()
    expect(validate(head, world, genReq('x', PAYLOAD_KEY, SIG_KEY, head.hash, {}))).toMatchObject({
      ok: true,
    })
    const graft = (from: string, g: number): WriteRequest =>
      opReq(
        'graft',
        asJson({ id: 'g', payload: PAYLOAD_KEY, pins: {}, sig: SIG_KEY, from, gen: g }),
        head.hash,
      )
    expect(validate(head, world, graft('ghost', 0)).reasons).toEqual(['missing_parent'])
    expect(validate(head, world, graft('x', 9)).reasons).toEqual(['missing_parent'])
    expect(
      validate(
        head,
        world,
        opReq('fork', asJson({ id: 'f', schema: SCHEMA_KEY, parent: 'ghost' }), head.hash),
      ).reasons,
    ).toEqual(['missing_parent'])
    expect(
      validate(
        head,
        world,
        opReq('fork', asJson({ id: 'f', schema: SCHEMA_KEY, parent: 'x' }), head.hash),
      ),
    ).toMatchObject({ ok: true })
  })

  it('validate 只读：五类判定跑完，世界与 head 分文未动、不触发 apply', () => {
    const { world, head } = seeded(2)
    const before = snap(world)
    const headBefore = JSON.stringify(head)
    win()
    validate(head, world, putReq('a', head.hash))
    validate(head, world, opReq('add_identity', asJson({ id: 'x', schema: SCHEMA_KEY }), head.hash))
    validate(head, world, opReq('nope', asJson({}), head.hash))
    expect(snap(world)).toBe(before)
    expect(JSON.stringify(head)).toBe(headBefore)
    expect(counters.applyEntry).toBe(0)
  })

  it('add_gen args 带 seq → bad_form（validate 与 commit 双入口）', () => {
    const { world, head } = seeded()
    const bad = opReq(
      'add_gen',
      asJson({ id: 'x', payload: PAYLOAD_KEY, pins: {}, sig: SIG_KEY, seq: 0 }),
      head.hash,
    )
    expect(validate(head, world, bad).reasons).toEqual(['bad_form'])
    const before = snap(world)
    win()
    const out = commit(head, world, bad, NOW)
    expect([out.verdict.ok, out.entry, out.hash, snap(world)]).toEqual([false, null, null, before])
    expect(counters.applyEntry).toBe(0)
  })
})

describe('幂等、batch 应用趟、审计 op', () => {
  it('batch 不递归：子 op 坏引用经 validate 放行、commit 应用趟转拒', () => {
    const { world, head } = seeded()
    const before = snap(world)
    const req = opReq(
      'batch',
      asJson({
        ops: [asJson({ op: 'add_identity', args: asJson({ id: 'b', schema: GHOST }) })],
      }),
      head.hash,
    )
    expect(validate(head, world, req)).toMatchObject({ ok: true })
    win()
    const out = commit(head, world, req, NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry, out.hash, out.verdict.pos]).toEqual([
      false,
      ['missing_ref'],
      null,
      null,
      head.hash,
    ])
    expect(snap(world)).toBe(before)
    expect(counters.returned.at(-1)).toMatchObject({ ok: false, error: 'missing_ref' })
    expect(counters.applyEntry).toBe(1)
  })

  it('id_taken 兜底：batch 第二个 add_identity 撞第一个新开的 id → 整批回滚', () => {
    const { world, head } = seeded()
    const before = snap(world)
    const sub = asJson({ op: 'add_identity', args: asJson({ id: 'dup', schema: SCHEMA_KEY }) })
    const out = commit(head, world, opReq('batch', asJson({ ops: [sub, sub] }), head.hash), NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry, out.verdict.pos]).toEqual([
      false,
      ['id_taken'],
      null,
      head.hash,
    ])
    expect(snap(world)).toBe(before)
    expect('dup' in world.ids).toBe(false)
  })

  it('重复 put → ok:true + reasons[dup]、entry=null、世界与 pos 不变', () => {
    const world = worldWith(buildDef('dupme'))
    win()
    const out = commit(EMPTY_HEAD, world, putReq('dupme'), NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry, out.hash, out.verdict.pos]).toEqual([
      true,
      ['dup'],
      null,
      null,
      null,
    ])
    expect(snap(world)).toBe(snap(worldWith(buildDef('dupme'))))
    expect(counters.applyEntry).toBe(1)
    expect((counters.returned[0] as { isNoop: boolean }).isNoop).toBe(true)
  })

  it('全幂等 batch → ok:true + dup、entry=null、世界不变', () => {
    const world = worldWith(buildDef('dupPayload'), buildDef('otherPayload'))
    const req = opReq(
      'batch',
      asJson({
        ops: [
          asJson({ op: 'put', args: buildDef('dupPayload') }),
          asJson({ op: 'put', args: buildDef('otherPayload') }),
        ],
      }),
    )
    const out = commit(EMPTY_HEAD, world, req, NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry, out.hash]).toEqual([
      true,
      ['dup'],
      null,
      null,
    ])
    expect(snap(world)).toBe(snap(worldWith(buildDef('dupPayload'), buildDef('otherPayload'))))
  })

  it('空批 ops:[] → 过形态、commit 转 dup、不产生 entry、世界不动', () => {
    const { world, head } = seeded()
    const before = snap(world)
    const req = opReq('batch', asJson({ ops: [] }), head.hash)
    expect(validate(head, world, req)).toMatchObject({ ok: true })
    const out = commit(head, world, req, NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry, out.hash, out.verdict.pos]).toEqual([
      true,
      ['dup'],
      null,
      null,
      head.hash,
    ])
    expect(snap(world)).toBe(before)
  })

  it('note / snapshot：世界不变但 entry !== null（isNoop 恒 false）', () => {
    const { world, head } = seeded()
    const before = snap(world)
    const rev = worldRev(world)
    const noteResult = commit(head, world, opReq('note', asJson({}), head.hash), NOW)
    expect([noteResult.entry === null, noteResult.verdict.reasons, snap(world)]).toEqual([
      false,
      [],
      before,
    ])
    const head2 = { seq: noteResult.entry?.seq as number, hash: noteResult.hash as Hash }
    const snapshotResult = commit(
      head2,
      world,
      opReq('snapshot', asJson({ world_rev: rev }), head2.hash),
      NOW,
    )
    expect(snapshotResult.verdict.reasons).toEqual([])
    expect(snapshotResult.verdict.pos).toBe(entryHash(snapshotResult.entry!))
    expect(snap(world)).toBe(before)
    expect(worldRev(world)).toBe(rev)
    expect([snapshotResult.entry === null, snapshotResult.verdict.written]).toEqual([false, []])
  })
})

describe('applyEntry 恰一次、argsHash 唯一回填点、hash 不重算', () => {
  it('单 op：commit 对 in-chain entry 调 applyEntry 恰一次、entryHash 恰一次', () => {
    const world = worldWith()
    win()
    const out = commit(EMPTY_HEAD, world, putReq('solo'), NOW)
    expect(out.verdict.ok).toBe(true)
    expect(counters.applyEntry).toBe(1)
    expect(counters.seen[0]).toBe(out.entry)
    expect(counters.entryHash).toBe(1)
  })

  it('batch：只计外层 in-chain entry，合成子不占位', () => {
    const { world, head } = seeded()
    win()
    const out = commit(
      head,
      world,
      opReq(
        'batch',
        asJson({
          ops: [
            asJson({ op: 'put', args: buildDef('n1') }),
            asJson({ op: 'note', args: asJson({}) }),
          ],
        }),
        head.hash,
      ),
      NOW,
    )
    expect(out.verdict.ok).toBe(true)
    expect(counters.applyEntry).toBe(1)
    expect(counters.seen[0]).toBe(out.entry)
  })

  it('entryOf 只构造不应用：seq/prev/at 就位，argsHash 为占位输出位', () => {
    const { world, head } = seeded()
    const before = snap(world)
    win()
    const e = entryOf(head, putReq('only'), NOW + 1)
    expect([e.seq, e.prev, e.at, e.op, e.by]).toEqual([
      head.seq + 1,
      head.hash,
      NOW + 1,
      'put',
      'tester',
    ])
    expect(e.argsHash).not.toBe(H(e.args))
    expect(counters.applyEntry).toBe(0)
    expect(snap(world)).toBe(before)
    const first = entryOf(EMPTY_HEAD, putReq('only'), NOW)
    expect([first.seq, first.prev]).toEqual([0, null])
  })

  it('put 的 argsHash === H(Def) === defs 的键', () => {
    const world = worldWith()
    const out = commit(EMPTY_HEAD, world, putReq('the-key'), NOW)
    expect(out.entry?.argsHash).toBe(H(buildDef('the-key')))
    expect(Object.keys(world.defs)).toEqual([H(buildDef('the-key'))])
  })

  it('batch argsHash 由子哈希聚合', () => {
    const firstPutKey = H(buildDef('b1'))
    const secondPutKey = H(buildDef('b2'))
    const world = worldWith()
    const args = asJson({
      ops: [
        asJson({ op: 'put', args: buildDef('b1') }),
        asJson({ op: 'put', args: buildDef('b2') }),
      ],
    })
    const out = commit(EMPTY_HEAD, world, opReq('batch', args), NOW)
    expect(out.entry?.argsHash).toBe(
      H(
        asJson({
          ops: [
            ['put', firstPutKey],
            ['put', secondPutKey],
          ],
        }),
      ),
    )
    expect(out.entry?.argsHash).not.toBe(H(args))
  })

  it('回填：调用时仍占位，commit 后 entry.argsHash === applyEntry 返回值', () => {
    const world = worldWith()
    win()
    const placeholder = entryOf(EMPTY_HEAD, putReq('backfill'), NOW).argsHash
    const out = commit(EMPTY_HEAD, world, putReq('backfill'), NOW)
    expect(counters.atCall[0]).toBe(placeholder)
    expect(out.entry?.argsHash).not.toBe(placeholder)
    expect((counters.returned[0] as { argsHash: string }).argsHash).toBe(out.entry?.argsHash)
  })

  it('commit 返回 hash === entryHash(entry)，本次 commit 只算一次', () => {
    const world = worldWith()
    win()
    const out = commit(EMPTY_HEAD, world, putReq('hashonce'), NOW)
    expect(counters.entryHash).toBe(1)
    expect(entryHash(out.entry!)).toBe(out.hash)
  })

  it('链式推进：head 由返回 hash 续；错位被拒不推进', () => {
    const world = worldWith()
    let head: Head = EMPTY_HEAD
    head = link(head, world, putReq('e1', head.hash))
    const stalePos = head.hash
    head = link(head, world, putReq('e2', head.hash))
    expect([head.seq, head.hash !== stalePos]).toEqual([1, true])
    const bad = commit(head, world, putReq('e3', stalePos), NOW)
    expect([bad.verdict.reasons, bad.verdict.pos]).toEqual([['pos_conflict'], head.hash])
  })
})
