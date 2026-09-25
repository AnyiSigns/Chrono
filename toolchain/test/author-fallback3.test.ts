import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Program } from '../validate.ts'

const program: Program = {
  terms: {
    'terms/fallback.json': t.findOr(
      t.eff('picker', 'candidates', t.bag({})),
      t.not(t.contains(t.ctx(['failed']), t.arg(1))),
      t.arg(1),
      t.ctx(['default']),
    ),
  },
  methods: {
    picker: ['candidates'],
  },
}

const effectTrace = [
  {
    port: 'picker',
    method: 'candidates',
    args: {},
  },
]

function decide(candidates: string[], failed: string[], fallback: string) {
  return runTerm(program, 'terms/fallback.json', {
    ctx: { failed, default: fallback },
    effects: [candidates],
    trace: true,
  })
}

describe('picker 候选降级链', () => {
  it('选择第一个未失败候选', () => {
    expect(decide(['alpha', 'beta'], [], 'fallback')).toEqual({
      ok: true,
      value: 'alpha',
      trace: effectTrace,
    })
  })

  it('第一个已失败时选择第二个', () => {
    expect(decide(['alpha', 'beta'], ['alpha'], 'fallback')).toEqual({
      ok: true,
      value: 'beta',
      trace: effectTrace,
    })
  })

  it('全部候选已失败时返回默认值', () => {
    expect(decide(['alpha', 'beta'], ['alpha', 'beta'], 'fallback')).toEqual({
      ok: true,
      value: 'fallback',
      trace: effectTrace,
    })
  })

  it('候选为空时返回默认值', () => {
    expect(decide([], [], 'fallback')).toEqual({
      ok: true,
      value: 'fallback',
      trace: effectTrace,
    })
  })
})
