import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const termPath = 'terms/author-orchestrate.json'

const run = t.if(
  t.pred(
    'eq',
    t.eff('auth', 'check', t.lit({ resource: 'document' })),
    t.lit(true),
  ),
  t.eff('data', 'fetch', t.lit({ id: 7 })),
  t.lit('denied'),
)

const program: Program = {
  terms: { [termPath]: run },
  implements: ['auth', 'data'],
  methods: {
    auth: ['check'],
    data: ['fetch'],
  },
}

describe('author orchestrate', () => {
  it('emits both effects in order and consumes the fetch effect exactly once', () => {
    expect(runTerm(program, termPath, { effects: [true, 'payload'] })).toEqual({
      ok: true,
      value: 'payload',
    })
  })

  it('does not emit or consume fetch when auth denies', () => {
    expect(runTerm(program, termPath, { effects: [false] })).toEqual({
      ok: true,
      value: 'denied',
    })
  })
})
