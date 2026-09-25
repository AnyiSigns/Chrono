import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { validateProgram } from '../validate.ts'
import type { Program } from '../validate.ts'

const issuesOf = (p: unknown): string[] =>
  validateProgram(p as Program).issues.map((i) => i.message)

describe('静态校验器', () => {
  it('合法程序通过', () => {
    const program = {
      terms: {
        'terms/entry.json': t.fold(
          t.eff('judge', 'pick', t.lit(null)),
          t.lit(null),
          'terms/step.json',
        ),
        'terms/step.json': t.pred('lt', t.arg(1), t.arg(0)),
      },
      implements: ['judge'],
      methods: { judge: ['pick'] },
    }
    expect(validateProgram(program as unknown as Program).ok).toBe(true)
  })

  it('缺失引用 / 引用环 / 未声明 port', () => {
    expect(
      issuesOf({ terms: { 'terms/a.json': t.fold(t.lit([]), t.lit(0), 'terms/missing.json') } }),
    ).toContain('missing_ref: terms/missing.json')

    const cycle = {
      terms: {
        'terms/a.json': t.fold(t.lit([]), t.lit(0), 'terms/b.json'),
        'terms/b.json': t.fold(t.lit([]), t.lit(0), 'terms/a.json'),
      },
    }
    expect(issuesOf(cycle)).toContain('term_cycle')

    expect(issuesOf({ terms: { 'terms/e.json': t.eff('nope', 'm', t.lit(null)) } })).toContain(
      'undeclared_port: nope',
    )
  })

  it('方法未在该能力声明内', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('judge', 'bad', t.lit(null)) },
      implements: ['judge'],
      methods: { judge: ['pick'] },
    }
    expect(issuesOf(program)).toContain('undeclared_method: judge.bad')
  })

  it('形态不合（未绑定 bind）被拦', () => {
    expect(issuesOf({ terms: { 'terms/b.json': t.bind('nope') } })).toContain('bad_sugar')
  })

  it('let 绑定含 eff 且被引用多次 → effect_reemitted', () => {
    const program = {
      terms: {
        'terms/a.json': t.let(
          [['p', t.eff('g', 'policy', t.lit(null))]],
          t.if(
            t.pred('eq', t.get(t.bind('p'), ['x']), t.lit(1)),
            t.lit('a'),
            t.get(t.bind('p'), ['y']),
          ),
        ),
      },
      implements: ['g'],
      methods: { g: ['policy'] },
    }
    expect(issuesOf(program)).toContain('effect_reemitted: p')
  })
})
