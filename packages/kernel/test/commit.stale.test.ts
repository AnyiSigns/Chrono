// commit.ts 的依附判定验收（点分段，母文件 commit.test.ts）：只打公共面 ./index.ts。
// 种子世界构造与母文件同规则（就地重复，不另建共享夹具）。
// 本轮追加（评审方，未触任何既有断言）：T6 规矩 A 生效闸——stale 红→绿、内核不拒漏 pins、
// 门禁判据落在数据上（run 的 eval，与 host.ts 两行 check 同构）。
import { describe, expect, it } from 'vitest'

import { H, EMPTY_HEAD, EMPTY_WORLD, cloneWorld, commit, run, stale, validate } from '../index.ts'
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

// ── T6 · 规矩 A 生效（next-steps §3 闸 2：stale 红→绿；评审方公共面同构钉死，实现未触）──────

/** 规矩 A：manifest 的结构性依赖只写 pins（body 不重复列哈希——stale 只看 pins，两处必漂移）。 */
const manDef = (srcKey: Hash): Def => ({ body: asJson({ lang: 'ts' }), pins: { src: srcKey } })
const srcDef = (text: string): Record<string, Json> => ({ body: asJson({ lang: 'ts', text }) })
const SRC1_KEY = H(asJson(srcDef('source-v1')))
const SRC2_KEY = H(asJson(srcDef('source-v2-after-change')))
const MAN1_KEY = H(asJson(manDef(SRC1_KEY)))
const MAN2_KEY = H(asJson(manDef(SRC2_KEY)))
const T6_SCHEMA = defKey('t6-schema')
const T6_SIG = defKey('t6-sig')

/** 身份 plg 的谱系：gen0（pins.src=K1）→ [nGen=2] gen1（改后源码 K2，add_gen 即激活=set_active）。 */
function t6Lineage(nGen: 1 | 2): { world: World; head: Head } {
  const world = worldWith(
    buildDef('t6-schema'),
    buildDef('t6-sig'),
    srcDef('source-v1'),
    srcDef('source-v2-after-change'),
    manDef(SRC1_KEY) as unknown as Record<string, Json>,
    nGen === 2 ? (manDef(SRC2_KEY) as unknown as Record<string, Json>) : buildDef('unused-pad'),
  )
  let head: Head = EMPTY_HEAD
  head = link(
    head,
    world,
    opReq('add_identity', asJson({ id: 'plg', schema: T6_SCHEMA }), head.hash),
  )
  head = link(
    head,
    world,
    opReq(
      'add_gen',
      asJson({ id: 'plg', payload: MAN1_KEY, pins: { src: SRC1_KEY }, sig: T6_SIG }),
      head.hash,
    ),
  )
  if (nGen === 2)
    head = link(
      head,
      world,
      opReq(
        'add_gen',
        asJson({ id: 'plg', payload: MAN2_KEY, pins: { src: SRC2_KEY }, sig: T6_SIG }),
        head.hash,
      ),
    )
  return { world, head }
}

describe('T6 规矩 A 生效：stale 走 pins（红→绿验收闸）', () => {
  it('绿面：旧 manifest 的 pins.src=K1 对激活 gen（pins.src=K2）判 stale；当前 manifest 不 stale', () => {
    const { world } = t6Lineage(1)
    expect(world.ids['plg'].active).toBe(MAN1_KEY)
    expect(stale(manDef(SRC1_KEY), world, 'plg')).toBe(false) // 世代未更替：控制例不误判
    const { world: after } = t6Lineage(2)
    expect(after.ids['plg'].active).toBe(MAN2_KEY)
    expect(stale(manDef(SRC1_KEY), after, 'plg')).toBe(true) // 换源码 ⇒ 旧依附失效——判定第一次真生效
    expect(stale(manDef(SRC2_KEY), after, 'plg')).toBe(false)
  })

  it('红相留档：同场景旧写法（引用只在 body、pins 缺失）stale 恒 false——洞是真的，门禁不能落在 stale', () => {
    const { world } = t6Lineage(2)
    // 这就是 host.ts 补 pins 前一定红的构造：body 里的 src 引用对内核不透明（§11.2 ②能力边界）。
    expect(stale({ body: asJson({ lang: 'ts', src: SRC1_KEY }) }, world, 'plg')).toBe(false)
  })

  it('内核不拒漏 pins：老式 def 与 pins:{} 的 gen 经 validate/commit 全过（拒必须来自宿主数据）', () => {
    const legacyMan: Record<string, Json> = { body: asJson({ lang: 'ts', src: SRC1_KEY }) }
    const world = worldWith(
      buildDef('t6-schema'),
      buildDef('t6-sig'),
      srcDef('source-v1'),
      legacyMan,
    )
    const legacyKey = H(asJson(legacyMan))
    let head: Head = EMPTY_HEAD
    head = link(
      head,
      world,
      opReq('add_identity', asJson({ id: 'plg', schema: T6_SCHEMA }), head.hash),
    )
    const legacyGen = opReq(
      'add_gen',
      asJson({ id: 'plg', payload: legacyKey, pins: {}, sig: T6_SIG }),
      head.hash,
    )
    expect(validate(head, world, legacyGen).reasons).toEqual([]) // ②引用检查只看 pins 的值，不问"有没有"
    const out = commit(head, world, legacyGen, 1_234_567)
    expect([out.verdict.ok, out.entry === null]).toEqual([true, false])
  })

  it('门禁判据落在数据上：schema term ["g",["pins","src"]] 经 run 求值——声明 pins 的 gen 放行、漏 pins 的拒', () => {
    const schemaTerm: Record<string, Json> = { body: asJson(['g', ['pins', 'src']]) }
    const schemaKey = H(asJson(schemaTerm))
    const { world, head } = t6Lineage(2)
    world.defs[schemaKey] = schemaTerm as unknown as Def // 门禁 def 先入世（宿主经正常 put，位置无关）
    const gate = (genCandidate: Json) =>
      run({
        world,
        head,
        run: 't6-gate',
        now: 7_777,
        caps: {},
        limits: { gas: 100, depth: 8 },
        results: {},
        directives: [{ kind: 'eval', entry: schemaKey, args: genCandidate, ctx: genCandidate }],
      } as unknown as Parameters<typeof run>[0])
    const genOk = asJson({ id: 'plg', payload: MAN2_KEY, pins: { src: SRC2_KEY }, sig: T6_SIG })
    const pass = gate(genOk)
    expect(pass.status).toBe('done')
    expect(
      (pass.observations[pass.observations.length - 1] as { kind?: string; value?: Json }).value,
    ).toBe(SRC2_KEY) // 门禁放行：term 在世界里求值得到 pin 值
    const genBad = asJson({ id: 'plg', payload: MAN2_KEY, sig: T6_SIG }) // 漏 pins——内核不拒，数据判据拒
    const rejected = gate(genBad)
    expect(rejected.status).toBe('refused')
    const last = rejected.observations[rejected.observations.length - 1] as {
      kind?: string
      reasons?: string[]
    }
    expect([last.kind, (last.reasons ?? []).includes('missing_path')]).toEqual(['refused', true])
    expect(world.ids['plg'].active).toBe(MAN2_KEY) // 求值不改世界（refused 整次作废）
  })
})
