import { describe, expect, it, afterEach } from 'vitest'
import { ServiceChannelError } from '../../service-link.ts'
import { WorldWriter } from '../../writer.ts'
import type { SyncResult, WorldState } from '../../writer.ts'
import { runRound } from '../run-loop.ts'
import { resetFatal } from '../fatal.ts'
import type { AuditDraft } from '../../audit.ts'
import type { RoundRouter } from '../route.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Directive, EffResult, Entry, Hash, Head, Json, World } from '../../../kernel/index.ts'

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000
const LIMITS = { gas: 1_000_000, depth: 64 }

afterEach(() => {
  // 落账致命态是进程级：每个用例后复位，避免污染同文件其余用例
  resetFatal()
})

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function evalDirective(entry: Hash): Directive {
  return { kind: 'eval', entry, args: null, ctx: null }
}

function fakeRouter(
  call: (port: string, method: string, args: Json) => Promise<Json>,
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
  return { resolve: () => ({ ok: true, row }) }
}

describe('通用 run loop runRound', () => {
  it('空 directives → idle，不产审计', async () => {
    const outcome = await runRound({
      world: emptyWorld(),
      head: { ...EMPTY_HEAD },
      directives: [],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
    })
    expect(outcome.status).toBe('idle')
    expect(outcome.journal).toEqual([])
    expect(outcome.observations).toEqual([])
  })

  it('单条 write → done 且落 journal', async () => {
    const world = emptyWorld()
    const head: Head = { ...EMPTY_HEAD }
    const outcome = await runRound({
      world,
      head,
      directives: [
        {
          kind: 'write',
          request: {
            id: 'w1',
            op: 'put',
            target: { expect_pos: head.hash },
            args: { body: { v: 1 } },
            by: 'client',
          },
        },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
    })
    expect(outcome.status).toBe('done')
    expect(outcome.journal).toHaveLength(1)
    expect(outcome.journal[0].op).toBe('put')
    expect(outcome.head.hash).not.toBeNull()
  })

  it('同轮多条 write → refused:bad_directive，不落 journal、不推进 head', async () => {
    const writer = new WorldWriter({ world: emptyWorld(), head: { ...EMPTY_HEAD } })
    const outcome = await runRound({
      writer,
      directives: [
        {
          kind: 'write',
          request: {
            id: 'w1',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { a: 1 } },
            by: 'client',
          },
        },
        {
          kind: 'write',
          request: {
            id: 'w2',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { b: 2 } },
            by: 'client',
          },
        },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(outcome.observations).toEqual([{ kind: 'refused', reasons: ['bad_directive'] }])
    expect(writer.snapshot().head).toEqual({ ...EMPTY_HEAD })
    expect(Object.keys(writer.snapshot().world.defs)).toEqual([])
  })

  it('eval 挂起但无 router / 属主 → refused，不落业务 journal，审计已落', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const head: Head = { ...EMPTY_HEAD }
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      world,
      head,
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(audits).toHaveLength(1)
    const audit = audits[0].body as { result: { ok: boolean; error: string } }
    expect(audit.result.ok).toBe(false)
    expect(audit.result.error).toBe('not_loaded')
  })

  it('eval 挂起 + router：回灌端点值到观测，审计先于 done', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router: fakeRouter(async (port, method, args) => ({ port, method, args })),
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(1)
    expect(outcome.observations).toEqual([
      {
        kind: 'eval',
        entry: termHash,
        ok: true,
        value: { port: 'toy.echo', method: 'echo', args: { n: 1 } },
      },
    ])
    // 审计草稿的 result 与回灌一致
    const auditResult = (audits[0].body as { result: Json }).result
    expect(auditResult).toEqual({
      ok: true,
      value: { port: 'toy.echo', method: 'echo', args: { n: 1 } },
    })
  })

  it('单 directive 内多次挂起：逐次执行、results 只增、发出者可定位', async () => {
    const stepHash = 'ab'.repeat(32)
    const termHash = 'cd'.repeat(32)
    const world: World = {
      defs: {
        [stepHash]: { body: ['eff', 'toy.echo', 'echo', ['v', 1]] },
        [termHash]: { body: ['fold', ['c', [1, 2]], ['c', 0], ['c', stepHash]] },
      },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const calls: Json[] = []
    const outcome = await runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router: fakeRouter(async (_port, _method, args) => {
        calls.push(args)
        return args
      }),
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('done')
    expect(calls).toEqual([1, 2])
    expect(audits).toHaveLength(2)
    expect(outcome.observations).toEqual([{ kind: 'eval', entry: termHash, ok: true, value: 2 }])
  })

  it('audit:false（只读）：效果照常回灌但不落审计、不推进 head', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      audit: false,
      router: fakeRouter(async (port, method, args) => ({ port, method, args })),
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toEqual([])
    expect(outcome.head).toEqual(EMPTY_HEAD)
    expect(outcome.observations).toEqual([
      {
        kind: 'eval',
        entry: termHash,
        ok: true,
        value: { port: 'toy.echo', method: 'echo', args: { n: 1 } },
      },
    ])
  })

  it('audit:false（只读）：内核产出的业务写不上账、不推进 head（journal 仍上浮）', async () => {
    const rounds: Entry[][] = []
    const outcome = await runRound({
      world: emptyWorld(),
      head: { ...EMPTY_HEAD },
      directives: [
        {
          kind: 'write',
          request: {
            id: 'w1',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { v: 1 } },
            by: 'client',
          },
        },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      audit: false,
      onRound: (entries) => rounds.push(entries),
    })
    expect(outcome.status).toBe('done')
    expect(outcome.journal).toHaveLength(1)
    expect(rounds).toEqual([])
    expect(outcome.head).toEqual(EMPTY_HEAD)
  })

  it('audit:false（只读）：在途取消按 cancelled 收口但不落审计', async () => {
    const termHash = 'ef'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const controller = new AbortController()
    const router: RoundRouter = {
      resolve: () => ({
        ok: true,
        row: {
          impl: 'toy',
          gen: 'g'.repeat(64),
          cap: 'toy.echo',
          method: 'echo',
          transport: 'stdio',
          pid: 1,
          link: {
            call: () =>
              new Promise((_resolve, reject) => {
                controller.signal.addEventListener(
                  'abort',
                  () => reject(new ServiceChannelError('cancelled')),
                  { once: true },
                )
              }),
          },
        } as unknown as EndpointRow,
      }),
    }
    const pending = runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      audit: false,
      router,
      signal: controller.signal,
      onAudit: (draft) => audits.push(draft),
    })
    await Promise.resolve()
    controller.abort()
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
    expect(audits).toEqual([])
    expect(outcome.head).toEqual(EMPTY_HEAD)
  })

  it('取消（在途 abort）：status=cancelled、审计 outcome=cancelled、不续跑', async () => {
    const termHash = 'ef'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const controller = new AbortController()
    const router: RoundRouter = {
      resolve: () => ({
        ok: true,
        row: {
          impl: 'toy',
          gen: 'g'.repeat(64),
          cap: 'toy.echo',
          method: 'echo',
          transport: 'stdio',
          pid: 1,
          link: {
            call: () =>
              new Promise((_resolve, reject) => {
                controller.signal.addEventListener(
                  'abort',
                  () => reject(new ServiceChannelError('cancelled')),
                  { once: true },
                )
              }),
          },
        } as unknown as EndpointRow,
      }),
    }
    const pending = runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router,
      signal: controller.signal,
      onAudit: (draft) => audits.push(draft),
    })
    await Promise.resolve()
    controller.abort()
    const outcome = await pending
    expect(outcome.status).toBe('cancelled')
    expect(outcome.journal).toEqual([])
    expect(audits).toHaveLength(1)
    const body = audits[0].body as unknown as { result: EffResult; outcome: string }
    expect(body.result).toEqual({ ok: false, error: 'cancelled' })
    expect(body.outcome).toBe('cancelled')
  })

  it('取消（挂起前已 abort）：不跑内核、不落审计', async () => {
    const controller = new AbortController()
    controller.abort()
    const termHash = 'ef'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router: fakeRouter(async () => null),
      signal: controller.signal,
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('cancelled')
    expect(outcome.journal).toEqual([])
    expect(audits).toEqual([])
  })

  it('writer 与 world/head 同时给出 → 立即抛错（不静默取一）', async () => {
    const writer = new WorldWriter({ world: emptyWorld(), head: { ...EMPTY_HEAD } })
    await expect(
      runRound({
        writer,
        world: emptyWorld(),
        head: { ...EMPTY_HEAD },
        directives: [],
        caps: {},
        limits: LIMITS,
        initiator: 'client',
        now: NOW,
      }),
    ).rejects.toThrow('not both')
  })

  it('writer 与 world+head 都缺 → 立即抛错（fail-closed）', async () => {
    await expect(
      runRound({
        directives: [],
        caps: {},
        limits: LIMITS,
        initiator: 'client',
        now: NOW,
      }),
    ).rejects.toThrow('provide either writer')
  })

  it('效果路由用本 run 锚定世界：writer 快照已前进也不改路由世界', async () => {
    const termHash = 'th'.repeat(32)
    const anchored: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const decoy: World = { defs: {}, ids: {} }
    // 快照故意返回另一个世界：路由若错用快照即会拿到 decoy
    class SnapshotDecoyWriter extends WorldWriter {
      override snapshot(): { world: World; head: Head } {
        return { world: decoy, head: { ...EMPTY_HEAD } }
      }
    }
    const writer = new SnapshotDecoyWriter({ world: anchored, head: { ...EMPTY_HEAD } })
    let sawWorld: World | undefined
    const outcome = await runRound({
      writer,
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router: {
        resolve: (world) => {
          sawWorld = world
          return { ok: false, error: 'not_loaded' }
        },
      },
    })
    expect(sawWorld).toBe(anchored)
    expect(sawWorld).not.toBe(decoy)
    expect(outcome.status).toBe('refused')
  })

  it('属主缺失（owners[index] 为空）→ 不路由，审计记 not_loaded 且整体 refused:eff_error', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      world,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: [undefined],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router: fakeRouter(async () => null),
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(audits).toHaveLength(1)
    const auditBody = audits[0].body as unknown as { result: EffResult }
    expect(auditBody.result).toEqual({ ok: false, error: 'not_loaded' })
    expect(outcome.observations[outcome.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['eff_error'],
    })
  })

  it('落账失败 fail-stop：onRound 抛错 → 不推进内存、后续 run 入口即拒', async () => {
    const writer = new WorldWriter({ world: emptyWorld(), head: { ...EMPTY_HEAD } })
    await expect(
      runRound({
        writer,
        directives: [
          {
            kind: 'write',
            request: {
              id: 'w1',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { v: 1 } },
              by: 'client',
            },
          },
        ],
        caps: {},
        limits: LIMITS,
        initiator: 'client',
        now: NOW,
        onRound: () => {
          throw new Error('disk full')
        },
      }),
    ).rejects.toThrow('disk full')
    // 落盘失败不得切换内存世界 / 链头
    expect(Object.keys(writer.snapshot().world.defs)).toEqual([])
    expect(writer.snapshot().head).toEqual({ ...EMPTY_HEAD })
    // 致命态：后续 run 不再接受提交
    await expect(
      runRound({ writer, directives: [], caps: {}, limits: LIMITS, initiator: 'client', now: NOW }),
    ).rejects.toThrow('persist_failed')
  })

  it('审计落侧存失败 fail-stop：onAudit 抛错 → 世界 / 链头不动', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const writer = new WorldWriter({ world, head: { ...EMPTY_HEAD } })
    await expect(
      runRound({
        writer,
        directives: [evalDirective(termHash)],
        owners: ['toy-owner'],
        caps: {},
        limits: LIMITS,
        initiator: 'client',
        now: NOW,
        router: fakeRouter(async () => null),
        onAudit: () => {
          throw new Error('journal locked')
        },
      }),
    ).rejects.toThrow('journal locked')
    expect(writer.snapshot().head).toEqual({ ...EMPTY_HEAD })
    // 审计不进世界（只剩初始 term def）
    expect(Object.keys(writer.snapshot().world.defs)).toEqual([termHash])
  })

  it('段内复核取消：排到落账段才 abort → 不落该轮业务写', async () => {
    const controller = new AbortController()
    class AbortOnRunWriter extends WorldWriter {
      override run<T>(fn: (state: WorldState) => SyncResult<T>): Promise<T> {
        controller.abort()
        return super.run(fn)
      }
    }
    const writer = new AbortOnRunWriter({ world: emptyWorld(), head: { ...EMPTY_HEAD } })
    const outcome = await runRound({
      writer,
      directives: [
        {
          kind: 'write',
          request: {
            id: 'w1',
            op: 'put',
            target: { expect_pos: null },
            args: { body: { v: 1 } },
            by: 'client',
          },
        },
      ],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      signal: controller.signal,
    })
    expect(outcome.status).toBe('cancelled')
    expect(outcome.journal).toEqual([])
    expect(writer.snapshot().head).toEqual({ ...EMPTY_HEAD })
    expect(Object.keys(writer.snapshot().world.defs)).toEqual([])
  })

  it('方法级超时与路由同解析世界：resolutionWorld 提供活世界时按它取声明', async () => {
    const termHash = 'ab'.repeat(32)
    const schemaOld = 's1'.repeat(32)
    const schemaLive = 's2'.repeat(32)
    const active = 'x'.repeat(64)
    const identity = (schema: Hash): World['ids'][string] => ({
      id: 'toy',
      schema,
      gens: [],
      active,
      born: { at: 1, by: 'seed' },
    })
    const anchored: World = {
      defs: {
        [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] },
        [schemaOld]: { body: { type: 'object' } },
      },
      ids: { toy: identity(schemaOld) },
    }
    // 活世界给目标身份的 schema 声明方法级超时 1234ms
    const live: World = {
      defs: {
        [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] },
        [schemaLive]: { body: { type: 'object', method_timeouts: { echo: 1234 } } },
      },
      ids: { toy: identity(schemaLive) },
    }
    const timeouts: number[] = []
    const row = {
      impl: 'toy',
      gen: 'g'.repeat(64),
      cap: 'toy.echo',
      method: 'echo',
      transport: 'stdio',
      pid: 1,
      link: {
        call: async (_port: string, _method: string, _args: Json, timeoutMs: number) => {
          timeouts.push(timeoutMs)
          return { ok: true, value: null }
        },
      },
    } as unknown as EndpointRow
    const router: RoundRouter = {
      resolve: () => ({ ok: true, row }),
      resolutionWorld: () => live,
    }
    const outcome = await runRound({
      world: anchored,
      head: { ...EMPTY_HEAD },
      directives: [evalDirective(termHash)],
      owners: ['toy'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      router,
    })
    expect(outcome.status).toBe('done')
    expect(timeouts).toEqual([1234])
  })
})
