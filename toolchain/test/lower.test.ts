import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { lower } from '../lower.ts'
import type { Sugar } from '../lower.ts'

const bad = (s: unknown): string => {
  try {
    lower(s as Sugar)
    return 'no-throw'
  } catch (e) {
    return (e as Error).message
  }
}

describe('糖化 JSON 降级', () => {
  it('lit / ctx / arg', () => {
    expect(lower(t.lit(7))).toEqual(['c', 7])
    expect(lower(t.ctx(['a', 'b', 1]))).toEqual(['g', ['a', 'b', 1]])
    expect(lower(t.arg(2))).toEqual(['v', 2])
  })

  it('get：对任意值投影', () => {
    expect(lower(t.get(t.arg(0), ['score']))).toEqual(['get', ['v', 0], ['score']])
    expect(bad({ k: 'get', of: t.arg(0), path: [1.5] })).toBe('bad_sugar')
  })

  it('let / bind：写期宏展开（顺序绑定）', () => {
    const s = t.let(
      [
        ['x', t.lit(1)],
        ['y', t.get(t.bind('x'), [])],
      ],
      t.pred('lt', t.bind('x'), t.bind('y')),
    )
    expect(lower(s)).toEqual(['pred', 'lt', ['c', 1], ['get', ['c', 1], []]])
    expect(bad(t.bind('nope'))).toBe('bad_sugar')
  })

  it('if / pred', () => {
    expect(lower(t.if(t.lit(true), t.lit(1), t.lit(2)))).toEqual(['if', ['c', true], ['c', 1], ['c', 2]])
    expect(lower(t.pred('lt', t.lit(1), t.lit(2)))).toEqual(['pred', 'lt', ['c', 1], ['c', 2]])
  })

  it('fold：函数侧包成 Const + $ref 占位', () => {
    expect(lower(t.fold(t.ctx(['xs']), t.lit(0), 'terms/s.json'))).toEqual([
      'fold',
      ['g', ['xs']],
      ['c', 0],
      ['c', { $ref: 'terms/s.json' }],
    ])
  })

  it('call：函数侧包成 Const + $ref 占位', () => {
    expect(lower(t.call('terms/f.json', [t.lit(1)]))).toEqual([
      'call',
      ['c', { $ref: 'terms/f.json' }],
      [['c', 1]],
    ])
  })

  it('eff', () => {
    expect(lower(t.eff('picker', 'candidates', t.lit(null)))).toEqual([
      'eff',
      'picker',
      'candidates',
      ['c', null],
    ])
  })

  it('非法糖化 fail-closed', () => {
    expect(bad({ k: 'nope' })).toBe('bad_sugar')
    expect(bad({ k: 'arg', i: -1 })).toBe('bad_sugar')
    expect(bad({ k: 'ctx', path: 'bad' })).toBe('bad_sugar')
    expect(bad({ k: 'pred', op: 'zz', a: t.lit(1), b: t.lit(1) })).toBe('bad_sugar')
    expect(bad({ k: 'fold', coll: t.lit([]), init: t.lit(0), step: '' })).toBe('bad_sugar')
  })

  it('确定性：同源两次降级逐字节一致', () => {
    const s = t.if(t.pred('ge', t.ctx(['x']), t.lit(1)), t.lit('a'), t.lit('b'))
    expect(JSON.stringify(lower(s))).toBe(JSON.stringify(lower(s)))
  })
})
