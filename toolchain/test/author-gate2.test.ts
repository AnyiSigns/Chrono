import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const ENTRY = 'terms/policy.guard.json'

type Policy = {
  deny: string[]
  allow: string[]
  review: boolean
}

const evaluatePolicy = t.if(
  t.in(t.ctx(['tool']), t.get(t.arg(0), ['deny'])),
  t.lit('deny'),
  t.if(
    t.in(t.ctx(['tool']), t.get(t.arg(0), ['allow'])),
    t.lit('allow'),
    t.if(t.get(t.arg(0), ['review']), t.lit('review'), t.lit('reject')),
  ),
)

const program: Program = {
  terms: {
    [ENTRY]: t.call(evaluatePolicy, [t.eff('guard', 'policy', t.bag({}))]),
  },
  implements: ['guard'],
  methods: { guard: ['policy'] },
}

function decide(policy: Policy, tool: string) {
  return runTerm(program, ENTRY, { ctx: { tool }, effects: [policy] })
}

describe('guard policy gate', () => {
  it('denies a denied tool', () => {
    expect(decide({ deny: ['fs.write'], allow: [], review: false }, 'fs.write')).toEqual({
      ok: true,
      value: 'deny',
    })
  })

  it('allows an explicitly allowed tool', () => {
    expect(decide({ deny: [], allow: ['fs.read'], review: true }, 'fs.read')).toEqual({
      ok: true,
      value: 'allow',
    })
  })

  it('reviews an unlisted tool when review is required', () => {
    expect(decide({ deny: ['fs.write'], allow: ['fs.read'], review: true }, 'net.fetch')).toEqual({
      ok: true,
      value: 'review',
    })
  })

  it('rejects an unlisted tool when no fallback applies', () => {
    expect(decide({ deny: ['fs.write'], allow: ['fs.read'], review: false }, 'net.fetch')).toEqual({
      ok: true,
      value: 'reject',
    })
  })
})
