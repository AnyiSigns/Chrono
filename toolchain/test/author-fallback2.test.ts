import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const entry = 'terms/fallback.json'
const selectionStep = 'terms/selection-step.json'
const membership = 'terms/membership.json'
const membershipStep = 'terms/membership-step.json'

const program: Program = {
  terms: {
    [entry]: t.call(
      t.if(t.pred('eq', t.arg(0), t.lit(null)), t.arg(1), t.arg(0)),
      [
        t.fold(t.eff('picker', 'candidates', t.lit([])), t.lit(null), selectionStep),
        t.ctx(['default']),
      ],
    ),
    [selectionStep]: t.if(
      t.not(
        t.get(
          t.call(membership, [t.ctx(['failed']), t.arg(1)]),
          ['found'],
        ),
      ),
      t.if(t.pred('eq', t.arg(0), t.lit(null)), t.arg(1), t.arg(0)),
      t.arg(0),
    ),
    [membership]: t.fold(
      t.arg(0),
      t.obj({ target: t.arg(1), found: t.lit(false) }),
      membershipStep,
    ),
    [membershipStep]: t.if(
      t.get(t.arg(0), ['found']),
      t.arg(0),
      t.if(
        t.pred('eq', t.arg(1), t.get(t.arg(0), ['target'])),
        t.obj({ target: t.get(t.arg(0), ['target']), found: t.lit(true) }),
        t.arg(0),
      ),
    ),
  },
  methods: {
    picker: ['candidates'],
  },
}

function run(candidates: string[], failed: string[], defaultValue: string) {
  return runTerm(program, entry, {
    ctx: { failed, default: defaultValue },
    effects: [candidates],
    trace: true,
  })
}

describe('fallback chain', () => {
  it('returns the first available candidate', () => {
    expect(run(['primary', 'secondary'], ['unrelated'], 'fallback')).toEqual({
      ok: true,
      value: 'primary',
      trace: [{ port: 'picker', method: 'candidates', args: [] }],
    })
  })

  it('skips a failed first candidate and returns the second', () => {
    expect(run(['primary', 'secondary'], ['primary'], 'fallback')).toEqual({
      ok: true,
      value: 'secondary',
      trace: [{ port: 'picker', method: 'candidates', args: [] }],
    })
  })

  it('returns the default when all candidates have failed', () => {
    expect(run(['primary', 'secondary'], ['primary', 'secondary'], 'fallback')).toEqual({
      ok: true,
      value: 'fallback',
      trace: [{ port: 'picker', method: 'candidates', args: [] }],
    })
  })

  it('returns the default when the candidate list is empty', () => {
    expect(run([], ['primary'], 'fallback')).toEqual({
      ok: true,
      value: 'fallback',
      trace: [{ port: 'picker', method: 'candidates', args: [] }],
    })
  })
})
