import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const termPath = 'terms/route.json'

const program: Program = {
  terms: {
    [termPath]: t.let(
      [
        [
          'matched',
          t.find(
            t.ctx(['rules']),
            t.or(
              t.pred('eq', t.get(t.arg(1), ['when']), t.ctx(['input'])),
              t.pred('eq', t.get(t.arg(1), ['always']), t.lit(true)),
            ),
            t.get(t.arg(1), ['then']),
          ),
        ],
      ],
      t.if(
        t.pred('eq', t.bind('matched'), t.lit(null)),
        t.ctx(['default']),
        t.bind('matched'),
      ),
    ),
  },
}

type RoutingContext = {
  input: string
  rules: Array<{ when: string; always?: boolean; then: string }>
  default: string
}

const runRoute = (ctx: RoutingContext) => runTerm(program, termPath, { ctx })

describe('routing table', () => {
  it('matches when, with always omitted', () => {
    expect(
      runRoute({
        input: 'read',
        rules: [
          { when: 'read', then: 'reader' },
          { when: 'write', then: 'writer' },
        ],
        default: 'denied',
      }),
    ).toEqual({ ok: true, value: 'reader' })
  })

  it('matches an always rule', () => {
    expect(
      runRoute({
        input: 'delete',
        rules: [
          { when: 'read', always: true, then: 'auditor' },
          { when: 'delete', always: false, then: 'deleter' },
        ],
        default: 'denied',
      }),
    ).toEqual({ ok: true, value: 'auditor' })
  })

  it('uses the first rule when multiple rules match', () => {
    expect(
      runRoute({
        input: 'write',
        rules: [
          { when: 'read', always: true, then: 'first' },
          { when: 'write', always: true, then: 'second' },
        ],
        default: 'denied',
      }),
    ).toEqual({ ok: true, value: 'first' })
  })

  it('uses the default when no rule matches', () => {
    expect(
      runRoute({
        input: 'read',
        rules: [
          { when: 'write', always: false, then: 'writer' },
          { when: 'delete', always: false, then: 'deleter' },
        ],
        default: 'denied',
      }),
    ).toEqual({ ok: true, value: 'denied' })
  })

  it('uses the default for an empty rule table', () => {
    expect(
      runRoute({
        input: 'read',
        rules: [],
        default: 'denied',
      }),
    ).toEqual({ ok: true, value: 'denied' })
  })
})
