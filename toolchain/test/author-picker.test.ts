import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const CANDIDATES = [
  { id: 'a', score: 5 },
  { id: 'b', score: 2 },
  { id: 'c', score: 9 },
]

function stepFor(kind: 'min' | 'max') {
  const op = kind === 'min' ? 'lt' : 'gt'
  return t.let(
    [
      ['s1', t.get(t.arg(1), ['score'])],
      ['s0', t.get(t.arg(0), ['score'])],
    ],
    t.if(
      t.pred('eq', t.arg(0), t.lit(null)),
      t.arg(1),
      t.if(t.pred(op, t.bind('s1'), t.bind('s0')), t.arg(1), t.arg(0)),
    ),
  )
}

function programFor(kind: 'min' | 'max'): Program {
  const stepPath = `terms/${kind}.step.json`
  return {
    implements: ['picker'],
    methods: { picker: ['candidates'] },
    terms: {
      [stepPath]: stepFor(kind),
      [`terms/${kind}.json`]: t.fold(
        t.eff('picker', 'candidates', t.lit([])),
        t.lit(null),
        stepPath,
      ),
    },
  }
}

describe('picker score judgments', () => {
  it('minByScore picks the smallest score', () => {
    const r = runTerm(programFor('min'), 'terms/min.json', { effects: [CANDIDATES] })
    expect(r).toEqual({ ok: true, value: { id: 'b', score: 2 } })
  })

  it('minByScore returns null on empty list', () => {
    const r = runTerm(programFor('min'), 'terms/min.json', { effects: [[]] })
    expect(r).toEqual({ ok: true, value: null })
  })

  it('maxByScore picks the largest score', () => {
    const r = runTerm(programFor('max'), 'terms/max.json', { effects: [CANDIDATES] })
    expect(r).toEqual({ ok: true, value: { id: 'c', score: 9 } })
  })

  it('maxByScore returns null on empty list', () => {
    const r = runTerm(programFor('max'), 'terms/max.json', { effects: [[]] })
    expect(r).toEqual({ ok: true, value: null })
  })
})
