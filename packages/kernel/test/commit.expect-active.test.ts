// add_gen 可选前置 expect_active 的验收：只打公共面 ./index.ts。
// 契约：未提供该键 = 不检查；显式 null 与身份 active=null（新生 / 退役）相等；
// 不匹配抛 stale_active（单 op 直达 / batch 子 op 整批回滚）。
import { describe, expect, it } from 'vitest'

import {
  commit,
  cloneWorld,
  EMPTY_HEAD,
  EMPTY_WORLD,
  H,
  replay,
  validate,
  verify,
  worldRev,
} from '../index.ts'
import type { Entry, Hash, Json, World, WriteRequest } from '../index.ts'

const NOW = 1_234_567
const asJson = (v: unknown): Json => v as Json
/** commit 的 head 形参类型（Head 未在此面单独命名，取公共面签名即等价类型）。 */
type Head = Parameters<typeof commit>[0]
const buildDef = (body: Json): Record<string, Json> => ({ body })
const defKey = (body: Json): Hash => H(buildDef(body))
const SCHEMA_KEY = defKey('schema')
const PAYLOAD_KEY = defKey('payload')
const NEXT_PAYLOAD_KEY = defKey('payload2')
const SIG_KEY = defKey('sig')

const opReq = (op: string, args: Json, pos: Hash | null = null): WriteRequest =>
  ({ id: 'r1', op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest

function link(head: Head, world: World, req: WriteRequest, journal: Entry[]): Head {
  const out = commit(head, world, req, NOW)
  if (!out.verdict.ok || out.entry === null) {
    throw new Error('seed commit refused: ' + out.verdict.reasons.join(','))
  }
  journal.push(out.entry)
  return { seq: out.entry.seq, hash: out.hash as Hash }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return '<no throw>'
  } catch (err) {
    const c = (err as { code?: unknown }).code
    return typeof c === 'string' ? c : '<非 KernelError>'
  }
}

const genArgs = (payload: Hash, extra: Record<string, Json> = {}, sig: Hash = SIG_KEY): Json =>
  asJson({ id: 'x', payload, pins: {}, sig, ...extra })

/** 世界：4 条 def（经 put 入链，重放自足）+ 身份 x（无世代）；journal 收集已入链 entry。 */
function emptyIdentity(): { world: World; head: Head; journal: Entry[] } {
  const world = cloneWorld(EMPTY_WORLD)
  const journal: Entry[] = []
  let head: Head = EMPTY_HEAD
  for (const body of ['schema', 'payload', 'payload2', 'sig']) {
    head = link(head, world, opReq('put', buildDef(body), head.hash), journal)
  }
  head = link(
    head,
    world,
    opReq('add_identity', asJson({ id: 'x', schema: SCHEMA_KEY }), head.hash),
    journal,
  )
  return { world, head, journal }
}

/** 世界：身份 x 已有一个激活世代（active = PAYLOAD_KEY）。 */
function activeIdentity(): { world: World; head: Head; journal: Entry[] } {
  const seeded = emptyIdentity()
  seeded.head = link(
    seeded.head,
    seeded.world,
    opReq('add_gen', genArgs(PAYLOAD_KEY), seeded.head.hash),
    seeded.journal,
  )
  return seeded
}

describe('add_gen expect_active：形态', () => {
  it('合法值（64-hex / null）过形态；非法值 → bad_form', () => {
    const { world, head } = activeIdentity()
    expect(
      validate(
        head,
        world,
        opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: PAYLOAD_KEY }), head.hash),
      ),
    ).toMatchObject({ ok: true })
    expect(
      validate(
        head,
        world,
        opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: null }), head.hash),
      ),
    ).toMatchObject({ ok: true })
    for (const bad of ['zz', 123, true, asJson({})]) {
      expect(
        validate(
          head,
          world,
          opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: bad }), head.hash),
        ).reasons,
      ).toEqual(['bad_form'])
    }
  })
})

describe('add_gen expect_active：生效判定', () => {
  it('匹配当前 active → 成功并激活新世代', () => {
    const { world, head } = activeIdentity()
    const out = commit(
      head,
      world,
      opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: PAYLOAD_KEY }), head.hash),
      NOW,
    )
    expect(out.verdict.ok).toBe(true)
    expect(world.ids['x'].gens.map((g) => g.payload)).toEqual([PAYLOAD_KEY, NEXT_PAYLOAD_KEY])
    expect(world.ids['x'].active).toBe(NEXT_PAYLOAD_KEY)
  })

  it('不匹配（别的世代 / 退役态给非 null）→ stale_active，世界分文未动', () => {
    const { world, head } = activeIdentity()
    const before = JSON.stringify(world)
    expect(
      codeOf(() =>
        commit(
          head,
          world,
          opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: SIG_KEY }), head.hash),
          NOW,
        ),
      ),
    ).toBe('stale_active')
    expect(JSON.stringify(world)).toBe(before)
  })

  it('显式 null 与新生身份 active=null 匹配；active 非 null 时显式 null → stale_active', () => {
    const fresh = emptyIdentity()
    expect(fresh.world.ids['x'].active).toBeNull()
    const ok = commit(
      fresh.head,
      fresh.world,
      opReq('add_gen', genArgs(PAYLOAD_KEY, { expect_active: null }), fresh.head.hash),
      NOW,
    )
    expect(ok.verdict.ok).toBe(true)

    const active = activeIdentity()
    expect(
      codeOf(() =>
        commit(
          active.head,
          active.world,
          opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: null }), active.head.hash),
          NOW,
        ),
      ),
    ).toBe('stale_active')
  })

  it('未提供该键 → 行为与现状一致（不检查 active）', () => {
    const { world, head } = activeIdentity()
    const out = commit(head, world, opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY), head.hash), NOW)
    expect(out.verdict.ok).toBe(true)
    expect(world.ids['x'].active).toBe(NEXT_PAYLOAD_KEY)
  })
})

describe('add_gen expect_active：batch 原子性', () => {
  it('批内含 stale 子 op → 整批 stale_active，世界分文未动', () => {
    const { world, head } = activeIdentity()
    const before = JSON.stringify(world)
    const req = opReq(
      'batch',
      asJson({
        ops: [
          asJson({ op: 'put', args: buildDef('fresh') }),
          asJson({ op: 'add_gen', args: genArgs(NEXT_PAYLOAD_KEY, { expect_active: SIG_KEY }) }),
        ],
      }),
      head.hash,
    )
    const out = commit(head, world, req, NOW)
    expect([out.verdict.ok, out.verdict.reasons, out.entry]).toEqual([
      false,
      ['stale_active'],
      null,
    ])
    expect(JSON.stringify(world)).toBe(before)
    expect(world.defs[defKey('fresh')]).toBeUndefined()
  })
})

describe('add_gen expect_active：重放一致', () => {
  it('带 expect_active 的链可重放、可校验，世界摘要与提交时一致', () => {
    const { world, head, journal } = activeIdentity()
    const next = link(
      head,
      world,
      opReq('add_gen', genArgs(NEXT_PAYLOAD_KEY, { expect_active: PAYLOAD_KEY }), head.hash),
      journal,
    )
    expect(next.hash).not.toBe(head.hash)
    expect(verify(journal)).toEqual({ ok: true })
    expect(worldRev(replay(journal))).toBe(worldRev(world))
  })
})
