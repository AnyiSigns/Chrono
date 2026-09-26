// run.ts 验收（全清单；分工只打公共面 ./index.ts）。
// 覆盖：四态各一例、waiting→回灌→done 与一次跑完逐字节一致、同输入幂等重跑、写失败世界未动、
// 幂等 put 不入 journal、prev 链可校验（在链校验用例顺带钉）、三态构造口径逐格、usage 公式、
// 观测与公共 observationsOf 对拍（run 不自己拼形状）、深但宽不误触 depth。
// 注：observationsOf 与 run 同模块、内部是闭包直调，vi.mock 拦不到自调用——“模块 mock
// 断言”以【公共面对拍等价】落实：同 (d, outcome) 下 run 的观测恒 === observationsOf 的产出。
import { describe, expect, it } from 'vitest'
import {
  H,
  EMPTY_WORLD,
  cloneWorld,
  commit,
  entryHash,
  eval as evaluate,
  observationsOf,
  run,
  verify,
} from '../index.ts'
import type { Directive, Hash, Json, KernelInput, World, WriteRequest } from '../index.ts'

const J = (v: unknown): Json => v as Json
type Head = Parameters<typeof commit>[0]
type EnvT = Parameters<typeof evaluate>[1]
type OutEval = Extract<Parameters<typeof observationsOf>[1], { kind: 'eval' }>
const NOW = 2_000_000
const RUN = 'run-A'
const CAPS = { fs: true, net: false }
const dRec = (body: Json): Record<string, Json> => ({ body })
const dKey = (body: Json): Hash => H(dRec(body))
const req = (id: string, op: string, args: Json, pos: Hash | null): WriteRequest =>
  ({ id, op, target: { expect_pos: pos }, args, by: 'tester' }) as unknown as WriteRequest

/** commit 播种一批 def：同一请求序列 ⇒ 同一 { world, head, keys }（重跑一致性在此即测）。 */
function seedDefs(bodies: Json[]): { world: World; head: Head; keys: Hash[] } {
  const world = cloneWorld(EMPTY_WORLD)
  let head: Head = { seq: -1, hash: null }
  const keys: Hash[] = []
  for (const body of bodies) {
    const o = commit(head, world, req('seed-' + keys.length, 'put', dRec(body), head.hash), NOW)
    if (!o.verdict.ok || o.entry === null || o.hash === null) throw new Error('seed refused')
    head = { seq: o.entry.seq, hash: o.hash }
    keys.push(dKey(body))
  }
  return { world, head, keys }
}
const seedDef = (body: Json): { world: World; head: Head; key: Hash } => {
  const s = seedDefs([body])
  return { world: s.world, head: s.head, key: s.keys[0] }
}

function input(over: Partial<KernelInput> = {}): KernelInput {
  return {
    world: cloneWorld(EMPTY_WORLD),
    head: { seq: -1, hash: null },
    run: RUN,
    directives: [],
    results: {},
    limits: { gas: 10_000, depth: 16 },
    caps: CAPS,
    now: NOW,
    ...over,
  } as unknown as KernelInput
}
const outH = (o: object): string => H(J(o))
const writeDir = (id: string, op: string, args: Json, pos: Hash | null): Directive =>
  ({ kind: 'write', request: req(id, op, args, pos) }) as Directive
const evalDir = (entry: Hash, args: Json = null): Directive =>
  ({ kind: 'eval', entry, args, ctx: null }) as Directive
const externDir = (payload: Json): Directive => ({ kind: 'extern', payload }) as Directive
const lastObs = (o: { observations: Json[] }): Json => o.observations[o.observations.length - 1]
const reasonsOf = (o: { observations: Json[] }): string[] | undefined =>
  (lastObs(o) as { reasons?: string[] }).reasons
const effId = (i: number, n: number): Hash => H({ run: RUN, i, n } as unknown as Json)

describe('四态各一例（含空 directives → idle）', () => {
  it('idle：world/head === input（引用级）、journal/pending/observations 全空、usage 全 0', () => {
    const s = seedDef('base')
    const inp = input({ world: s.world, head: s.head })
    const o = run(inp)
    expect(o.status).toBe('idle')
    expect(o.world).toBe(inp.world)
    expect(o.head).toBe(inp.head)
    expect([o.journal, o.pending, o.observations, o.usage]).toEqual([
      [],
      null,
      [],
      { gas: 0, depth: 0 },
    ])
  })
  it('done：extern——world 为克隆体且 input 未回写、观测 === observationsOf 产出、usage 全 0', () => {
    const d = externDir({ hello: 1 })
    const inp = input({ directives: [d] })
    const o = run(inp)
    expect(o.status).toBe('done')
    expect(o.world).not.toBe(inp.world)
    expect(JSON.stringify(inp.world)).toBe(JSON.stringify({ defs: {}, ids: {} })) // 入口原样
    expect([o.journal, o.head, o.pending, o.usage]).toEqual([
      [],
      inp.head,
      null,
      { gas: 0, depth: 0 },
    ])
    expect(o.observations).toEqual([observationsOf(d, { kind: 'extern' }) as Json])
  })
  it('waiting：未解析 eff——pending=该效果、挂起那条不产观测、world/head === input', () => {
    const s = seedDef(['eff', 'fs', 'read', ['c', 7]])
    const inp = input({ world: s.world, head: s.head, directives: [evalDir(s.key)] })
    const o = run(inp)
    expect(o.status).toBe('waiting')
    expect([o.world === inp.world, o.head === inp.head, o.journal]).toEqual([true, true, []])
    expect(o.pending).toEqual({ id: effId(0, 0), port: 'fs', method: 'read', args: 7, caps: CAPS })
    expect(o.observations).toEqual([]) // 挂起的观测产出为 null，不入流
    expect(o.usage.gas).toBe(2) // ['eff',…] + ['c',7] 两节点
  })
  it('refused：eval missing_ref——前缀观测保留 + 末尾 {kind:refused,reasons}、世界未动', () => {
    const s = seedDef('keep')
    const good = externDir(1)
    const inp = input({
      world: s.world,
      head: s.head,
      directives: [good, evalDir('cd'.repeat(32))],
    })
    const before = JSON.stringify(inp.world)
    const o = run(inp)
    expect(o.status).toBe('refused')
    expect([o.world === inp.world, o.head === inp.head, o.journal, o.pending]).toEqual([
      true,
      true,
      [],
      null,
    ])
    expect(JSON.stringify(inp.world)).toBe(before) // 任一校验失败：整次作废、世界未动
    expect(o.observations.length).toBe(2)
    expect(o.observations[0]).toEqual(observationsOf(good, { kind: 'extern' }) as Json)
    expect(lastObs(o)).toEqual(
      observationsOf(null, { kind: 'refused', reasons: ['missing_ref'] }) as Json,
    )
    expect(reasonsOf(o)).toEqual(['missing_ref'])
  })
})

describe('续跑闭环、同输入重跑幂等与幂等 put 不追加', () => {
  const s = seedDef(['eff', 'fs', 'read', ['c', 'q']])
  const mk = (results: KernelInput['results']): KernelInput =>
    input({
      world: cloneWorld(s.world),
      head: s.head,
      directives: [evalDir(s.key), externDir('tail')],
      results,
    })
  it('waiting → 回灌 → done 全链；与一次跑完逐字节一致（含 head/observations/usage）', () => {
    const r1 = run(mk({}))
    expect(r1.status).toBe('waiting')
    const id = (r1.pending as { id: Hash }).id
    expect([id, JSON.stringify(r1.world)]).toEqual([
      effId(0, 0),
      JSON.stringify(cloneWorld(s.world)),
    ])
    const fed = { [id]: { ok: true, value: 'v' } } as KernelInput['results']
    const r2 = run(mk(fed)) // 续跑=同一 run_id、同一份完整 directives、同一 now 的重调
    const one = run(mk(fed)) // 一次跑完
    expect(r2.status).toBe('done')
    expect([H(J(r2.world)), JSON.stringify(r2.journal), H(J(r2.head))]).toEqual([
      H(J(one.world)),
      JSON.stringify(one.journal),
      H(J(one.head)),
    ])
    expect(outH(r2)).toBe(outH(one)) // 整体（observations/usage 在内）逐字节一致
    expect(r2.observations).toEqual(one.observations)
    expect(lastObs(r2)).toEqual(observationsOf(externDir('tail'), { kind: 'extern' }) as Json)
  })
  it('同输入重跑幂等：world/journal/head（及观测流）逐字节一致', () => {
    const b = seedDef('fresh-base')
    const freshWrite = writeDir('a', 'put', dRec('fresh'), b.head.hash)
    const makeFresh = (): KernelInput =>
      input({ world: cloneWorld(b.world), head: b.head, directives: [freshWrite, externDir(2)] })
    const firstRun = run(makeFresh())
    const secondRun = run(makeFresh())
    expect([firstRun.status, secondRun.status]).toEqual(['done', 'done'])
    expect(H(J(firstRun.world))).toBe(H(J(secondRun.world)))
    expect(JSON.stringify(firstRun.journal)).toBe(JSON.stringify(secondRun.journal))
    expect(H(J(firstRun.head))).toBe(H(J(secondRun.head)))
    expect(JSON.stringify(firstRun.observations)).toBe(JSON.stringify(secondRun.observations))
  })
  it('幂等 put：journal 不追加、head 不动、观测挂 dup:true 且 pos = 未变 head', () => {
    const s = seedDef('already')
    const r = req('d', 'put', dRec('already'), s.head.hash)
    const d = writeDir('d', 'put', dRec('already'), s.head.hash)
    const o = run(input({ world: s.world, head: s.head, directives: [d] }))
    const co = commit(s.head, cloneWorld(s.world), r, NOW) // 独立重放同一请求 → 同一判决
    expect([o.status, o.journal.length, o.head]).toEqual(['done', 0, s.head])
    expect(co.verdict.reasons).toEqual(['dup'])
    expect(lastObs(o)).toEqual(
      observationsOf(d, { kind: 'write', o: co, pos: s.head.hash } as never) as Json,
    )
    expect((lastObs(o) as { dup?: boolean }).dup).toBe(true)
  })
})

describe('链校验、mkEnv 可见性与 usage 公式（顺带钉）', () => {
  it('run 的 journal：prev/seq 逐条接得上、head = 末条位置、verify 公共面全过', () => {
    const s = seedDef('before')
    const w = cloneWorld(s.world)
    let shadow = s.head
    const reqs: WriteRequest[] = []
    for (const id of ['link-a', 'link-b']) {
      const r = req(id, 'put', dRec(id), shadow.hash)
      const o = commit(shadow, w, r, NOW)
      if (o.entry === null) throw new Error('shadow refused')
      shadow = { seq: o.entry.seq, hash: o.hash as Hash }
      reqs.push(r)
    }
    const o = run(
      input({
        world: s.world,
        head: s.head,
        limits: { gas: 100, depth: 8 },
        directives: reqs.map((r) => ({ kind: 'write', request: r }) as Directive),
      }),
    )
    expect(o.status).toBe('done')
    expect(o.journal.length).toBe(2)
    expect([o.journal[0].prev, o.journal[0].seq]).toEqual([s.head.hash, s.head.seq + 1])
    expect([o.journal[1].prev, o.journal[1].seq]).toEqual([entryHash(o.journal[0]), s.head.seq + 2])
    expect(o.head).toEqual({ seq: o.journal[1].seq, hash: entryHash(o.journal[1]) })
    expect(
      verify(o.journal, { world: s.world, head: s.head }, { hashes: o.journal.map(entryHash) }),
    ).toEqual({ ok: true })
    expect(o.journal[1].argsHash).toBe(H(dRec('link-b')))
  })
  it('eval 写请求失败：pos_conflict → refused、前后 head 与世界逐字节未动', () => {
    const s = seedDef('first-payload')
    const inp = input({
      world: s.world,
      head: s.head,
      directives: [writeDir('x', 'put', dRec('first-payload'), null)],
    })
    const before = [JSON.stringify(inp.world), JSON.stringify(inp.head)]
    const o = run(inp) // expect_pos = null ≠ head.hash → pos_conflict
    expect([o.status, reasonsOf(o), o.journal.length]).toEqual(['refused', ['pos_conflict'], 0])
    expect([JSON.stringify(inp.world), JSON.stringify(inp.head)]).toEqual(before)
  })
  it('mkEnv defs 取当前世界：同一次调用里前面的 put，后面的 eval 可见', () => {
    const key = dKey(['v', 0])
    const o = run(
      input({ directives: [writeDir('pw', 'put', dRec(['v', 0]), null), evalDir(key, 'seen')] }),
    )
    expect(o.status).toBe('done')
    expect((lastObs(o) as { value?: Json }).value).toBe('seen')
    expect(o.usage.gas).toBe(1) // 仅 ['v',0] 一个节点（前一条 put 不耗 eval gas）
    expect(o.journal.length).toBe(1)
  })
  it('usage 公式：gas = limits − 剩余、跨 directive 累计；refused(gas/depth) 零写入', () => {
    const inner = dKey(['v', 0])
    const s = seedDefs([
      ['v', 0],
      ['call', ['c', inner], [['c', 2]]],
    ])
    const h = s.keys[1]
    const base = { world: s.world, head: s.head }
    const two = (): KernelInput =>
      input({
        world: cloneWorld(base.world),
        head: base.head,
        directives: [evalDir(h), evalDir(h)],
        limits: { gas: 100, depth: 16 },
      })
    const full = run(two())
    expect(full.status).toBe('done')
    expect(full.usage).toEqual({ gas: 8, depth: 2 }) // 4 节点/条 × 2；depth 记峰值非收尾
    const wi = cloneWorld(base.world)
    const starve = run(
      input({
        world: wi,
        head: base.head,
        directives: [evalDir(h)],
        limits: { gas: 3, depth: 16 },
      }),
    )
    expect([starve.status, reasonsOf(starve), starve.usage.gas]).toEqual(['refused', ['gas'], 4])
    expect([H(J(starve.world)), starve.journal.length, starve.world === wi]).toEqual([
      H(J(wi)),
      0,
      true, // gas 耗尽：本次调用作废、世界未动
    ])
    const deep = run(
      input({
        world: cloneWorld(base.world),
        head: base.head,
        directives: [evalDir(h)],
        limits: { gas: 100, depth: 1 },
      }),
    )
    expect([deep.status, reasonsOf(deep), deep.journal.length]).toEqual(['refused', ['depth'], 0])
  })
  it('深但宽不误触：fold 4 轮 × 同深 step + call 兄弟节点，limits.depth 卡在峰值仍 done', () => {
    const stepKey = dKey(['v', 1])
    const leafKey = dKey(['v', 0])
    const foldBody = J(['fold', ['c', [1, 2, 3, 4]], ['c', 0], ['c', stepKey]])
    const callBody = J(['call', ['c', leafKey], [['v', 0]]])
    const s = seedDefs([J(['v', 1]), J(['v', 0]), foldBody, callBody])
    const o = run(
      input({
        world: s.world,
        head: s.head,
        directives: [evalDir(s.keys[2]), evalDir(s.keys[3], 'sib')],
        limits: { gas: 1000, depth: 2 },
      }),
    )
    expect(o.status).toBe('done') // finally 若不成对还原，第二轮 fold 即误触 depth
    expect([
      (o.observations[0] as { value?: Json }).value,
      (o.observations[1] as { value?: Json }).value,
    ]).toEqual([4, 'sib'])
    expect(o.usage).toEqual({ gas: 16, depth: 2 }) // fold 12 节点 + call 4 节点；峰值 2
  })
})

describe('观测形状 = observationsOf 公共面对拍（eval / bad_term / refused 尾）', () => {
  it('eval 成功观测与独立 evaluate + observationsOf 重算一致', () => {
    const s = seedDef(['v', 0])
    const d = evalDir(s.key, 'zz')
    const o = run(input({ world: s.world, head: s.head, directives: [d] }))
    const env = {
      ctx: null,
      args: ['zz'],
      defs: {},
      results: {},
      caps: CAPS,
      limits: { gas: 10_000, depth: 16 },
      run: RUN,
      i: 0,
      n: 0,
      gas: 10_000,
      depth: 0,
      peakDepth: 0,
    } as unknown as EnvT
    const r = evaluate(['v', 0] as Parameters<typeof evaluate>[0], env)
    expect(o.status).toBe('done')
    expect(lastObs(o)).toEqual(observationsOf(d, { kind: 'eval', r } as OutEval) as Json)
  })
  it('defs[entry].body 非 14 原语 → refused bad_term；回灌 ok:false → refused eff_error', () => {
    const sb = seedDef(['let', 1])
    const badTermInput = input({ world: sb.world, head: sb.head, directives: [evalDir(sb.key)] })
    const badTermRun = run(badTermInput)
    expect([
      badTermRun.status,
      reasonsOf(badTermRun),
      badTermRun.world === badTermInput.world,
      badTermRun.journal,
    ]).toEqual(['refused', ['bad_term'], true, []])
    const se = seedDef(['eff', 'p', 'm', ['c', 1]])
    const effErrInput = input({
      world: se.world,
      head: se.head,
      directives: [evalDir(se.key)],
      results: { [effId(0, 0)]: { ok: false } } as KernelInput['results'],
    })
    const effErrRun = run(effErrInput)
    expect([
      effErrRun.status,
      reasonsOf(effErrRun),
      effErrRun.world === effErrInput.world,
      effErrRun.journal.length,
    ]).toEqual(['refused', ['eff_error'], true, 0])
  })
  it('refused 的 reasons 只走 observations（KernelOutput 不另设字段）', () => {
    const o = run(input({ directives: [evalDir('ab'.repeat(32))] }))
    expect(Object.keys(o).sort()).toEqual([
      'head',
      'journal',
      'observations',
      'pending',
      'status',
      'usage',
      'world',
    ])
    expect(lastObs(o)).toEqual(
      observationsOf(null, { kind: 'refused', reasons: ['missing_ref'] }) as Json,
    )
  })
})

describe('失败节点定位在 run 出口透出（at / def / callAt）', () => {
  it('eval 求值失败：拒绝观测带 at；成功路径不带这三键（逐字节对拍）', () => {
    const body = J(['cmp', ['g', ['nope']], ['c', 1]])
    const s = seedDef(body)
    const o = run(input({ world: s.world, head: s.head, directives: [evalDir(s.key)] }))
    expect([o.status, reasonsOf(o)]).toEqual(['refused', ['missing_path']])
    expect(lastObs(o)).toEqual({
      kind: 'refused',
      reasons: ['missing_path'],
      at: [1],
    })
    expect(Object.keys(lastObs(o) as object).sort()).toEqual(['at', 'kind', 'reasons'])
  })

  it('被调 term 内失败：带 def（被调哈希）与 callAt（调用点路径）', () => {
    const inner = J(['v', 5])
    const outer = J(['cmp', ['call', ['c', dKey(inner)], [['c', 1]]], ['c', 0]])
    const s = seedDefs([inner, outer])
    const o = run(input({ world: s.world, head: s.head, directives: [evalDir(s.keys[1])] }))
    expect([o.status, reasonsOf(o)]).toEqual(['refused', ['bad_var']])
    expect(lastObs(o)).toMatchObject({
      kind: 'refused',
      reasons: ['bad_var'],
      def: s.keys[0],
      callAt: [1],
    })
  })

  it('成功路径观测与改前逐字节一致：eval 观测无 at / def / callAt', () => {
    const s = seedDef(['v', 0])
    const d = evalDir(s.key, 'ok')
    const o = run(input({ world: s.world, head: s.head, directives: [d] }))
    expect(o.status).toBe('done')
    const obs = lastObs(o) as { [k: string]: Json }
    expect(Object.keys(obs).sort()).toEqual(['entry', 'kind', 'ok', 'value'])
    expect(obs).toEqual({ kind: 'eval', entry: s.key, ok: true, value: 'ok' })
  })

  it('observationsOf 的 eval 分支：失败结果写出 at / def / callAt，成功结果不写', () => {
    const entry = 'ab'.repeat(32)
    const d = evalDir(entry)
    const def = 'cd'.repeat(32)
    const failed = observationsOf(d, {
      kind: 'eval',
      r: { ok: false, error: 'bad_var', at: [2, 0], def, callAt: [1] },
    } as never)
    expect(failed).toEqual({
      kind: 'eval',
      entry,
      ok: false,
      error: 'bad_var',
      at: [2, 0],
      def,
      callAt: [1],
    })
    const ok = observationsOf(d, { kind: 'eval', r: { ok: true, value: 7 } } as never)
    expect(Object.keys(ok as object).sort()).toEqual(['entry', 'kind', 'ok', 'value'])
  })
})
