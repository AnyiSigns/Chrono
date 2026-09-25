import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const program: Program = {
  terms: {
    'terms/route.json': t.call('terms/route.result.json', [
      t.fold(
        t.ctx(['rules']),
        t.lit(null),
        'terms/route.step.json',
      ),
    ]),
    'terms/route.step.json': t.if(
      t.pred('eq', t.get(t.arg(1), ['when']), t.ctx(['input'])),
      t.if(
        t.pred('eq', t.arg(0), t.lit(null)),
        t.arg(1),
        t.arg(0),
      ),
      t.arg(0),
    ),
    'terms/route.result.json': t.if(
      t.pred('eq', t.arg(0), t.lit(null)),
      t.ctx(['default']),
      t.get(t.arg(0), ['then']),
    ),
  },
}

describe('route', () => {
  it('returns the first matching rule result', () => {
    expect(
      runTerm(program, 'terms/route.json', {
        ctx: {
          rules: [
            { when: 'a', then: 'A' },
            { when: 'b', then: 'B' },
          ],
          input: 'b',
          default: 'D',
        },
      }),
    ).toEqual({ ok: true, value: 'B' })
  })

  it('keeps the first result when multiple rules match', () => {
    expect(
      runTerm(program, 'terms/route.json', {
        ctx: {
          rules: [
            { when: 'b', then: 'first' },
            { when: 'b', then: 'second' },
          ],
          input: 'b',
          default: 'D',
        },
      }),
    ).toEqual({ ok: true, value: 'first' })
  })

  it('returns the default when no rule matches', () => {
    expect(
      runTerm(program, 'terms/route.json', {
        ctx: {
          rules: [
            { when: 'a', then: 'A' },
            { when: 'b', then: 'B' },
          ],
          input: 'z',
          default: 'D',
        },
      }),
    ).toEqual({ ok: true, value: 'D' })
  })

  it('returns the default when the rule list is empty', () => {
    expect(
      runTerm(program, 'terms/route.json', {
        ctx: { rules: [], input: 'a', default: 'D' },
      }),
    ).toEqual({ ok: true, value: 'D' })
  })
})
