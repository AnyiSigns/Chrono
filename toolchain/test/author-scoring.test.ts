import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const aggregate = t.obj({
  total: t.mul(
    t.ctx(['weight']),
    t.fold(
      t.arg(0),
      t.lit(0),
      t.add(t.arg(0), t.get(t.arg(1), ['score'])),
    ),
  ),
  best: t.argmin(t.arg(0), ['score']),
  count: t.fold(t.arg(0), t.lit(0), t.add(t.arg(0), t.lit(1))),
})

const program: Program = {
  terms: {
    'terms/score.json': t.call(aggregate, [
      t.eff('scorer', 'candidates', t.bag({})),
    ]),
  },
  implements: ['scorer'],
  methods: {
    scorer: ['candidates'],
  },
}

function score(
  candidates: Array<{ id: string; score: number }>,
  weight: number,
) {
  return runTerm(program, 'terms/score.json', {
    ctx: { weight },
    effects: [candidates],
    trace: true,
  })
}

describe('scorer aggregate', () => {
  it('aggregates multiple candidates and selects the minimum score', () => {
    expect(
      score(
        [
          { id: 'warm', score: 4 },
          { id: 'cold', score: -1 },
          { id: 'mild', score: 3 },
        ],
        0.5,
      ),
    ).toEqual({
      ok: true,
      value: {
        total: 3,
        best: { id: 'cold', score: -1 },
        count: 3,
      },
      trace: [{ port: 'scorer', method: 'candidates', args: {} }],
    })
  })

  it('aggregates a single candidate', () => {
    expect(score([{ id: 'only', score: 4 }], 2.5)).toEqual({
      ok: true,
      value: {
        total: 10,
        best: { id: 'only', score: 4 },
        count: 1,
      },
      trace: [{ port: 'scorer', method: 'candidates', args: {} }],
    })
  })

  it('returns a neutral aggregate for no candidates', () => {
    expect(score([], 3)).toEqual({
      ok: true,
      value: {
        total: 0,
        best: null,
        count: 0,
      },
      trace: [{ port: 'scorer', method: 'candidates', args: {} }],
    })
  })
})
