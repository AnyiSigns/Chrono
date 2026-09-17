import { describe, expect, it } from 'vitest'
import { runRound } from '../run-loop.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Hash = string
type Head = { seq: number; hash: Hash | null }
type Op = 'put' | 'add_identity' | 'add_gen' | 'set_active' | 'retire' | 'fork' | 'graft' | 'batch' | 'note' | 'snapshot'
type Directive =
  | { kind: 'eval'; entry: Hash; args: Json; ctx: Json }
  | { kind: 'write'; request: { id: string; op: Op; target: { expect_pos: Hash | null }; args: Json; by: string } }
  | { kind: 'extern'; payload: Json }

const EMPTY_HEAD: Head = { seq: -1, hash: null }
const NOW = 1000
const LIMITS = { gas: 1_000_000, depth: 64 }

describe('通用 run loop runRound', () => {
  it('空 directives → idle', () => {
    const outcome = runRound({
      world: { defs: {}, ids: {} },
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

  it('单条 write → done 且落账', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const outcome = runRound({
      world,
      head,
      directives: [{ kind: 'write', request: { id: 'w1', op: 'put', target: { expect_pos: head.hash }, args: { body: { v: 1 } }, by: 'client' } }],
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

  it('eval 挂起（eff not_loaded）→ refused，不落业务 journal，但审计已落', () => {
    const termHash = 'th'.repeat(32)
    const world = { defs: { [termHash]: { body: ['eff', 'toy.echo', 'echo', ['c', 1]], pins: {}, sig: 'sig'.repeat(64) } }, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const outcome = runRound({
      world,
      head,
      directives: [{ kind: 'eval', entry: termHash, args: null, ctx: null as Json }],
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
      onAudit: (entry) => {
        expect(entry.op).toBe('put')
      },
    })
    expect(outcome.status).toBe('refused')
    expect(outcome.journal).toEqual([])
    expect(outcome.observations.some((o) => (o as Json & { kind: string }).kind === 'refused')).toBe(true)
  })

  it('waiting 续跑：results 只增不改，同 run_id / now / directives', () => {
    const termHash = 'th'.repeat(32)
    const world = { defs: { [termHash]: { body: ['c', 1], pins: {}, sig: 'sig'.repeat(64) } }, ids: {} }
    const head: Head = { ...EMPTY_HEAD }
    const directives: Directive[] = [{ kind: 'eval', entry: termHash, args: null, ctx: null as Json }]
    const outcome = runRound({
      world,
      head,
      directives,
      caps: {},
      limits: LIMITS,
      initiator: 'client',
      now: NOW,
    })
    expect(outcome.status).toBe('done')
    expect(outcome.observations).toHaveLength(1)
    expect((outcome.observations[0] as Json & { kind: string }).kind).toBe('eval')
  })
})
