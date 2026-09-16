// commit.ts 的依附判定验收（点分段，母文件 commit.test.ts）：只打公共面 ./index.ts。
// 种子世界构造与母文件同规则（就地重复，不另建共享夹具）。
import { describe, expect, it } from 'vitest'

import { H, EMPTY_HEAD, cloneWorld, commit, EMPTY_WORLD, stale } from './index.ts'
import type { Def, Hash, Json, World, WriteRequest } from './index.ts'

const NOW = 1_234_567
const asJson = (v: unknown): Json => v as Json
/** commit 的 head 形参类型（Head 未在此面单独命名，取公共面签名即等价类型）。 */
type Head = Parameters<typeof commit>[0]
const buildDef = (body: Json): Record<string, Json> => ({ body })
const defKey = (body: Json): Hash => H(buildDef(body))
const SCHEMA_KEY = defKey('schema')
const PAYLOAD_KEY = defKey('payload')
const SIG_KEY = defKey('sig')
const NEXT_PAYLOAD_KEY = defKey('payload2')
const NEXT_SIG_KEY = defKey('sig2')

const opReq = (op: string, args: Json, pos: Hash | null = null): WriteRequest =>
  ({ id: 'r1', op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest

function worldWith(...defs: Record<string, Json>[]): World {
  const w = cloneWorld(EMPTY_WORLD)
  for (const d of defs) w.defs[H(asJson(d))] = d as unknown as Def
  return w
}

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
    buildDef('payload2'),
    buildDef('sig2'),
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

describe('stale 两口径', () => {
  const lastGen = (world: World) => {
    const x = world.ids['x']
    return x.gens[x.gens.length - 1]
  }

  it('sig 变 → true；sig 与 pins 都兼容 → false', () => {
    const { world } = seeded(1)
    const g = lastGen(world)
    expect(stale({ body: asJson(1), sig: NEXT_SIG_KEY } as Def, world, 'x')).toBe(true)
    expect(
      stale({ body: asJson(1), sig: g.sig, pins: { p: g.pins['p'] } } as Def, world, 'x'),
    ).toBe(false)
  })

  it('pins 精确断言：值变或 gen 缺该名 → true（保守）', () => {
    const { world } = seeded(1)
    expect(stale({ body: asJson(1), pins: { p: NEXT_PAYLOAD_KEY } } as Def, world, 'x')).toBe(true)
    expect(stale({ body: asJson(1), pins: { nope: PAYLOAD_KEY } } as Def, world, 'x')).toBe(true)
  })

  it('身份 retired / 不存在 → true（未知即隔离）', () => {
    const { world } = seeded(1, true)
    expect(stale({ body: asJson(1) } as Def, world, 'x')).toBe(true)
    expect(stale({ body: asJson(1) } as Def, world, 'ghost-id')).toBe(true)
  })

  it('sig / pins 双缺 → 恒 false（宽松口径）', () => {
    const { world } = seeded(2)
    expect(stale({ body: asJson(1) } as Def, world, 'x')).toBe(false)
  })

  it('sig 单侧 null 不因 sig 判 stale：def 无 sig 而 gen 有 → false', () => {
    const { world } = seeded(1)
    expect(lastGen(world).sig).toBe(SIG_KEY)
    expect(stale({ body: asJson(1), pins: { p: SIG_KEY } } as Def, world, 'x')).toBe(false)
  })

  it('世代更替：gen0 兼容 def 相对 gen1 为 stale；旧 gen 不删除', () => {
    const { world } = seeded(2)
    expect(world.ids['x'].gens.map((g) => g.seq)).toEqual([0, 1])
    expect(stale({ body: asJson(1), sig: SIG_KEY, pins: { p: SIG_KEY } } as Def, world, 'x')).toBe(
      true,
    )
    expect(
      stale(
        { body: asJson(1), sig: NEXT_SIG_KEY, pins: { p: NEXT_PAYLOAD_KEY } } as Def,
        world,
        'x',
      ),
    ).toBe(false)
  })
})
