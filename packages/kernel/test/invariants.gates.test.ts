// 世界判定门禁与性能预算的行为不变量：唯一写口、引用完整性、能力来源、内容身份覆盖、
// 批量原子性、哈希预算、终止性、审核词表缺席。
// 豁免登记（本文件为 *.test.ts）：node:fs / node:url 仅用于静态扫描源码，不进内核运行时；
// vi.mock 只装透传计数桩（计算结果与原函数逐字节一致，仅累加计数），afterEach 归零。
// @ts-ignore 工具链白名单不含 @types/node：本测试文件用 node fs 读源码（豁免见文件头）
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({ canon: 0, entryHash: 0, worldRev: 0 }))

vi.mock('../value.ts', async (importOriginal) => {
  const o = (await importOriginal()) as Record<string, unknown>
  const inner = o.canonicalJson as (v: unknown) => string
  // 位置哈希吃固定字段小 map（at/seq/prev/op/argsHash/by/ref），按常数记账、不计入载荷规范化
  const positionMap = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const keys = Object.keys(v as Record<string, unknown>)
    const fixed = ['at', 'seq', 'prev', 'op', 'argsHash', 'by', 'ref']
    return keys.length > 0 && keys.every((k) => fixed.includes(k)) && keys.includes('argsHash')
  }
  // 内容身份吃 `{ keys, ids }`；按此形状计 worldRev 调用（不改载荷账）
  const revArg = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const keys = Object.keys(v as Record<string, unknown>)
    return keys.length === 2 && keys.includes('keys') && keys.includes('ids')
  }
  return {
    ...o,
    canonicalJson: (v: unknown): string => {
      if (positionMap(v)) stubs.entryHash += 1
      else {
        if (revArg(v)) stubs.worldRev += 1
        stubs.canon += 1
      }
      return inner(v)
    },
  }
})

import {
  EMPTY_WORLD,
  H,
  KernelError,
  cloneWorld,
  commit,
  entryHash,
  eval as evaluate,
  replay,
  run,
  validate,
  verify,
  worldRev,
} from '../index.ts'
import type {
  Def,
  Directive,
  Entry,
  Gen,
  Hash,
  Json,
  KernelInput,
  Op,
  World,
  WriteRequest,
} from '../index.ts'

type Head = Parameters<typeof commit>[0]
type TermT = Parameters<typeof evaluate>[0]
type EnvT = Parameters<typeof evaluate>[1]
const J = (v: unknown): Json => v as Json
const RUN_ID = 'run-gates'
const NOW = 4242
const GHOST = 'ab'.repeat(32)
const dRec = (body: Json): Json => ({ body })
const dKey = (body: Json): Hash => H(dRec(body))
const SCHEMA = dKey('schema')
const PAY = dKey('payload')
const SIG = dKey('sig')
const PAY_ALT = dKey('payload-alt')
const emptyHead = (): Head => ({ seq: -1, hash: null })
const req = (id: string, op: Op, args: Json, pos: Hash | null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest
const reqBy = (id: string, op: Op, args: Json, pos: Hash | null, by: string): WriteRequest => ({
  ...req(id, op, args, pos),
  by,
})
const snap = (x: unknown): string => JSON.stringify(x)
const sub = (op: Op, args: Json): Json => J({ op, args })

function link(head: Head, world: World, r: WriteRequest): Head {
  const o = commit(head, world, r, NOW)
  if (!o.verdict.ok || o.entry === null) throw new Error('seed refused: ' + o.verdict.reasons)
  return { seq: o.entry.seq, hash: o.hash as Hash }
}
function worldWith(...defs: Json[]): World {
  const w = cloneWorld(EMPTY_WORLD)
  for (const d of defs) w.defs[H(d)] = d as unknown as Def
  return w
}
/** 身份 x：gen0（payload=PAY、pins.p=SIG、sig=SIG）已激活。 */
function seeded(): { world: World; head: Head } {
  const world = worldWith(dRec('schema'), dRec('payload'), dRec('sig'), dRec('payload-alt'))
  let head = emptyHead()
  head = link(head, world, req('ident', 'add_identity', J({ id: 'x', schema: SCHEMA }), head.hash))
  return {
    world,
    head: link(
      head,
      world,
      req('gen-a', 'add_gen', J({ id: 'x', payload: PAY, pins: { p: SIG }, sig: SIG }), head.hash),
    ),
  }
}
function input(over: Partial<KernelInput> = {}): KernelInput {
  return {
    world: cloneWorld(EMPTY_WORLD),
    head: emptyHead(),
    run: RUN_ID,
    directives: [],
    results: {},
    limits: { gas: 5_000, depth: 16 },
    caps: { fs: true, net: false },
    now: NOW,
    ...over,
  } as unknown as KernelInput
}

const SRC_DIR = decodeURIComponent(
  (import.meta as unknown as { url: string }).url.replace(/^file:\/\/\//, ''),
).replace(/\/test\/[^/]*$/, '/')
const RUNTIME_FILES =
  'index.ts types.ts value.ts hash.ts defs.ts patch.ts rebase.ts journal.ts journal.apply.ts ' +
  'commit.ts machine.ts machine.eval.ts recycle.ts run.ts'
function runtimeSources(): [string, string][] {
  return (readdirSync(SRC_DIR) as string[])
    .filter(
      (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.config.ts'),
    )
    .map((f: string) => [f, String(readFileSync(SRC_DIR + f, 'utf8'))])
}

afterEach(() => {
  stubs.canon = 0
  stubs.entryHash = 0
  stubs.worldRev = 0
})

describe('唯一写口静态扫描：对既有世界的改动只落在 journal.apply.ts', () => {
  // 收对既有世界的成员写入（w.defs[…] = / w.ids[…] =）与 delete；
  // cloneWorld 对新建本地表逐键初始化不算写世界。
  const WRITE_RE = /\w\.(?:defs|ids)\[[^\]]*\]\s*=(?!=)/g
  const DEL_RE = /delete\s+(?:[\w.]+\.)?(?:defs|ids)\[/g
  it('成员写入与 delete 只出现在 journal.apply.ts，且 commit.ts 连裸式都没有', () => {
    const hits: string[] = []
    let applyHits = 0
    const sources = runtimeSources()
    for (const [f, src] of sources) {
      const w = (src.match(WRITE_RE) ?? []).length + (src.match(DEL_RE) ?? []).length
      if (w > 0) hits.push(f)
      if (f === 'journal.apply.ts') applyHits = w
    }
    expect(hits).toEqual(['journal.apply.ts'])
    expect(applyHits).toBeGreaterThanOrEqual(5) // 自证：规则抓得住现有写入与回滚删除
    const names = sources.map(([f]) => f)
    expect(RUNTIME_FILES.split(' ').every((f) => names.includes(f))).toBe(true) // 扫描确有覆盖
    const src = readFileSync(SRC_DIR + 'commit.ts', 'utf8')
    expect(src.match(/(?:defs|ids)\[[^\]]*\]\s*=(?!=)/g)).toBeNull() // 裸式或成员式的赋值
    expect(src.match(/delete\s+(?:[\w.]+\.)?(?:defs|ids)\[/g)).toBeNull() // 或删除
  })
})

describe('引用完整性：内核认识字段里的缺引用一律 missing_ref 拒绝', () => {
  function expectRefRejected(build: () => [World, Head, WriteRequest]): void {
    const [world, head, r] = build()
    const before = [snap(world), worldRev(world), snap(head)]
    expect(validate(head, world, r).reasons).toEqual(['missing_ref'])
    const { verdict: v, entry, hash } = commit(head, world, r, NOW)
    expect([v.ok, v.reasons, entry, hash]).toEqual([false, ['missing_ref'], null, null])
    expect(v.pos).toBe(head.hash)
    expect([snap(world), worldRev(world), snap(head)]).toEqual(before) // 世界与 head 分文未动
  }
  type RefCase = () => [World, Head, WriteRequest]
  const onBare =
    (op: Op, args: Json): RefCase =>
    () => [worldWith(), emptyHead(), req('ghost-field', op, args, null)]
  const onSeeded =
    (op: Op, args: Json): RefCase =>
    () => {
      const s = seeded()
      return [s.world, s.head, req('ghost-field', op, args, s.head.hash)]
    }
  const onGhostRef = (): [World, Head, WriteRequest] => {
    const s = seeded()
    return [s.world, s.head, { ...req('ghost-ref', 'note', J({}), s.head.hash), ref: GHOST }]
  }
  const cases: [string, RefCase][] = [
    ['add_identity.schema', onBare('add_identity', J({ id: 'q', schema: GHOST }))],
    ['fork.schema', onSeeded('fork', J({ id: 'y', schema: GHOST, parent: 'x' }))],
    ['add_gen.payload', onSeeded('add_gen', J({ id: 'x', payload: GHOST, pins: {}, sig: SIG }))],
    ['add_gen.sig', onSeeded('add_gen', J({ id: 'x', payload: PAY, pins: {}, sig: GHOST }))],
    [
      'add_gen.pins.*',
      onSeeded('add_gen', J({ id: 'x', payload: PAY, pins: { p: GHOST }, sig: SIG })),
    ],
    [
      'graft.payload',
      onSeeded('graft', J({ id: 'x', payload: GHOST, pins: {}, sig: SIG, from: 'x', gen: 0 })),
    ],
    ['put.args.sig', onBare('put', J({ body: 'probe', sig: GHOST }))],
    ['put.args.pins.*', onBare('put', J({ body: 'probe', pins: { b: GHOST } }))],
    ['request.ref', onGhostRef],
  ]
  it.each(cases)('%s 缺引用：args 其余字段全合法也拒', (_name, build) => expectRefRejected(build))
})

describe('能力来自输入：嵌套效果的挂起请求照抄输入能力表', () => {
  it('call 嵌套的 eff 挂起：pending.caps 与输入 caps 相等的键值集合', () => {
    const innerBody = J(['eff', 'p', 'read', ['c', 'deep']])
    const outerBody = J(['call', ['c', dKey(innerBody)], [['c', 1]]])
    const o = run(
      input({
        world: worldWith(dRec(innerBody), dRec(outerBody)),
        directives: [{ kind: 'eval', entry: dKey(outerBody), args: J(null), ctx: J(null) }],
      }),
    )
    expect([o.status, o.pending?.caps]).toEqual(['waiting', { fs: true, net: false }])
    expect(o.pending?.args).toBe('deep')
  })
  it('fold 每轮一枚 eff：回灌后下一轮 pending.caps 仍等于输入', () => {
    const stepBody = J(['eff', 'p', 'tick', ['c', 'x']])
    const foldBody = J(['fold', ['c', [1, 2]], ['c', 0], ['c', dKey(stepBody)]])
    const foldKey = dKey(foldBody)
    const s = worldWith(dRec(stepBody), dRec(foldBody))
    const mk = (results: KernelInput['results']): KernelInput =>
      input({
        world: s,
        directives: [{ kind: 'eval', entry: foldKey, args: J(null), ctx: J(null) }],
        results,
      })
    const first = run(mk({}))
    expect([first.status, first.pending?.caps]).toEqual(['waiting', { fs: true, net: false }])
    const firstRoundId = H(J({ run: RUN_ID, i: 0, n: 0 }))
    const second = run(mk({ [firstRoundId]: { ok: true, value: 7 } }))
    expect([second.status, second.pending?.caps, second.pending?.id]).toEqual([
      'waiting',
      { fs: true, net: false },
      H(J({ run: RUN_ID, i: 0, n: 1 })),
    ])
  })
})

describe('worldRev 覆盖语义：吃内容与 active、不吃履历、按需计算', () => {
  it('写入一字之差的两个 body：worldRev 必变', () => {
    const world = worldWith()
    let head = emptyHead()
    head = link(head, world, req('near-a', 'put', dRec('alpha'), head.hash))
    const revA = worldRev(world)
    link(head, world, req('near-b', 'put', dRec('alphb'), head.hash))
    expect([worldRev(world) === revA, Object.keys(world.defs).length]).toEqual([false, 2])
  })
  it('born / adopted 履历不同而内容与 active 相同：两世界 worldRev 相等', () => {
    const trio = (): World => worldWith(dRec('schema'), dRec('payload'), dRec('sig'))
    const genArgs = J({ id: 'x', payload: PAY, pins: { p: SIG }, sig: SIG })
    const direct = trio()
    let h = emptyHead()
    h = link(
      h,
      direct,
      reqBy('one-id', 'add_identity', J({ id: 'x', schema: SCHEMA }), h.hash, 'one'),
    )
    link(h, direct, reqBy('one-gen', 'add_gen', genArgs, h.hash, 'one'))
    const viaBatch = trio()
    const ops = J({
      ops: [sub('add_identity', J({ id: 'x', schema: SCHEMA })), sub('add_gen', genArgs)],
    })
    const o = commit(emptyHead(), viaBatch, reqBy('two-batch', 'batch', ops, null, 'two'), NOW)
    expect(o.verdict.ok).toBe(true)
    expect(snap(viaBatch)).not.toBe(snap(direct)) // 履历（位置与签名者）确实不同
    expect([worldRev(viaBatch), viaBatch.ids['x'].active, direct.ids['x'].active]).toEqual([
      worldRev(direct),
      PAY,
      PAY,
    ])
  })
  it('普通单 op 写入过程不触发 worldRev；显式取身份与 snapshot 各按需算一次', () => {
    const { world, head } = seeded()
    stubs.worldRev = 0
    link(head, world, req('watch-note', 'note', J({}), head.hash))
    link(head, world, req('retire-x', 'retire', J({ id: 'x' }), head.hash))
    expect(stubs.worldRev).toBe(0) // 正常写入链条不在每条 entry 上算内容身份
    const rev = worldRev(world)
    expect([stubs.worldRev, rev.length]).toEqual([1, 64])
    const o = commit(head, world, req('snap', 'snapshot', J({ world_rev: rev }), head.hash), NOW)
    expect([o.verdict.ok, stubs.worldRev]).toEqual([true, 2]) // snapshot 恰好再按需算一次
  })
  it('链路校验默认不碰内容身份；带段末锚点时恰核对一次', () => {
    const world = worldWith()
    let head = emptyHead()
    const list: Entry[] = []
    for (const id of ['nv-a', 'nv-b']) {
      const o = commit(head, world, req(id, 'note', J({}), head.hash), NOW)
      list.push(o.entry as Entry)
      head = { seq: (o.entry as Entry).seq, hash: o.hash as Hash }
    }
    stubs.worldRev = 0
    expect(verify(list, { world, head: emptyHead() })).toEqual({ ok: true })
    expect(stubs.worldRev).toBe(0) // 链校验自身不算内容身份
    const rev = worldRev(world)
    expect(verify(list, { world, head: emptyHead() }, { worldRev: rev })).toEqual({ ok: true })
    expect(stubs.worldRev).toBe(2) // 显式取身份 1 次 + 校验器段末核对 1 次
  })
})

describe('批量原子性：中途失败整批回滚，世界逐字节不动', () => {
  it('batch 第三个子操作撞已有 id：commit 转拒，键集与指纹双双不变', () => {
    const { world, head } = seeded()
    const before = [snap(world), worldRev(world)]
    const ops = J({
      ops: [
        sub('put', dRec('atomic-a')),
        sub('add_identity', J({ id: 'fresh', schema: SCHEMA })),
        sub('add_identity', J({ id: 'x', schema: SCHEMA })),
      ],
    })
    const o = commit(head, world, req('clash', 'batch', ops, head.hash), NOW)
    expect([o.verdict.ok, o.verdict.reasons, o.verdict.pos]).toEqual([
      false,
      ['id_taken'],
      head.hash,
    ])
    expect([o.entry, o.hash]).toEqual([null, null])
    expect([snap(world), worldRev(world)]).toEqual(before)
    expect(Object.keys(world.ids)).toEqual(['x']) // 前两个子操作的新键一个都没旁落
  })
  it('子批已应用后外层再撞既有 id：子批写入也被逆序还原', () => {
    const { world, head } = seeded()
    const before = [snap(world), worldRev(world)]
    const inner = J({
      op: 'batch',
      args: J({ ops: [sub('put', dRec('deep-put')), sub('retire', J({ id: 'x' }))] }),
    })
    const ops = J({ ops: [inner, sub('add_identity', J({ id: 'x', schema: SCHEMA }))] })
    const o = commit(head, world, req('nest-clash', 'batch', ops, head.hash), NOW)
    expect([o.verdict.ok, o.verdict.reasons, o.entry === null]).toEqual([false, ['id_taken'], true])
    expect([snap(world), worldRev(world)]).toEqual(before)
  })
})

describe('哈希预算：载荷只规范化一次，位置哈希 O(1)', () => {
  it('put 提交：载荷哈希恰一次', () => {
    stubs.canon = 0
    commit(emptyHead(), worldWith(), req('one-put', 'put', dRec('once-only'), null), NOW)
    expect(stubs.canon).toBe(1)
  })
  it('非 put 单 op 提交：载荷哈希一次即足；snapshot 带上内容身份也不超过两次', () => {
    const cases: [Op, Json][] = [
      ['note', J({})],
      ['add_identity', J({ id: 'solo', schema: SCHEMA })],
      ['add_gen', J({ id: 'x', payload: PAY_ALT, pins: {}, sig: SIG })],
      ['set_active', J({ id: 'x', active: PAY })],
      ['retire', J({ id: 'x' })],
      ['fork', J({ id: 'y', schema: SCHEMA, parent: 'x' })],
      ['graft', J({ id: 'x', payload: PAY, pins: {}, sig: SIG, from: 'x', gen: 0 })],
    ]
    for (const [op, args] of cases) {
      const { world, head } = seeded()
      stubs.canon = 0
      commit(head, world, req('per-op', op, args, head.hash), NOW)
      expect(op + ':' + stubs.canon).toBe(op + ':1')
    }
    const { world, head } = seeded()
    const rev = worldRev(world)
    stubs.canon = 0
    commit(head, world, req('snap-budget', 'snapshot', J({ world_rev: rev }), head.hash), NOW)
    expect(stubs.canon).toBeLessThanOrEqual(2) // args 一次 + 内容身份按需一次
  })
  it('batch：预哈希趟与应用趟各一、聚合按子操作数——载荷哈希 ≤ 2·子操作数 + 2', () => {
    const { world, head } = seeded()
    const children = [
      sub('put', dRec('budget-a')),
      sub('note', J({})),
      sub('put', dRec('budget-b')),
    ]
    stubs.canon = 0
    commit(head, world, req('budget', 'batch', J({ ops: children }), head.hash), NOW)
    expect(stubs.canon).toBeLessThanOrEqual(children.length * 2 + 2)
    expect(stubs.canon).toBeGreaterThan(children.length) // 两趟确实各算了一次子载荷
  })
  it('entryHash 不读 args：篡改 args 而 argsHash 不动则位置哈希不变', () => {
    const o = commit(emptyHead(), worldWith(), req('eh', 'put', dRec('tamper-me'), null), NOW)
    const e = o.entry as Entry
    const before = entryHash(e)
    ;(e.args as { body: Json }).body = 'tampered'
    expect(entryHash(e)).toBe(before)
  })
  it('verify 对每条 entry 恰调用一次位置哈希', () => {
    const world = worldWith()
    let head = emptyHead()
    const list: Entry[] = []
    for (const id of ['vk-a', 'vk-b', 'vk-c']) {
      const o = commit(head, world, req(id, 'note', J({}), head.hash), NOW)
      list.push(o.entry as Entry)
      head = { seq: (o.entry as Entry).seq, hash: o.hash as Hash }
    }
    stubs.entryHash = 0
    expect(verify(list, { world: cloneWorld(EMPTY_WORLD), head: emptyHead() })).toEqual({
      ok: true,
    })
    expect(stubs.entryHash).toBe(list.length)
  })
})

describe('终止性：固定种子随机 term 全部三态返回', () => {
  const SEED = 20_260_916 // 写死的固定种子
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const LEAVES = [J(1), J('s'), J(true), J(null), J([]), J({}), J([1, { a: 2 }]), J(1.25), J(0)]
  function pick<T>(xs: T[], rnd: () => number): T {
    return xs[Math.floor(rnd() * xs.length)]
  }
  function rndTerm(rnd: () => number, budget: number, hashes: Hash[]): TermT {
    if (budget <= 0) return ['c', pick(LEAVES, rnd)] as TermT
    const sub = (): TermT => rndTerm(rnd, budget - 1, hashes)
    switch (
      pick(
        [
          'c',
          'v',
          'g',
          'get',
          'getOr',
          'cmp',
          'pred',
          'if',
          'fold',
          'eff',
          'call',
          'arith',
          'list',
          'obj',
          'let',
          'zz',
        ],
        rnd,
      )
    ) {
      case 'c':
        return ['c', pick(LEAVES, rnd)] as TermT
      case 'v':
        return ['v', pick([0, 1, -1, 2, 2.5, J('a')], rnd) as Json] as TermT
      case 'g':
        return ['g', pick([[], ['a'], ['a', 1], [0], ['nope'], 'bad'], rnd) as Json] as TermT
      case 'get':
        return ['get', sub(), pick([[], ['a'], ['a', 0], ['nope'], 'bad'], rnd) as Json] as TermT
      case 'getOr':
        return [
          'getOr',
          sub(),
          pick([[], ['a'], ['a', 0], ['nope'], 'bad'], rnd) as Json,
          sub(),
        ] as TermT
      case 'cmp':
        return ['cmp', sub(), sub()] as TermT
      case 'pred':
        return [
          'pred',
          pick(['lt', 'le', 'gt', 'ge', 'eq', 'ne', 'zz'], rnd),
          sub(),
          sub(),
        ] as TermT
      case 'if':
        return ['if', sub(), sub(), sub()] as TermT
      case 'fold':
        return ['fold', sub(), sub(), sub()] as TermT
      case 'eff':
        return ['eff', pick(['p', 'fs'], rnd), pick(['read'], rnd), sub()] as TermT
      case 'call':
        return ['call', sub(), pick([[sub()], [sub(), sub()], J('not-list')], rnd)] as TermT
      case 'arith':
        return ['arith', pick(['add', 'sub', 'mul', 'div', 'zz'], rnd), sub(), sub()] as TermT
      case 'list':
        return ['list', pick([[sub()], [sub(), sub()], J('not-list')], rnd)] as TermT
      case 'obj':
        return ['obj', pick([{ a: sub() }, { b: sub(), c: sub() }, J('not-record')], rnd)] as TermT
      default:
        return [pick(['let', 'zz', 'C', ''], rnd), 1] as unknown as TermT
    }
  }
  function termEnv(k: number, defs: Record<Hash, Def>): EnvT {
    const base = { ctx: J({ a: [1, { b: 2 }] }), defs, caps: J({ fs: true }) }
    return {
      ...base,
      args: [J(k), J('x'), J(null)],
      results: {},
      limits: { gas: 400, depth: 6 },
      run: 'term-run',
      i: k,
      n: 0,
      gas: 400,
      depth: 0,
      peakDepth: 0,
    } as unknown as EnvT
  }
  it('1000 个 term（正常形态与畸形混合）逐一求值：三态收口、无抛错', () => {
    const defs: Record<Hash, Def> = {}
    for (const body of [
      ['c', 1],
      ['v', 0],
      ['eff', 'p', 'm', ['c', 1]],
      ['if', ['c', true], ['c', 1], ['c', 2]],
    ]) {
      defs[dKey(J(body))] = dRec(J(body)) as unknown as Def
    }
    const hashes = Object.keys(defs) as Hash[]
    const rnd = mulberry32(SEED)
    let ok = 0
    let err = 0
    let susp = 0
    for (let k = 0; k < 1000; k++) {
      const r = evaluate(rndTerm(rnd, 3 + (k % 2), hashes), termEnv(k, defs))
      if ('suspend' in r) susp += 1
      else if (r.ok) ok += 1
      else {
        expect(typeof r.error).toBe('string')
        err += 1
      }
    }
    expect([ok + err + susp, ok > 0, err > 0, susp > 0]).toEqual([1000, true, true, true])
  })
})

describe('无审核词表静态扫描：内核运行时文件零审核概念', () => {
  const AUDIT_RE = /\b(?:criteria|approve|level|review|policy)\b/ // 词边界、大小写敏感
  it('逐文件扫描五个审核词零命中，且扫描确有覆盖', () => {
    const offenders: string[] = []
    const files = runtimeSources()
    for (const [f, src] of files) if (AUDIT_RE.test(src)) offenders.push(f)
    expect(offenders).toEqual([])
    expect(files.length).toBe(RUNTIME_FILES.split(' ').length)
  })
})

describe('深度护栏：递归 JSON 遍历超限一律收成 depth（无 RangeError 穿出）', () => {
  function nestJson(levels: number, leaf: Json): Json {
    let v = leaf
    for (let i = 0; i < levels; i++) v = [v]
    return v
  }
  const DEEP = nestJson(100_000, 0)
  const reasonsOf = (o: { observations: Json[] }): string[] | undefined =>
    (o.observations[o.observations.length - 1] as { reasons?: string[] }).reasons

  it('put：写请求 args 深嵌套 → refused depth', () => {
    const r = req('deep-put', 'put', dRec(DEEP), null)
    const o = run(input({ directives: [{ kind: 'write', request: r } as Directive] }))
    expect([o.status, reasonsOf(o)]).toEqual(['refused', ['depth']])
  })

  it('batch：子操作 args 深嵌套（段 1 substitute）→ refused depth', () => {
    const ops = J({ ops: [sub('put', dRec(DEEP))] })
    const r = req('deep-batch', 'batch', ops, null)
    const o = run(input({ directives: [{ kind: 'write', request: r } as Directive] }))
    expect([o.status, reasonsOf(o)]).toEqual(['refused', ['depth']])
  })

  it('replay：深嵌套 args 的 entry → KernelError depth（非 RangeError）', () => {
    const e: Entry = {
      seq: 0,
      prev: null,
      op: 'put',
      args: dRec(DEEP),
      argsHash: 'x',
      by: 't',
      at: NOW,
    }
    let caught: unknown
    try {
      replay([e])
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(KernelError)
    expect((caught as KernelError).code).toBe('depth')
  })

  it('verify：深嵌套 args 的 entry → 返回码 depth（verify 自身不抛）', () => {
    const e: Entry = {
      seq: 0,
      prev: null,
      op: 'put',
      args: dRec(DEEP),
      argsHash: 'x',
      by: 't',
      at: NOW,
    }
    expect(verify([e], { world: cloneWorld(EMPTY_WORLD), head: emptyHead() })).toEqual({
      ok: false,
      error: 'depth',
    })
  })
})

describe('批量原子性：段 2 非四态异常也回滚，包成 internal 且保留原因链', () => {
  const S = H({ body: 'schema' })
  const SIG = H({ body: 'sig' })
  const PAY = H({ body: 'payload' })
  const WRITE0 = 'f'.repeat(64)

  /** 身份 x 的 gen0 payload=PAY，但 defs 里 PAY 的值为 undefined：读 body 时抛 TypeError。 */
  function brokenWorld(): World {
    const gen0: Gen = {
      seq: 0,
      payload: S,
      pins: {},
      sig: S,
      adopted: { at: 1, by: 't', write: WRITE0 },
    }
    return {
      defs: { [S]: { body: {} }, [SIG]: { body: {} }, [PAY]: undefined as unknown as Def },
      ids: { x: { id: 'x', schema: S, gens: [gen0], active: S, born: { at: 1, by: 't' } } },
    }
  }

  it('段 2 中途抛非 KernelError：已应用子操作回滚，世界逐字节不变，cause 保留', () => {
    const world = brokenWorld()
    const head: Head = { seq: 0, hash: WRITE0 }
    const before = snap(world)
    const ops = J({
      ops: [
        sub('put', dRec('rolled')),
        sub('add_gen', J({ id: 'x', payload: PAY, pins: {}, sig: SIG, base: 0 })),
      ],
    })
    let caught: unknown
    try {
      commit(head, world, req('atomic-internal', 'batch', ops, head.hash), NOW)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(KernelError)
    expect((caught as KernelError).code).toBe('internal')
    expect((caught as KernelError).cause).toBeInstanceOf(TypeError)
    expect(snap(world)).toBe(before)
    expect(world.defs[H({ body: 'rolled' })]).toBeUndefined()
  })

  it('单 op 应用期 KernelError：世界逐字节不变', () => {
    const { world, head } = seeded()
    const before = snap(world)
    expect(() =>
      commit(head, world, req('bad-snap', 'snapshot', J({ world_rev: GHOST }), head.hash), NOW),
    ).toThrowError('world_rev_mismatch')
    expect(() =>
      commit(
        head,
        world,
        req(
          'bad-base',
          'add_gen',
          J({ id: 'x', payload: PAY, pins: {}, sig: SIG, base: 9 }),
          head.hash,
        ),
        NOW,
      ),
    ).toThrowError('missing_parent')
    expect(snap(world)).toBe(before)
  })
})

describe('now 有限数门禁：非有限数在改世界之前拒绝', () => {
  const reasonsOf = (o: { observations: Json[] }): string[] | undefined =>
    (o.observations[o.observations.length - 1] as { reasons?: string[] }).reasons

  it('validate / commit：NaN / ±Infinity → bad_form，世界逐字节不变', () => {
    const { world, head } = seeded()
    const before = [snap(world), snap(head)]
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = req('now-bad', 'put', dRec('x'), head.hash)
      expect(validate(head, world, r, bad)).toMatchObject({ ok: false, reasons: ['bad_form'] })
      const o = commit(head, world, r, bad)
      expect([o.verdict.ok, o.verdict.reasons, o.entry, o.hash]).toEqual([
        false,
        ['bad_form'],
        null,
        null,
      ])
      expect([snap(world), snap(head)]).toEqual(before)
    }
  })

  it('run：now 非有限数 → refused bad_form，input 世界未动', () => {
    const { world, head } = seeded()
    const inp = input({
      world,
      head,
      now: Number.NaN,
      directives: [
        { kind: 'write', request: req('now-bad-run', 'put', dRec('y'), head.hash) } as Directive,
      ],
    })
    const before = snap(inp.world)
    const o = run(inp)
    expect([o.status, reasonsOf(o)]).toEqual(['refused', ['bad_form']])
    expect(snap(inp.world)).toBe(before)
  })
})
