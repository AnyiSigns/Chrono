import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

type Rule = { when: string; always?: boolean; then: string }

type RoutingContext = {
  input: string
  rules: Rule[]
  default: string
}

const program: Program = {
  terms: {
    'terms/route.json': t.findOr(
      t.ctx(['rules']),
      t.or(
        t.pred('eq', t.get(t.arg(1), ['when']), t.ctx(['input'])),
        t.pred('eq', t.getOr(t.arg(1), ['always'], t.lit(false)), t.lit(true)),
      ),
      t.get(t.arg(1), ['then']),
      t.ctx(['default']),
    ),
  },
}

const route = (ctx: RoutingContext) => runTerm(program, 'terms/route.json', { ctx })

describe('routing table', () => {
  it('returns then for a matching when', () => {
    const ctx: RoutingContext = {
      input: 'start',
      rules: [
        { when: 'stop', then: 'stop-handler' },
        { when: 'start', then: 'start-handler' },
      ],
      default: 'fallback',
    }

    expect(Object.hasOwn(ctx.rules[0], 'always')).toBe(false)
    expect(route(ctx)).toEqual({ ok: true, value: 'start-handler' })
  })

  it('returns then for always', () => {
    expect(
      route({
        input: 'anything',
        rules: [{ when: 'never', always: true, then: 'always-handler' }],
        default: 'fallback',
      }),
    ).toEqual({ ok: true, value: 'always-handler' })
  })

  it('returns the first matching rule', () => {
    expect(
      route({
        input: 'start',
        rules: [
          { when: 'start', always: false, then: 'first' },
          { when: 'other', always: true, then: 'second' },
          { when: 'start', then: 'third' },
        ],
        default: 'fallback',
      }),
    ).toEqual({ ok: true, value: 'first' })
  })

  it('returns default when no rule matches', () => {
    expect(
      route({
        input: 'unknown',
        rules: [
          { when: 'start', then: 'start-handler' },
          { when: 'stop', always: false, then: 'stop-handler' },
        ],
        default: 'fallback',
      }),
    ).toEqual({ ok: true, value: 'fallback' })
  })

  it('returns default for an empty rule table', () => {
    expect(route({ input: 'start', rules: [], default: 'fallback' })).toEqual({
      ok: true,
      value: 'fallback',
    })
  })
})
