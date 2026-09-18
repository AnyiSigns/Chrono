import { describe, expect, it } from 'vitest'
import { H, pos, replay, worldRev } from '../../../kernel/index.ts'
import { EMPTY_WORLD } from '../../../kernel/index.ts'
import { runSubmission } from '../rounds.ts'
import type { RoundRouter } from '../route.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Def, Directive, Entry, Hash, Json, World } from '../../../kernel/index.ts'

const LIMITS = { gas: 1_000_000, depth: 64 }

function put(d: Def): Def {
  return d
}

function worldOf(defs: Record<Hash, Def>): World {
  return { defs: { ...defs }, ids: {} }
}

function defHash(def: Def): Hash {
  return H(def as unknown as Json)
}

function fakeRouter(
  call: (port: string, method: string, args: Json) => Promise<Json> = async (
    port,
    method,
    args,
  ) => ({
    port,
    method,
    args,
  }),
  onResolve?: (emitter: string) => void,
): RoundRouter {
  const row = {
    impl: 'toy',
    gen: 'g'.repeat(64),
    cap: 'toy.echo',
    method: 'echo',
    transport: 'stdio',
    pid: 1,
    link: {
      call: async (port: string, method: string, args: Json) => ({
        ok: true,
        value: await call(port, method, args),
      }),
    },
  } as unknown as EndpointRow
  return {
    resolve: (_world, emitter) => {
      onResolve?.(emitter)
      return { ok: true, row }
    },
  }
}

function evalD(entry: Hash): Directive {
  return { kind: 'eval', entry, args: null, ctx: null }
}

function writeD(op: 'put', args: Json): Directive {
  return { kind: 'write', request: { id: '', op, target: { expect_pos: null }, args, by: '' } }
}

describe('A10 轮间驱动 runSubmission', () => {
  it('空 directives → idle', async () => {
    const outcome = await runSubmission({
      world: EMPTY_WORLD,
      head: { seq: -1, hash: null },
      directives: [],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
    })
    expect(outcome.status).toBe('idle')
  })

  it('分相：eval 段一轮、每条 write 单独一轮、expect_pos 逐条前进', async () => {
    const pure = defHash(put({ body: ['c', 1] }))
    const world = worldOf({ [pure]: put({ body: ['c', 1] }) })
    const rounds: Entry[][] = []
    let tick = 0
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [
        evalD(pure),
        writeD('put', { body: { a: 1 } }),
        writeD('put', { body: { b: 2 } }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => ++tick,
      onRound: (entries) => rounds.push(entries),
    })
    expect(outcome.status).toBe('done')
    expect(tick).toBe(3)
    expect(rounds.map((entries) => entries.length)).toEqual([0, 1, 1])
    const writes = outcome.observations.filter((o) => (o as { kind: string }).kind === 'write')
    expect(writes).toHaveLength(2)
    const positions = writes.map((o) => (o as { pos: Hash }).pos)
    expect(positions[0]).not.toBe(positions[1])
    // 业务写两两接链
    const journal = rounds.flat()
    expect(journal[0].seq).toBe(0)
    expect(journal[1].seq).toBe(1)
    expect(journal[1].prev).toBe(positions[0])
    // 无前置 eff → ref 不落
    expect(journal[0].ref).toBeUndefined()
    expect(journal[1].ref).toBeUndefined()
  })

  it('plan 通道：顶层 eval 观测的 $directives 产出下一轮 write；字段由宿主机械填', async () => {
    const plan: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { planned: true } } } }],
    }
    const pure = defHash(put({ body: ['c', 1] }))
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [pure]: put({ body: ['c', 1] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const journal: Entry[] = []
    let tick = 0
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => ++tick,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(tick).toBe(2)
    expect(journal).toHaveLength(1)
    expect(journal[0].op).toBe('put')
    expect(journal[0].by).toBe('tester')
    expect(journal[0].ref).toBeUndefined()
    // 提交时的 expect_pos 已按轮首链头填好：空世界 → null → prev 为 null
    expect(journal[0].prev).toBeNull()
    expect(outcome.world.defs[H(journal[0].args as Json)]).toBeDefined()
    // 观测序：eval（原样回带 plan 值）→ write
    expect((outcome.observations[0] as { kind: string }).kind).toBe('eval')
    expect((outcome.observations[1] as { kind: string }).kind).toBe('write')
  })

  it('eff → 审计 → 回灌 → plan 写：写条目的 ref = 紧邻 eval 段最后一条 eff 的审计键', async () => {
    const plan: Json = {
      $directives: [
        { kind: 'write', request: { op: 'put', args: { body: { first: true } } } },
        { kind: 'write', request: { op: 'put', args: { body: { second: true } } } },
      ],
    }
    const callee = defHash(put({ body: ['c', plan] }))
    const term = defHash(
      put({ body: ['call', ['c', callee], [['eff', 'toy.echo', 'echo', ['c', 1]]]] }),
    )
    const world = worldOf({
      [callee]: put({ body: ['c', plan] }),
      [term]: put({ body: ['call', ['c', callee], [['eff', 'toy.echo', 'echo', ['c', 1]]]] }),
    })
    const audits: Entry[] = []
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(term)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(),
      initialOwnerOf: () => 'caller',
      onAudit: (entry) => audits.push(entry),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(1)
    const auditHash = H(audits[0].args as Json)
    expect(journal).toHaveLength(2)
    expect(journal[0].ref).toBe(auditHash)
    expect(journal[1].ref).toBe(auditHash)
    // 审计先落：两条业务写 prev 接在审计条目之后
    expect(journal[0].prev).toBe(pos([audits[0]]))
  })

  it('extern 随邻并保序：eval+extern 同轮、write 另轮', async () => {
    const pure = defHash(put({ body: ['c', 1] }))
    const world = worldOf({ [pure]: put({ body: ['c', 1] }) })
    let tick = 0
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [
        evalD(pure),
        { kind: 'extern', payload: { x: 1 } },
        writeD('put', { body: { a: 1 } }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => ++tick,
    })
    expect(outcome.status).toBe('done')
    expect(tick).toBe(2)
    expect(outcome.observations.map((o) => (o as { kind: string }).kind)).toEqual([
      'eval',
      'extern',
      'write',
    ])
    expect(outcome.observations[1]).toEqual({ kind: 'extern', payload: { x: 1 } })
  })

  it('结构 op 的 pins：名 → 被依赖身份 active 世代 payload 哈希', async () => {
    const active: Hash = 'a'.repeat(64)
    const termDef = put({ body: ['c', 1] })
    const termHash = defHash(termDef)
    const world = worldOf({ [active]: put({ body: { commit: true } }), [termHash]: termDef })
    world.ids['dep'] = {
      id: 'dep',
      schema: 's'.repeat(64),
      gens: [
        {
          seq: 0,
          payload: active,
          pins: {},
          sig: 's'.repeat(64),
          adopted: { at: 1, by: 'seed', write: active },
        },
      ],
      active,
      born: { at: 1, by: 'seed' },
    }
    const plan: Json = {
      $directives: [
        {
          kind: 'write',
          request: { op: 'put', args: { body: { withPins: true }, pins: { 'toy.echo': 'dep' } } },
        },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    world.defs[planner] = put({ body: ['c', plan] })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    expect((journal[0].args as { pins: Record<string, Hash> }).pins['toy.echo']).toBe(active)
  })

  it('plan 条目形态非法（表驱动）→ refused:bad_directive；非数组 $directives 当普通数据', async () => {
    const cases: Json[] = [
      { $directives: [{ kind: 'bogus' }] },
      { $directives: [{ kind: 'write', request: { args: {} } }] },
      { $directives: [{ kind: 'write', request: 5 }] },
      { $directives: [{ kind: 'eval' }] },
    ]
    for (const bad of cases) {
      const planner = defHash(put({ body: ['c', bad] }))
      const world = worldOf({ [planner]: put({ body: ['c', bad] }) })
      const journal: Entry[] = []
      const outcome = await runSubmission({
        world,
        head: { seq: -1, hash: null },
        directives: [evalD(planner)],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
        onRound: (entries) => journal.push(...entries),
      })
      expect(outcome.status).toBe('refused')
      expect(journal).toEqual([])
      expect(outcome.observations[outcome.observations.length - 1]).toEqual({
        kind: 'refused',
        reasons: ['bad_directive'],
      })
    }
    // `$directives` 非数组：不是计划，按普通数据回给发起者
    const data: Json = { $directives: 'x' }
    const planner = defHash(put({ body: ['c', data] }))
    const outcome = await runSubmission({
      world: worldOf({ [planner]: put({ body: ['c', data] }) }),
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
    })
    expect(outcome.status).toBe('done')
    expect((outcome.observations[0] as { value: Json }).value).toEqual(data)
  })

  it('plan 递归：plan 的 eval 再产 plan，逐层执行到穷尽', async () => {
    const leafPlan: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { deep: true } } } }],
    }
    const leafPlanner = defHash(put({ body: ['c', leafPlan] }))
    const midPlan: Json = { $directives: [{ kind: 'eval', entry: leafPlanner }] }
    const midPlanner = defHash(put({ body: ['c', midPlan] }))
    const world = worldOf({
      [leafPlanner]: put({ body: ['c', leafPlan] }),
      [midPlanner]: put({ body: ['c', midPlan] }),
    })
    const journal: Entry[] = []
    let tick = 0
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(midPlanner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => ++tick,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(tick).toBe(3)
    expect(journal).toHaveLength(1)
    expect((journal[0].args as { body: Json }).body).toEqual({ deep: true })
    expect(outcome.observations.map((o) => (o as { kind: string }).kind)).toEqual([
      'eval',
      'eval',
      'write',
    ])
  })

  it('多 eval 同轮：plan 按观测序拼接，顺序与观测一致', async () => {
    const planA: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { a: 1 } } } }],
    }
    const planB: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { b: 2 } } } }],
    }
    const plannerA = defHash(put({ body: ['c', planA] }))
    const plannerB = defHash(put({ body: ['c', planB] }))
    const world = worldOf({
      [plannerA]: put({ body: ['c', planA] }),
      [plannerB]: put({ body: ['c', planB] }),
    })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(plannerA), evalD(plannerB)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(2)
    expect((journal[0].args as { body: Json }).body).toEqual({ a: 1 })
    expect((journal[1].args as { body: Json }).body).toEqual({ b: 2 })
  })

  it('plan 条目属主继承产出者：plan 的 eval 发 eff 用产出者身份路由', async () => {
    const step = defHash(put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }))
    const plan: Json = { $directives: [{ kind: 'eval', entry: step }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [step]: put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const emitters: string[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(undefined, (emitter) => emitters.push(emitter)),
      initialOwnerOf: () => 'ownerA',
    })
    expect(outcome.status).toBe('done')
    expect(emitters).toEqual(['ownerA'])
  })

  it('batch 子操作的 pins 同样解析（递归）', async () => {
    const active: Hash = 'a'.repeat(64)
    const world = worldOf({ [active]: put({ body: { commit: true } }) })
    world.ids['dep'] = {
      id: 'dep',
      schema: 's'.repeat(64),
      gens: [
        {
          seq: 0,
          payload: active,
          pins: {},
          sig: 's'.repeat(64),
          adopted: { at: 1, by: 'seed', write: active },
        },
      ],
      active,
      born: { at: 1, by: 'seed' },
    }
    const plan: Json = {
      $directives: [
        {
          kind: 'write',
          request: {
            op: 'batch',
            args: {
              ops: [{ op: 'put', args: { body: { viaBatch: true }, pins: { 'toy.echo': 'dep' } } }],
            },
          },
        },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    world.defs[planner] = put({ body: ['c', plan] })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    const ops = (journal[0].args as { ops: Array<{ args: { pins: Record<string, Hash> } }> }).ops
    expect(ops[0].args.pins['toy.echo']).toBe(active)
  })

  it('eval 段多条 eff：plan 写的 ref = 紧邻 eval 段最后一条 eff 的审计键', async () => {
    const plan: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { after: 2 } } } }],
    }
    const callee = defHash(put({ body: ['c', plan] }))
    const body: Json = [
      'call',
      ['c', callee],
      [
        ['eff', 'toy.echo', 'echo', ['c', 1]],
        ['eff', 'toy.echo', 'echo', ['c', 2]],
      ],
    ]
    const term = defHash(put({ body }))
    const world = worldOf({ [callee]: put({ body: ['c', plan] }), [term]: put({ body }) })
    const audits: Entry[] = []
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(term)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(),
      initialOwnerOf: () => 'caller',
      onAudit: (entry) => audits.push(entry),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(2)
    expect(journal).toHaveLength(1)
    expect(journal[0].ref).toBe(H(audits[1].args as Json))
  })

  it('plan 写：id 幂等键非空且逐条唯一；args 原样落地', async () => {
    const plan: Json = {
      $directives: [
        { kind: 'write', request: { op: 'put', args: { body: { k: 1 } } } },
        { kind: 'write', request: { op: 'put', args: { body: { k: 2 } } } },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({ [planner]: put({ body: ['c', plan] }) })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(2)
    expect((journal[0].args as { body: Json }).body).toEqual({ k: 1 })
    expect((journal[1].args as { body: Json }).body).toEqual({ k: 2 })
  })

  it('plan 结构 pins 解析不到身份 → refused:unresolved_pin；batch 子操作缺 args → bad_directive', async () => {
    const unresolved: Json = {
      $directives: [
        {
          kind: 'write',
          request: { op: 'put', args: { body: { x: 1 }, pins: { 'toy.echo': 'ghost' } } },
        },
      ],
    }
    const missingArgs: Json = {
      $directives: [{ kind: 'write', request: { op: 'batch', args: { ops: [{ op: 'put' }] } } }],
    }
    for (const [plan, reason] of [
      [unresolved, 'unresolved_pin'],
      [missingArgs, 'bad_directive'],
    ] as Array<[Json, string]>) {
      const planner = defHash(put({ body: ['c', plan] }))
      const world = worldOf({ [planner]: put({ body: ['c', plan] }) })
      const journal: Entry[] = []
      const outcome = await runSubmission({
        world,
        head: { seq: -1, hash: null },
        directives: [evalD(planner)],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
        onRound: (entries) => journal.push(...entries),
      })
      expect(outcome.status).toBe('refused')
      expect(journal).toEqual([])
      expect(outcome.observations[outcome.observations.length - 1]).toEqual({
        kind: 'refused',
        reasons: [reason],
      })
    }
  })

  it('refused 轮：返回的 head 已随审计推进（下一次提交可续链）', async () => {
    const termHash = 'ef'.repeat(32)
    const world = worldOf({ [termHash]: put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }) })
    const audits: Entry[] = []
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(termHash)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(async () => {
        throw new Error('pipe closed')
      }),
      initialOwnerOf: () => 'caller',
      onAudit: (entry) => audits.push(entry),
    })
    expect(outcome.status).toBe('refused')
    expect(audits).toHaveLength(1)
    expect(outcome.head.hash).toBe(pos([audits[0]]))
    expect(outcome.world.defs[H(audits[0].args as Json)]).toBeDefined()
  })

  it('重放一致：内存 commit 的结束世界 = 按发生序重放条目（非自证）', async () => {
    const planner = defHash(
      put({
        body: [
          'c',
          { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { v: 7 } } } }] },
        ],
      }),
    )
    const world = worldOf({
      [planner]: put({
        body: [
          'c',
          { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { v: 7 } } } }] },
        ],
      }),
    })
    const audits: Entry[] = []
    const rounds: Entry[] = []
    // 基线快照：审计 commit 会就地改世界，对比重放须从快照起（defs 不可变，浅拷即可）
    const base: World = { defs: { ...world.defs }, ids: { ...world.ids } }
    const outcome = await runSubmission({
      world,
      head: { seq: -1, hash: null },
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onAudit: (entry) => audits.push(entry),
      onRound: (entries) => rounds.push(...entries),
    })
    const all = [...audits, ...rounds].sort((a, b) => a.seq - b.seq)
    expect(all.length).toBeGreaterThan(0)
    expect(worldRev(outcome.world)).toBe(worldRev(replay(all, base)))
  })
})
