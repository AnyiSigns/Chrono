import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { GEN_PREFIX, lower, lowerProgram } from '../lower.ts'
import type { Sugar } from '../lower.ts'
import { explainError, isInvalid, runTerm, runTermUnchecked } from '../testkit.ts'
import type { Program } from '../validate.ts'

const asProgram = (terms: Record<string, Sugar>): Program => ({ terms }) as unknown as Program

describe('内联 step / ref', () => {
  it('fold 内联 step：一条组合子写完整判定', () => {
    const p = asProgram({
      'terms/e.json': t.fold(
        t.ctx(['xs']),
        t.lit(0),
        t.if(t.pred('gt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)),
      ),
    })
    expect(runTerm(p, 'terms/e.json', { ctx: { xs: [1, 5, 3] } })).toEqual({ ok: true, value: 5 })
  })

  it('call 内联 ref：callee 按位置收 args', () => {
    const p = asProgram({
      'terms/e.json': t.call(
        t.if(t.pred('gt', t.arg(0), t.lit(10)), t.lit('big'), t.lit('small')),
        [t.ctx(['n'])],
      ),
    })
    expect(runTerm(p, 'terms/e.json', { ctx: { n: 20 } })).toEqual({ ok: true, value: 'big' })
    expect(runTerm(p, 'terms/e.json', { ctx: { n: 3 } })).toEqual({ ok: true, value: 'small' })
  })

  it('生成路径稳定且可复用：同内容内联 step 只生成一个 term', () => {
    const step = t.if(t.pred('gt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0))
    const src = {
      'terms/a.json': t.fold(t.ctx(['xs']), t.lit(0), step),
      'terms/b.json': t.fold(t.ctx(['ys']), t.lit(0), step),
    }
    const one = lowerProgram(src)
    const two = lowerProgram(src)
    expect(one.generated).toHaveLength(1)
    expect(one.generated[0].startsWith(GEN_PREFIX)).toBe(true)
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
  })

  it('缺 LowerCtx 时内联 step 报 bad_sugar', () => {
    expect(() => lower(t.fold(t.lit([]), t.lit(0), t.lit(1)))).toThrow('bad_sugar')
  })

  it('生成 term 内的运行期错误可映射回内联源', () => {
    const p = asProgram({
      'terms/e.json': t.fold(t.ctx(['xs']), t.lit(0), t.ctx(['boom'])),
    })
    const r = runTerm(p, 'terms/e.json', { ctx: { xs: [1] } })
    expect(r).toMatchObject({ ok: false, error: 'missing_path' })
    if (!r.ok && !isInvalid(r) && r.def !== undefined) {
      const loc = explainError(p, 'terms/e.json', r)
      expect(loc.term.startsWith(GEN_PREFIX)).toBe(true)
      expect(loc.pointer).toBe('')
    } else {
      throw new Error('expected generated def')
    }
  })
})

describe('命名模式', () => {
  it('contains / in：成员判断', () => {
    const p = asProgram({
      'terms/c.json': t.contains(t.ctx(['allow']), t.ctx(['tool'])),
      'terms/i.json': t.in(t.ctx(['tool']), t.ctx(['allow'])),
    })
    expect(runTerm(p, 'terms/c.json', { ctx: { allow: ['read', 'write'], tool: 'write' } })).toEqual({
      ok: true,
      value: true,
    })
    expect(runTerm(p, 'terms/i.json', { ctx: { allow: ['read'], tool: 'rm' } })).toEqual({
      ok: true,
      value: false,
    })
  })

  it('contains 支持动态 needle：降级链取首个未失败候选', () => {
    const p = asProgram({
      'terms/pick.json': t.findOr(
        t.ctx(['cands']),
        t.not(t.in(t.arg(1), t.ctx(['failed']))),
        t.arg(1),
        t.ctx(['default']),
      ),
    })
    expect(
      runTerm(p, 'terms/pick.json', { ctx: { cands: ['a', 'b'], failed: ['a'], default: 'd' } }),
    ).toEqual({ ok: true, value: 'b' })
    expect(
      runTerm(p, 'terms/pick.json', { ctx: { cands: ['a'], failed: ['a'], default: 'd' } }),
    ).toEqual({ ok: true, value: 'd' })
  })

  it('argmin / argmax：按字段取极值，空集回 null', () => {
    const cands = [
      { id: 'a', score: 5 },
      { id: 'b', score: 2 },
      { id: 'c', score: 9 },
    ]
    const p = asProgram({
      'terms/min.json': t.argmin(t.ctx(['cands']), ['score']),
      'terms/max.json': t.argmax(t.ctx(['cands']), ['score']),
    })
    expect(runTerm(p, 'terms/min.json', { ctx: { cands } })).toEqual({
      ok: true,
      value: { id: 'b', score: 2 },
    })
    expect(runTerm(p, 'terms/max.json', { ctx: { cands } })).toEqual({
      ok: true,
      value: { id: 'c', score: 9 },
    })
    expect(runTerm(p, 'terms/min.json', { ctx: { cands: [] } })).toEqual({ ok: true, value: null })
  })

  it('find：首匹配 + 投影', () => {
    const p = asProgram({
      'terms/first.json': t.find(
        t.ctx(['xs']),
        t.pred('gt', t.get(t.arg(1), ['rank']), t.lit(2)),
        t.get(t.arg(1), ['id']),
      ),
    })
    const xs = [
      { id: 'a', rank: 1 },
      { id: 'b', rank: 3 },
      { id: 'c', rank: 4 },
    ]
    expect(runTerm(p, 'terms/first.json', { ctx: { xs } })).toEqual({ ok: true, value: 'b' })
    expect(runTerm(p, 'terms/first.json', { ctx: { xs: [] } })).toEqual({ ok: true, value: null })
  })

  it('findOr：无命中回兜底', () => {
    const p = asProgram({
      'terms/r.json': t.findOr(
        t.ctx(['xs']),
        t.pred('gt', t.get(t.arg(1), ['rank']), t.lit(9)),
        t.get(t.arg(1), ['id']),
        t.ctx(['fallback']),
      ),
    })
    const xs = [{ id: 'a', rank: 1 }]
    expect(runTerm(p, 'terms/r.json', { ctx: { xs, fallback: 'none' } })).toEqual({
      ok: true,
      value: 'none',
    })
    expect(runTerm(p, 'terms/r.json', { ctx: { xs: [{ id: 'z', rank: 10 }], fallback: 'none' } })).toEqual({
      ok: true,
      value: 'z',
    })
  })
})

describe('布尔糖与 bag', () => {
  it('and / or / not 惰性产 Bool', () => {
    const p = asProgram({
      'terms/b.json': t.and(t.ctx(['a']), t.or(t.ctx(['b']), t.not(t.ctx(['c'])))),
    })
    expect(runTerm(p, 'terms/b.json', { ctx: { a: true, b: false, c: false } })).toEqual({
      ok: true,
      value: true,
    })
    expect(runTerm(p, 'terms/b.json', { ctx: { a: true, b: false, c: true } })).toEqual({
      ok: true,
      value: false,
    })
    expect(runTerm(p, 'terms/b.json', { ctx: { a: false, b: true, c: false } })).toEqual({
      ok: true,
      value: false,
    })
  })

  it('bag：常量对象 bag', () => {
    expect(lower(t.bag({ limit: 3, tag: 'x' }))).toEqual(['c', { limit: 3, tag: 'x' }])
  })
})

describe('效果轨迹', () => {
  const p = {
    terms: {
      'terms/o.json': t.if(
        t.pred('eq', t.eff('auth', 'check', t.bag({ r: 'doc' })), t.lit(true)),
        t.eff('data', 'fetch', t.bag({ id: 7 })),
        t.lit('denied'),
      ),
    },
    implements: ['auth', 'data'],
    methods: { auth: ['check'], data: ['fetch'] },
  } as unknown as Program

  it('按发射顺序记录 port/method/args', () => {
    const r = runTerm(p, 'terms/o.json', { effects: [true, 'payload'], trace: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.trace?.map((t) => `${t.port}.${t.method}`)).toEqual(['auth.check', 'data.fetch'])
    }
  })

  it('可断言某效果未发射', () => {
    const r = runTerm(p, 'terms/o.json', { effects: [false], trace: true })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.trace?.map((t) => `${t.port}.${t.method}`)).toEqual(['auth.check'])
    }
  })
})

describe('runTerm 默认校验', () => {
  const bad = asProgram({ 'terms/e.json': t.eff('nope', 'm', t.lit(null)) })

  it('不过回 invalid + issues', () => {
    const r = runTerm(bad, 'terms/e.json')
    expect(r).toMatchObject({ ok: false, error: 'invalid' })
    if (!r.ok && isInvalid(r)) expect(r.issues.map((i) => i.message)).toContain('undeclared_port: nope')
  })

  it('runTermUnchecked 显式跳过校验', () => {
    expect(runTermUnchecked(bad, 'terms/e.json')).toEqual({ ok: false, error: 'missing_effect' })
  })

  it('methods 已声明但缺 port 条目 → undeclared_method', () => {
    const p = asProgram({ 'terms/e.json': t.eff('judge', 'pick', t.lit(null)) })
    const withMethods = { ...p, implements: ['judge'], methods: { other: [] } }
    const r = runTerm(withMethods, 'terms/e.json')
    expect(r).toMatchObject({ ok: false, error: 'invalid' })
    if (!r.ok && isInvalid(r)) {
      expect(r.issues.map((i) => i.message)).toContain('undeclared_method: judge')
    }
  })
})

describe('算术、构造与可选读取', () => {
  it('getOr：可选字段缺失取默认（路由 always 缺省不再 missing_path）', () => {
    const p = asProgram({
      'terms/route.json': t.find(
        t.ctx(['rules']),
        t.or(
          t.pred('eq', t.get(t.arg(1), ['when']), t.ctx(['input'])),
          t.getOr(t.arg(1), ['always'], t.lit(false)),
        ),
        t.get(t.arg(1), ['then']),
      ),
    })
    const rules = [
      { when: 'a', then: 'A' },
      { when: 'b', then: 'B' },
    ]
    expect(runTerm(p, 'terms/route.json', { ctx: { rules, input: 'b' } })).toEqual({
      ok: true,
      value: 'B',
    })
    expect(runTerm(p, 'terms/route.json', { ctx: { rules, input: 'z' } })).toEqual({
      ok: true,
      value: null,
    })
  })

  it('arith：add/sub/mul 推导新值', () => {
    const p = asProgram({
      'terms/sum.json': t.add(t.ctx(['a']), t.mul(t.ctx(['b']), t.lit(2))),
    })
    expect(runTerm(p, 'terms/sum.json', { ctx: { a: 1, b: 3 } })).toEqual({ ok: true, value: 7 })
  })

  it('list / obj：组装结构化结果', () => {
    const p = asProgram({
      'terms/out.json': t.obj({
        total: t.add(t.ctx(['a']), t.ctx(['b'])),
        tags: t.list([t.ctx(['x']), t.lit('fixed')]),
      }),
    })
    expect(runTerm(p, 'terms/out.json', { ctx: { a: 2, b: 5, x: 'dyn' } })).toEqual({
      ok: true,
      value: { total: 7, tags: ['dyn', 'fixed'] },
    })
  })

  it('obj 字段内的运行期错误映射到 /fields/<key>', () => {
    const p = asProgram({ 'terms/e.json': t.obj({ a: t.ctx(['boom']) }) })
    const r = runTerm(p, 'terms/e.json')
    expect(r).toMatchObject({ ok: false, error: 'missing_path' })
    if (!r.ok && !isInvalid(r)) {
      expect(explainError(p, 'terms/e.json', r)).toEqual({
        term: 'terms/e.json',
        pointer: '/fields/a',
        approx: false,
      })
    }
  })

  it('lower：新糖键降级为对应原语', () => {
    expect(lower(t.getOr(t.arg(0), ['k'], t.lit(0)))).toEqual([
      'getOr',
      ['v', 0],
      ['k'],
      ['c', 0],
    ])
    expect(lower(t.add(t.lit(1), t.lit(2)))).toEqual(['arith', 'add', ['c', 1], ['c', 2]])
    expect(lower(t.list([t.lit(1)]))).toEqual(['list', [['c', 1]]])
    expect(lower(t.obj({ a: t.lit(1) }))).toEqual(['obj', { a: ['c', 1] }])
  })
})

describe('单次求值绑定与端口声明', () => {
  it('let1：含 eff 的绑定被复用也只发射一次', () => {
    const p = {
      terms: {
        'terms/e.json': t.let1(
          'p',
          t.eff('g', 'policy', t.bag({})),
          t.if(
            t.pred('eq', t.get(t.bind('p'), ['x']), t.lit(1)),
            t.get(t.bind('p'), ['y']),
            t.lit('z'),
          ),
        ),
      },
      implements: ['g'],
      methods: { g: ['policy'] },
    } as unknown as Program
    const r = runTerm(p, 'terms/e.json', { effects: [{ x: 1, y: 'ok' }], trace: true })
    expect(r).toMatchObject({ ok: true, value: 'ok' })
    if (r.ok) expect(r.trace).toHaveLength(1)
  })

  it('只声明 methods 即可（端口隐含声明，免 implements 双填）', () => {
    const p = {
      terms: { 'terms/e.json': t.eff('judge', 'pick', t.lit(null)) },
      methods: { judge: ['pick'] },
    } as unknown as Program
    expect(runTerm(p, 'terms/e.json')).toEqual({ ok: false, error: 'missing_effect' })
  })
})
