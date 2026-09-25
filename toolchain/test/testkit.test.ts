import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { explainError, isInvalid, runTerm, runTermValidated } from '../testkit.ts'
import type { Program } from '../validate.ts'

const program = {
  terms: {
    'terms/entry.json': t.fold(
      t.eff('judge', 'pick', t.lit(null)),
      t.lit(null),
      'terms/step.json',
    ),
    'terms/step.json': t.if(
      t.pred('eq', t.arg(0), t.lit(null)),
      t.arg(1),
      t.if(t.pred('lt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)),
    ),
  },
  implements: ['judge'],
  methods: { judge: ['pick'] },
} as unknown as Program

describe('testkit：编译 + 效果回灌 + 求值', () => {
  it('fold 对效果结果做 argmin', () => {
    expect(runTerm(program, 'terms/entry.json', { effects: [[3, 1, 2]] })).toEqual({
      ok: true,
      value: 1,
    })
  })

  it('效果不足 → missing_effect；term 不存在 → missing_term', () => {
    expect(runTerm(program, 'terms/entry.json', {})).toEqual({ ok: false, error: 'missing_effect' })
    expect(runTerm(program, 'terms/nope.json')).toEqual({ ok: false, error: 'missing_term' })
  })

  it('runTermValidated：先校验，不过回 invalid + 带源指针的 issues', () => {
    const bad = {
      terms: { 'terms/e.json': t.eff('nope', 'm', t.lit(null)) },
    } as unknown as Program
    const r = runTermValidated(bad, 'terms/e.json')
    expect(r.ok).toBe(false)
    if (!r.ok && 'issues' in r) {
      expect(r.issues.map((i) => i.message)).toContain('undeclared_port: nope')
    } else {
      throw new Error('expected invalid')
    }
  })

  it('错误定位：at 透出 + explainError 映射回源指针', () => {
    const p = {
      terms: { 'terms/e.json': t.if(t.lit(true), t.ctx(['boom']), t.lit(1)) },
    } as unknown as Program
    const r = runTerm(p, 'terms/e.json')
    expect(r).toMatchObject({ ok: false, error: 'missing_path', at: [2] })
    if (!r.ok && !isInvalid(r)) {
      expect(explainError(p, 'terms/e.json', r)).toEqual({
        term: 'terms/e.json',
        pointer: '/then',
        approx: false,
      })
    }
  })

  it('跨 def 错误：def=callee，explainError 定位到被调 term', () => {
    const p = {
      terms: {
        'terms/step.json': t.ctx(['boom']),
        'terms/e.json': t.call('terms/step.json', []),
      },
    } as unknown as Program
    const r = runTerm(p, 'terms/e.json')
    expect(r).toMatchObject({ ok: false, error: 'missing_path' })
    if (!r.ok && !isInvalid(r) && r.def !== undefined) {
      expect(explainError(p, 'terms/e.json', r)).toEqual({
        term: 'terms/step.json',
        pointer: '',
        approx: false,
      })
    } else {
      throw new Error('expected def')
    }
  })
})
