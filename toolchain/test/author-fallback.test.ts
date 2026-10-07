import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const memberStep = t.if(
  t.pred('ne', t.arg(0), t.lit(null)),
  t.if(t.pred('eq', t.arg(1), t.arg(0)), t.lit(null), t.arg(0)),
  t.arg(0),
)

const pickStep = t.if(
  t.pred('ne', t.arg(0), t.lit(null)),
  t.arg(0),
  t.fold(t.ctx(['failed']), t.arg(1), 'terms/member.step.json'),
)

const pick = t.let(
  [['candidates', t.eff('picker', 'candidates', t.lit([]))]],
  t.fold(t.bind('candidates'), t.lit(null), 'terms/pick.step.json'),
)

const program: Program = {
  terms: {
    'terms/member.step.json': memberStep,
    'terms/pick.step.json': pickStep,
    'terms/pick.json': pick,
  },
  implements: ['picker'],
  methods: { picker: ['candidates'] },
}

describe('fallback selection', () => {
  it('selects the first candidate that has not failed', () => {
    expect(
      runTerm(program, 'terms/pick.json', {
        ctx: { failed: ['m1'] },
        effects: [['m1', 'm2', 'm3']],
      }),
    ).toEqual({ ok: true, value: 'm2' })
  })

  it('returns null when every candidate has failed', () => {
    expect(
      runTerm(program, 'terms/pick.json', {
        ctx: { failed: ['m1', 'm2', 'm3'] },
        effects: [['m1', 'm2', 'm3']],
      }),
    ).toEqual({ ok: true, value: null })
  })

  it('selects the first candidate when none have failed', () => {
    expect(
      runTerm(program, 'terms/pick.json', {
        ctx: { failed: [] },
        effects: [['m1', 'm2', 'm3']],
      }),
    ).toEqual({ ok: true, value: 'm1' })
  })
})
