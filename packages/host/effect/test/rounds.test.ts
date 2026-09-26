import { describe, expect, it } from 'vitest'
import { EMPTY_WORLD, H, pos, replay, worldRev } from '../../../kernel/index.ts'
import { WorldWriter } from '../../writer.ts'
import type { SyncResult, WorldState } from '../../writer.ts'
import { resolvePins, runSubmission, parsePlanDirectives } from '../rounds.ts'
import type { AuditDraft } from '../../audit.ts'
import type { RoundRouter } from '../route.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Def, Directive, Entry, Hash, Head, Json, Op, World } from '../../../kernel/index.ts'

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

function writeD(op: Op, args: Json): Directive {
  return { kind: 'write', request: { id: '', op, target: { expect_pos: null }, args, by: '' } }
}

/** 构造一个单世代、active 可配的身份。 */
function identityOf(id: string, active: Hash, schema = 's'.repeat(64)): World['ids'][string] {
  return {
    id,
    schema,
    gens: [
      {
        seq: 0,
        payload: active,
        pins: {},
        sig: schema,
        adopted: { at: 1, by: 'seed', write: active },
      },
    ],
    active,
    born: { at: 1, by: 'seed' },
  }
}

describe('A10 轮间驱动 runSubmission', () => {
  it('缺 writer → 抛错（fail-closed，不静默新建写者）', async () => {
    await expect(
      runSubmission({
        directives: [],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
      }),
    ).rejects.toThrow('provide writer')
  })

  it('空 directives → idle', async () => {
    const outcome = await runSubmission({
      writer: new WorldWriter({ world: EMPTY_WORLD, head: { seq: -1, hash: null } }),
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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

  it('eff → 审计侧存 → 回灌 → plan 写：业务写不落 ref，审计不进世界', async () => {
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
    const audits: AuditDraft[] = []
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(term)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(),
      initialOwnerOf: () => 'caller',
      onAudit: (draft) => audits.push(draft),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(1)
    expect(journal).toHaveLength(2)
    // 审计走旁路侧存：业务写不落 ref，也不接在审计条目之后
    expect(journal[0].ref).toBeUndefined()
    expect(journal[1].ref).toBeUndefined()
    expect(journal[0].prev).toBeNull()
  })

  it('extern 随邻并保序：eval+extern 同轮、write 另轮', async () => {
    const pure = defHash(put({ body: ['c', 1] }))
    const world = worldOf({ [pure]: put({ body: ['c', 1] }) })
    let tick = 0
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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

  it('顶层结构 op 的 pins 值为 host：提前拒 bad_directive（内核会判 bad_form）', () => {
    for (const op of ['add_gen', 'put', 'graft']) {
      expect(resolvePins(op, { body: { x: 1 }, pins: { host: 'host' } }, EMPTY_WORLD)).toEqual({
        ok: false,
        reason: 'bad_directive',
      })
    }
  })

  it('batch 子操作的 pins 值为 host：保留字面量，不查世界', () => {
    const resolved = resolvePins(
      'batch',
      { ops: [{ op: 'put', args: { body: { withHost: true }, pins: { host: 'host' } } }] },
      EMPTY_WORLD,
    )
    expect(resolved).toEqual({
      ok: true,
      value: { ops: [{ op: 'put', args: { body: { withHost: true }, pins: { host: 'host' } } }] },
    })
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
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
      writer: new WorldWriter({
        world: worldOf({ [planner]: put({ body: ['c', data] }) }),
        head: { seq: -1, hash: null },
      }),
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
    const midPlan: Json = { $directives: [{ kind: 'eval', entry: leafPlanner, ctx: null }] }
    const midPlanner = defHash(put({ body: ['c', midPlan] }))
    const world = worldOf({
      [leafPlanner]: put({ body: ['c', leafPlan] }),
      [midPlanner]: put({ body: ['c', midPlan] }),
    })
    const journal: Entry[] = []
    let tick = 0
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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

  it('plan 自回路：自能力 eff 回计划再 eval 自己 → 有界 refused:too_many_rounds', async () => {
    const body: Json = ['eff', 'toy.echo', 'echo', ['c', 1]]
    const term = defHash(put({ body }))
    const world = worldOf({ [term]: put({ body }) })
    // 服务把「再次 eval 该入口」当计划返回：每轮 1 条 eff → 无界递归
    const plan: Json = { $directives: [{ kind: 'eval', entry: term, ctx: null }] }
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(term)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(async () => plan),
      initialOwnerOf: () => 'caller',
      maxRounds: 64,
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.observations[outcome.observations.length - 1]).toEqual({
      kind: 'refused',
      reasons: ['too_many_rounds'],
    })
    // 恰好跑到上限即收口，不无限递归
    expect(
      outcome.observations.filter((o) => (o as { kind: string }).kind === 'eval'),
    ).toHaveLength(64)
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
    const plan: Json = { $directives: [{ kind: 'eval', entry: step, ctx: null }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [step]: put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const emitters: string[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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

  it('eval 段多条 eff：各次调用均产审计草稿，plan 写不落 ref', async () => {
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
    const audits: AuditDraft[] = []
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(term)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(),
      initialOwnerOf: () => 'caller',
      onAudit: (draft) => audits.push(draft),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(2)
    expect(journal).toHaveLength(1)
    expect(journal[0].ref).toBeUndefined()
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
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
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

  it('refused 轮：审计只进侧存，世界 / 链头不推进', async () => {
    const termHash = 'ef'.repeat(32)
    const world = worldOf({ [termHash]: put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }) })
    const audits: AuditDraft[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(termHash)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(async () => {
        throw new Error('pipe closed')
      }),
      initialOwnerOf: () => 'caller',
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('refused')
    expect(audits).toHaveLength(1)
    expect(outcome.head).toEqual({ seq: -1, hash: null })
    expect(Object.keys(outcome.world.defs)).toEqual([termHash])
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
    const rounds: Entry[] = []
    // 基线快照：业务写就地改世界，对比重放须从快照起（defs 不可变，浅拷即可）
    const base: World = { defs: { ...world.defs }, ids: { ...world.ids } }
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => rounds.push(...entries),
    })
    expect(rounds.length).toBeGreaterThan(0)
    expect(worldRev(outcome.world)).toBe(worldRev(replay(rounds, base)))
  })
})

describe('A14 eval ctx 注入（三路同规）', () => {
  const READER = ['g', ['marker']] as unknown as Json
  const REV = ['g', ['world_rev']] as unknown as Json

  function readerWorld(): { reader: Hash; revReader: Hash; world: World } {
    const reader = defHash(put({ body: READER }))
    const revReader = defHash(put({ body: REV }))
    return {
      reader,
      revReader,
      world: worldOf({ [reader]: put({ body: READER }), [revReader]: put({ body: REV }) }),
    }
  }

  it('ctx 字段缺省 ⇒ 轮首投影：term 读到投影值，ctxFor 收到该轮 world / head', async () => {
    const { reader, world } = readerWorld()
    const head: Head = { seq: 4, hash: 'f'.repeat(64) }
    const calls: Array<{ world: World; head: Head }> = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head }),
      directives: [{ kind: 'eval', entry: reader, args: null }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: (w, h) => {
        calls.push({ world: w, head: h })
        return { marker: 'p1' }
      },
    })
    expect(outcome.status).toBe('done')
    expect((outcome.observations[0] as { value: Json }).value).toBe('p1')
    expect(calls).toHaveLength(1)
    expect(calls[0].world).toBe(world)
    expect(calls[0].head).toBe(head)
  })

  it('ctx 缺省但 provider 缺席：立即抛错，不静默退化成 null', async () => {
    const { reader, world } = readerWorld()
    await expect(
      runSubmission({
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
        directives: [{ kind: 'eval', entry: reader, args: null }],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
      }),
    ).rejects.toThrow('ctxFor')
  })

  it('provider 返回 undefined：立即抛错，不把非 JSON 值交给 term', async () => {
    const { reader, world } = readerWorld()
    await expect(
      runSubmission({
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
        directives: [{ kind: 'eval', entry: reader, args: null }],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
        ctxFor: () => undefined as unknown as Json,
      }),
    ).rejects.toThrow('ctxFor returned undefined')
  })

  it('显式 ctx（含 null）⇒ 原样透传、不构造投影', async () => {
    const { reader, revReader, world } = readerWorld()
    let calls = 0
    // 显式 null + 读 world_rev 的 term：若实现错把 null 当缺省填投影，此处会 done 而非 refused
    const withNull = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: revReader, args: null, ctx: null }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => {
        calls += 1
        return { marker: 'should-not-be-used' }
      },
    })
    expect(withNull.status).toBe('refused')
    expect(withNull.observations[withNull.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['missing_path'],
    })

    const withValue = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: reader, args: null, ctx: { marker: 'mine' } }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => {
        calls += 1
        return { marker: 'should-not-be-used' }
      },
    })
    expect(withValue.status).toBe('done')
    expect((withValue.observations[0] as { value: Json }).value).toBe('mine')
    expect(calls).toBe(0)
  })

  it('每轮构造一次（该轮 eval 共享）；write 轮不构造；后一轮用其轮首 world / head', async () => {
    const { reader, world } = readerWorld()
    const calls: Array<{ world: World; head: Head }> = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        { kind: 'eval', entry: reader, args: null },
        { kind: 'eval', entry: reader, args: null },
        writeD('put', { body: { w: 1 } }),
        { kind: 'eval', entry: reader, args: null },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: (w, h) => {
        calls.push({ world: w, head: h })
        return { marker: `${worldRev(w)}:${h.seq}` }
      },
    })
    expect(outcome.status).toBe('done')
    // 第一段两个 eval 共享一次构造；write 轮不构造；write 之后的 eval 轮再构造一次（轮首已推进）
    expect(calls.map((c) => c.head.seq)).toEqual([-1, 0])
    // 第二轮 ctx 吃的是写后世界（worldRev(outcome.world)），证明用的是该轮轮首 world 而非提交起始 world
    expect(calls[1].world).not.toBe(world)
    const values = outcome.observations
      .filter((o) => (o as { kind: string }).kind === 'eval')
      .map((o) => (o as { value: Json }).value)
    expect(values).toEqual([
      `${worldRev(world)}:-1`,
      `${worldRev(world)}:-1`,
      `${worldRev(outcome.world)}:0`,
    ])
  })

  it('纯 write 提交不构造 ctx', async () => {
    const outcome = await runSubmission({
      writer: new WorldWriter({ world: EMPTY_WORLD, head: { seq: -1, hash: null } }),
      directives: [writeD('put', { body: { only: 'write' } })],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => {
        throw new Error('must not construct')
      },
    })
    expect(outcome.status).toBe('done')
  })

  it('轮内 eff 的审计只进侧存，不推进 head，也不回改该轮 ctx', async () => {
    const callee = defHash(put({ body: ['g', ['head', 'seq']] }))
    const main = defHash(
      put({ body: ['call', ['c', callee], [['eff', 'toy.echo', 'echo', ['c', 1]]]] }),
    )
    const world = worldOf({
      [callee]: put({ body: ['g', ['head', 'seq']] }),
      [main]: put({ body: ['call', ['c', callee], [['eff', 'toy.echo', 'echo', ['c', 1]]]] }),
    })
    const audits: AuditDraft[] = []
    let calls = 0
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: main, args: null }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(),
      initialOwnerOf: () => 'caller',
      onAudit: (draft) => audits.push(draft),
      ctxFor: (_w, h) => {
        calls += 1
        return { head: { seq: h.seq, hash: h.hash } }
      },
    })
    expect(outcome.status).toBe('done')
    // 审计走旁路侧存，链头不动（-1），ctx 仍报该轮轮首（-1）
    expect(audits).toHaveLength(1)
    expect(outcome.head.seq).toBe(-1)
    expect((outcome.observations[0] as { value: Json }).value).toBe(-1)
    expect(calls).toBe(1)
  })

  it('plan 条目 ctx 缺省 ⇒ 同规填投影；显式 null ⇒ 透传（refused）', async () => {
    const { reader, revReader, world } = readerWorld()
    const planOf = (item: Json): Json => ({ $directives: [item] })
    const plannerKey = defHash(put({ body: ['c', planOf({ kind: 'eval', entry: reader })] }))
    const plannerNullKey = defHash(
      put({ body: ['c', planOf({ kind: 'eval', entry: revReader, ctx: null })] }),
    )
    const planWorld = worldOf({
      [plannerKey]: put({ body: ['c', planOf({ kind: 'eval', entry: reader })] }),
      [plannerNullKey]: put({ body: ['c', planOf({ kind: 'eval', entry: revReader, ctx: null })] }),
      [reader]: put({ body: READER }),
      [revReader]: put({ body: REV }),
    })

    let calls = 0
    const filled = await runSubmission({
      writer: new WorldWriter({ world: planWorld, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: plannerKey, args: null }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => {
        calls += 1
        return { marker: 'plan-ctx' }
      },
    })
    expect(filled.status).toBe('done')
    // 两个 eval 轮（产出者轮 + plan 轮）各构造一次
    expect(calls).toBe(2)
    const planEval = filled.observations.find(
      (o) => (o as { kind: string; entry?: string }).entry === reader,
    )
    expect((planEval as { value: Json }).value).toBe('plan-ctx')

    // 显式 null：错误实现若填投影会 done，正确实现 refused
    const passthrough = await runSubmission({
      writer: new WorldWriter({ world: planWorld, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: plannerNullKey, args: null }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => {
        calls += 1
        return { marker: 'plan-ctx' }
      },
    })
    expect(passthrough.status).toBe('refused')
    expect(passthrough.observations[passthrough.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['missing_path'],
    })
    // 产出者轮构造一次；plan 条目显式 null 不构造
    expect(calls).toBe(3)
  })

  it('inject：宿主按声明路径把投影片段并入 args（续跑不再自带整份投影）', async () => {
    const reader = defHash(put({ body: ['v', 0] }))
    const world = worldOf({ [reader]: put({ body: ['v', 0] }) })
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        {
          kind: 'eval',
          entry: reader,
          args: { cursor: 'c-1' },
          ctx: null,
          inject: { ids: ['ids'], session: ['ids', 'sess', 'body'] },
        },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => ({ ids: { sess: { body: { current: 'c-1' } } } }),
    })
    expect(outcome.status).toBe('done')
    expect((outcome.observations[0] as { value: Json }).value).toEqual({
      cursor: 'c-1',
      ids: { sess: { body: { current: 'c-1' } } },
      session: { current: 'c-1' },
    })
  })

  it('inject 形态非法（args 非对象 / 路径非数组）→ refused:bad_directive', async () => {
    const reader = defHash(put({ body: ['v', 0] }))
    const world = worldOf({ [reader]: put({ body: ['v', 0] }) })
    const badArgs = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [{ kind: 'eval', entry: reader, args: null, inject: { ids: ['ids'] } }],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: () => ({ ids: {} }),
    })
    expect(badArgs.status).toBe('refused')
    expect(badArgs.observations[badArgs.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['bad_directive'],
    })

    const plan = parsePlanDirectives({
      $directives: [{ kind: 'eval', entry: reader, inject: { ids: 'ids' } }],
    })
    expect(plan).toEqual({ ok: false, reason: 'bad_directive' })
  })

  it('plan 轮取自身轮首 world / head：plan 先落 write，随后的 plan eval 吃到写后世界', async () => {
    const { reader } = readerWorld()
    const plan: Json = {
      $directives: [
        { kind: 'write', request: { op: 'put', args: { body: { planned: 1 } } } },
        { kind: 'eval', entry: reader },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [planner]: put({ body: ['c', plan] }),
      [reader]: put({ body: READER }),
    })
    const calls: Array<{ world: World; head: Head }> = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: (w, h) => {
        calls.push({ world: w, head: h })
        return { marker: `${worldRev(w)}:${h.seq}` }
      },
    })
    expect(outcome.status).toBe('done')
    // 产出者 eval 显式 ctx:null 不构造；plan 的 write 轮不构造；plan 的 eval 轮构造一次
    expect(calls).toHaveLength(1)
    expect(calls[0].head.seq).toBe(0)
    expect(calls[0].world).not.toBe(world)
    const planEval = outcome.observations.find(
      (o) => (o as { kind: string; entry?: string }).entry === reader,
    )
    expect((planEval as { value: Json }).value).toBe(`${worldRev(outcome.world)}:0`)
  })
})

describe('H18 plan eval 按命令名解析', () => {
  /** 命令名 → 入口 def + 声明方身份（宿主注入；effect 不认识装配）。 */
  function stubResolver(
    table: Record<string, { entry: Hash; identity: string }>,
  ): (world: World, name: string) => { entry: Hash; identity: string } | undefined {
    return (_world, name) => table[name]
  }

  it('命令形式 eval：按命令声明解析入口并成功跑（pickPlan 路径）', async () => {
    const pure = defHash(put({ body: ['c', 1] }))
    const plan: Json = { $directives: [{ kind: 'eval', command: 'toy.echo', ctx: null }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [pure]: put({ body: ['c', 1] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      resolveCommand: stubResolver({ 'toy.echo': { entry: pure, identity: 'cmd-owner' } }),
    })
    expect(outcome.status).toBe('done')
    expect(outcome.observations.map((o) => (o as { kind: string }).kind)).toEqual(['eval', 'eval'])
  })

  it('命令形式 eval 产出的 $directives 冒泡落账（按已解析入口匹配，不丢计划）', async () => {
    const inner: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { bubbled: true } } } }],
    }
    const innerTerm = defHash(put({ body: ['c', inner] }))
    const plan: Json = { $directives: [{ kind: 'eval', command: 'inner', ctx: null }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [innerTerm]: put({ body: ['c', inner] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      resolveCommand: stubResolver({ inner: { entry: innerTerm, identity: 'cmd-owner' } }),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    expect((journal[0].args as { body: Json }).body).toEqual({ bubbled: true })
  })

  it('entry 与 command 同条并存 / 都缺 → refused:bad_directive', async () => {
    const cases: Json[] = [
      { $directives: [{ kind: 'eval', entry: 'a'.repeat(64), command: 'x' }] },
      { $directives: [{ kind: 'eval' }] },
      { $directives: [{ kind: 'eval', command: '' }] },
    ]
    for (const bad of cases) {
      const planner = defHash(put({ body: ['c', bad] }))
      const world = worldOf({ [planner]: put({ body: ['c', bad] }) })
      const journal: Entry[] = []
      const outcome = await runSubmission({
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
        directives: [evalD(planner)],
        caps: {},
        limits: LIMITS,
        initiator: 'tester',
        now: () => 1,
        resolveCommand: stubResolver({ x: { entry: planner, identity: 'x' } }),
        onRound: (entries) => journal.push(...entries),
      })
      expect(outcome.status).toBe('refused')
      expect(journal).toEqual([])
      expect(outcome.observations[outcome.observations.length - 1]).toEqual({
        kind: 'refused',
        reasons: ['bad_directive'],
      })
    }
  })

  it('命令名解析不到 → refused:unknown_command（与命令面同码）', async () => {
    const plan: Json = { $directives: [{ kind: 'eval', command: 'ghost', ctx: null }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({
        world: worldOf({ [planner]: put({ body: ['c', plan] }) }),
        head: { seq: -1, hash: null },
      }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      resolveCommand: () => undefined,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('refused')
    expect(journal).toEqual([])
    expect(outcome.observations[outcome.observations.length - 1]).toEqual({
      kind: 'refused',
      reasons: ['unknown_command'],
    })
  })

  it('命令形式 eval 的属主 = 命令声明方：eff 按声明方身份路由', async () => {
    const step = defHash(put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }))
    const plan: Json = { $directives: [{ kind: 'eval', command: 'step', ctx: null }] }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [step]: put({ body: ['eff', 'toy.echo', 'echo', ['c', 1]] }),
      [planner]: put({ body: ['c', plan] }),
    })
    const emitters: string[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      router: fakeRouter(undefined, (emitter) => emitters.push(emitter)),
      // 产出者属主为 producer-owner，但命令形式 eval 必须改按命令声明方路由
      initialOwnerOf: () => 'producer-owner',
      resolveCommand: stubResolver({ step: { entry: step, identity: 'cmd-owner' } }),
    })
    expect(outcome.status).toBe('done')
    expect(emitters).toEqual(['cmd-owner'])
  })

  it('parsePlanDirectives：命令形式原样物化，经 runSubmission 解析并落账', async () => {
    const parsed = parsePlanDirectives({
      $directives: [{ kind: 'eval', command: 'cmd', args: { a: 1 }, ctx: null }],
    })
    expect(parsed).toEqual({
      ok: true,
      directives: [{ kind: 'eval', command: 'cmd', args: { a: 1 }, ctx: null }],
    })
    expect(
      parsePlanDirectives({
        $directives: [{ kind: 'eval', entry: 'a'.repeat(64), command: 'x' }],
      }),
    ).toEqual({ ok: false, reason: 'bad_directive' })

    const inner: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { viaMethod: true } } } }],
    }
    const innerTerm = defHash(put({ body: ['c', inner] }))
    const world = worldOf({ [innerTerm]: put({ body: ['c', inner] }) })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: (parsed as { ok: true; directives: Directive[] }).directives,
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      resolveCommand: stubResolver({ cmd: { entry: innerTerm, identity: 'cmd-owner' } }),
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    expect((journal[0].args as { body: Json }).body).toEqual({ viaMethod: true })
  })
})

describe('只读提交 runSubmission（readonly）', () => {
  it('write directive → refused readonly_violation，不落账、不推进 head', async () => {
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world: EMPTY_WORLD, head: { seq: -1, hash: null } }),
      directives: [writeD('put', { body: { a: 1 } })],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      readonly: true,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('refused')
    expect(journal).toEqual([])
    expect(outcome.head).toEqual({ seq: -1, hash: null })
    expect(outcome.observations[outcome.observations.length - 1]).toEqual({
      kind: 'refused',
      reasons: ['readonly_violation'],
    })
  })

  it('plan 产出 write → refused readonly_violation，不执行 plan', async () => {
    const plan: Json = {
      $directives: [{ kind: 'write', request: { op: 'put', args: { body: { planned: true } } } }],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({ [planner]: put({ body: ['c', plan] }) })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      readonly: true,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('refused')
    expect(journal).toEqual([])
    expect(outcome.head).toEqual({ seq: -1, hash: null })
    expect(outcome.observations[outcome.observations.length - 1]).toEqual({
      kind: 'refused',
      reasons: ['readonly_violation'],
    })
  })

  it('只读提交 done 也不调用 onAdvanced（不跟随换代）', async () => {
    const pure = defHash(put({ body: ['c', 1] }))
    const world = worldOf({ [pure]: put({ body: ['c', 1] }) })
    let advanced = 0
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(pure)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      readonly: true,
      onAdvanced: () => {
        advanced += 1
      },
    })
    expect(outcome.status).toBe('done')
    expect(advanced).toBe(0)
  })
})

describe('add_gen expect_active 注入与落账段物化', () => {
  it('直提 add_gen：expect_active = 该轮基准世界目标身份的 active', async () => {
    const active = 'a'.repeat(64)
    const payload = 'b'.repeat(64)
    const world = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [payload]: put({ body: { gen: 2 } }),
    })
    world.ids['dep'] = identityOf('dep', active)
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [writeD('add_gen', { id: 'dep', payload, sig: payload, pins: {} })],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect((journal[0].args as { expect_active?: Hash }).expect_active).toBe(active)
  })

  it('显式 expect_active 不被覆盖（陈旧读以显式值为准 → stale_active）', async () => {
    const active = 'a'.repeat(64)
    const payload = 'b'.repeat(64)
    const world = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [payload]: put({ body: { gen: 2 } }),
    })
    world.ids['dep'] = identityOf('dep', active)
    // 显式给 payload（≠ 基准 active）：若被覆盖成 active 会成功；正确实现透传 → 内核判 stale_active
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        writeD('add_gen', { id: 'dep', payload, sig: payload, pins: {}, expect_active: payload }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.observations[outcome.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['stale_active'],
    })
  })

  it('batch 内新建身份的 add_gen：基准世界无此身份 → expect_active = null', async () => {
    const schema = 'c'.repeat(64)
    const payload = 'b'.repeat(64)
    const world = worldOf({
      [schema]: put({ body: { type: 'object' } }),
      [payload]: put({ body: { gen: 2 } }),
    })
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        writeD('batch', {
          ops: [
            { op: 'add_identity', args: { id: 'fresh', schema } },
            { op: 'add_gen', args: { id: 'fresh', payload, sig: payload, pins: {} } },
          ],
        }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    const ops = (journal[0].args as { ops: Array<{ args: { expect_active?: Hash | null } }> }).ops
    expect(ops[1].args.expect_active).toBeNull()
  })

  it('plan add_gen 基准 = 产出该计划的 eval 所在轮世界：并发换代 → stale_active', async () => {
    const active = 'a'.repeat(64)
    const payload = 'b'.repeat(64)
    const concurrent = 'd'.repeat(64)
    const plan: Json = {
      $directives: [
        {
          kind: 'write',
          request: { op: 'add_gen', args: { id: 'dep', payload, sig: payload, pins: {} } },
        },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    const base = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [payload]: put({ body: { gen: 2 } }),
      [concurrent]: put({ body: { gen: 3 } }),
      [planner]: put({ body: ['c', plan] }),
    })
    base.ids['dep'] = identityOf('dep', active)
    // 模拟并发提交：第二段（plan 写轮）前把 dep.active 推到 concurrent
    const advanced: World = { defs: { ...base.defs }, ids: { ...base.ids } }
    advanced.ids['dep'] = identityOf('dep', concurrent)
    class AdvanceBeforeSecondWriter extends WorldWriter {
      private calls = 0
      override run<T>(fn: (state: WorldState) => SyncResult<T>): Promise<T> {
        return super.run((state) => {
          this.calls += 1
          if (this.calls === 2) state.world = advanced
          return fn(state)
        })
      }
    }
    const writer = new AdvanceBeforeSecondWriter({ world: base, head: { seq: -1, hash: null } })
    const outcome = await runSubmission({
      writer,
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.observations[outcome.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['stale_active'],
    })
  })

  it('同 plan 两条 add_gen 同一身份：本 run 先前写并入基准，避免自冲突', async () => {
    const active = 'a'.repeat(64)
    const p1 = 'b'.repeat(64)
    const p2 = 'c'.repeat(64)
    const plan: Json = {
      $directives: [
        {
          kind: 'write',
          request: { op: 'add_gen', args: { id: 'dep', payload: p1, sig: p1, pins: {} } },
        },
        {
          kind: 'write',
          request: { op: 'add_gen', args: { id: 'dep', payload: p2, sig: p2, pins: {} } },
        },
      ],
    }
    const planner = defHash(put({ body: ['c', plan] }))
    const world = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [p1]: put({ body: { gen: 2 } }),
      [p2]: put({ body: { gen: 3 } }),
      [planner]: put({ body: ['c', plan] }),
    })
    world.ids['dep'] = identityOf('dep', active)
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalD(planner)],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(2)
    expect((journal[0].args as { expect_active?: Hash }).expect_active).toBe(active)
    expect((journal[1].args as { expect_active?: Hash }).expect_active).toBe(p1)
  })

  it('物化下沉到落账段：pins 与 ctx 用段内世界（快照已偏斜也不误判）', async () => {
    const active = 'a'.repeat(64)
    const reader = defHash(put({ body: ['g', ['marker']] }))
    const base = worldOf({
      [reader]: put({ body: ['g', ['marker']] }),
      [active]: put({ body: { gen: 1 } }),
    })
    const advanced: World = { defs: { ...base.defs }, ids: { dep: identityOf('dep', active) } }
    class SwapWorldWriter extends WorldWriter {
      override run<T>(fn: (state: WorldState) => SyncResult<T>): Promise<T> {
        return super.run((state) => {
          state.world = advanced
          return fn(state)
        })
      }
    }
    const writer = new SwapWorldWriter({ world: base, head: { seq: -1, hash: null } })
    const worlds: World[] = []
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer,
      directives: [
        writeD('put', { body: { withPins: true }, pins: { 'toy.echo': 'dep' } }),
        { kind: 'eval', entry: reader, args: null },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      ctxFor: (w) => {
        worlds.push(w)
        return { marker: 'm' }
      },
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    // pins 在段内世界解析到 dep.active（快照世界无 dep，若用快照会 unresolved_pin）
    expect((journal[0].args as { pins: Record<string, Hash> }).pins['toy.echo']).toBe(active)
    // ctx 也用段内世界构造
    expect(worlds).toEqual([advanced])
    const evalObservation = outcome.observations.find(
      (o) => (o as { kind: string }).kind === 'eval',
    )
    expect((evalObservation as { value: Json }).value).toBe('m')
  })

  it('batch 内同 id 双 add_gen：批内叠加推进 expect_active，不误判 stale_active', async () => {
    const active = 'a'.repeat(64)
    const p1 = 'b'.repeat(64)
    const p2 = 'c'.repeat(64)
    const world = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [p1]: put({ body: { gen: 2 } }),
      [p2]: put({ body: { gen: 3 } }),
    })
    world.ids['dep'] = identityOf('dep', active)
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        writeD('batch', {
          ops: [
            { op: 'add_gen', args: { id: 'dep', payload: p1, sig: p1, pins: {} } },
            { op: 'add_gen', args: { id: 'dep', payload: p2, sig: p2, pins: {} } },
          ],
        }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    const ops = (journal[0].args as { ops: Array<{ args: { expect_active?: Hash | null } }> }).ops
    expect(ops[0].args.expect_active).toBe(active)
    expect(ops[1].args.expect_active).toBe(p1)
  })

  it('batch 内 set_active 后 add_gen：expect_active 取 set_active 推进后的 active', async () => {
    const active = 'a'.repeat(64)
    const p1 = 'b'.repeat(64)
    const p2 = 'c'.repeat(64)
    const world = worldOf({
      [active]: put({ body: { gen: 1 } }),
      [p1]: put({ body: { gen: 2 } }),
      [p2]: put({ body: { gen: 3 } }),
    })
    const schema = 's'.repeat(64)
    world.ids['dep'] = {
      id: 'dep',
      schema,
      gens: [
        {
          seq: 0,
          payload: active,
          pins: {},
          sig: schema,
          adopted: { at: 1, by: 'seed', write: active },
        },
        {
          seq: 1,
          payload: p1,
          pins: {},
          sig: schema,
          adopted: { at: 1, by: 'seed', write: p1 },
        },
      ],
      active,
      born: { at: 1, by: 'seed' },
    }
    const journal: Entry[] = []
    const outcome = await runSubmission({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [
        writeD('batch', {
          ops: [
            { op: 'set_active', args: { id: 'dep', active: p1 } },
            { op: 'add_gen', args: { id: 'dep', payload: p2, sig: p2, pins: {} } },
          ],
        }),
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'tester',
      now: () => 1,
      onRound: (entries) => journal.push(...entries),
    })
    expect(outcome.status).toBe('done')
    expect(journal).toHaveLength(1)
    const ops = (journal[0].args as { ops: Array<{ args: { expect_active?: Hash | null } }> }).ops
    expect(ops[1].args.expect_active).toBe(p1)
  })
})
