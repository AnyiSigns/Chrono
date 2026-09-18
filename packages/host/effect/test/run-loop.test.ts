import { describe, expect, it } from 'vitest'
import { H } from '../../../kernel/index.ts'
import { runRound } from '../run-loop.ts'
import type { RoundRouter } from '../route.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Directive, EffResult, Entry, Hash, Head, Json, World } from '../../../kernel/index.ts'

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000
const LIMITS = { gas: 1_000_000, depth: 64 }

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
  it('空 directives → idle；lastAuditHash 为 null', async () => {
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
    expect(outcome.lastAuditHash).toBeNull()
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

  it('eval 挂起但无 router / 属主 → refused，不落业务 journal，审计已落', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const head: Head = { ...EMPTY_HEAD }
    const audits: Entry[] = []
    const outcome = await runRound({
      world,
      head,
      directives: [evalDirective(termHash)],
      owners: ['toy-owner'],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      onAudit: (entry) => audits.push(entry),
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(audits).toHaveLength(1)
    expect(outcome.lastAuditHash).not.toBeNull()
    expect(outcome.lastAuditHash).toBe(H(audits[0].args as Json))
    // 审计哈希 = 实际落链 def 键
    const audit = audits[0].args as { body: { result: { ok: boolean; error: string } } }
    expect(audit.body.result.ok).toBe(false)
    expect(audit.body.result.error).toBe('not_loaded')
  })

  it('eval 挂起 + router：回灌端点值到观测，审计先于 done', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', { n: 1 }]] } },
      ids: {},
    }
    const audits: Entry[] = []
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
      onAudit: (entry) => audits.push(entry),
    })
    expect(outcome.status).toBe('done')
    expect(audits).toHaveLength(1)
    expect(outcome.lastAuditHash).not.toBeNull()
    expect(outcome.observations).toEqual([
      {
        kind: 'eval',
        entry: termHash,
        ok: true,
        value: { port: 'toy.echo', method: 'echo', args: { n: 1 } },
      },
    ])
    // 审计快照的 result 与回灌一致
    const auditResult = (audits[0].args as { body: { result: Json } }).body.result
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
    const audits: Entry[] = []
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
      onAudit: (entry) => audits.push(entry),
    })
    expect(outcome.status).toBe('done')
    expect(calls).toEqual([1, 2])
    expect(audits).toHaveLength(2)
    expect(outcome.observations).toEqual([{ kind: 'eval', entry: termHash, ok: true, value: 2 }])
  })

  it('属主缺失（owners[index] 为空）→ 不路由，审计记 not_loaded 且整体 refused:eff_error', async () => {
    const termHash = 'th'.repeat(32)
    const world: World = {
      defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]] } },
      ids: {},
    }
    const audits: Entry[] = []
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
      onAudit: (entry) => audits.push(entry),
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(audits).toHaveLength(1)
    const auditBody = (audits[0].args as unknown as { body: { result: EffResult } }).body
    expect(auditBody.result).toEqual({ ok: false, error: 'not_loaded' })
    expect(outcome.observations[outcome.observations.length - 1]).toMatchObject({
      kind: 'refused',
      reasons: ['eff_error'],
    })
  })
})
