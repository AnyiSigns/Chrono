// machine.ts 验收：只打 ./index.ts，eval 以 `evaluate` 名导入。
// Env / Term 未从面导出——以 Parameters<typeof evaluate> 结构化构造，不 import 内部模块。
// 随机用例固定种子（LCG，属性测试保证可重跑）。
import { describe, expect, it } from 'vitest'
import { cmp, eval as evaluate, H } from '../index.ts'
import type { Json } from '../index.ts'

type EnvT = Parameters<typeof evaluate>[1]
type TermT = Parameters<typeof evaluate>[0]

const RUN = 'run-1'

function envOf(overrides: Partial<EnvT> = {}): EnvT {
  const base = {
    ctx: null,
    args: [],
    defs: {},
    results: {},
    caps: { fs: true },
    limits: { gas: 1000, depth: 4 },
    run: RUN,
    i: 0,
    n: 0,
    gas: 1000,
    depth: 0,
    peakDepth: 0,
  }
  return { ...base, ...overrides } as unknown as EnvT
}

/** 注册 def（函数即值的具名定义）：返回含该 def 的 env 与它的 hash。 */
function defOf(body: Json, gas = 1000): { env: EnvT; h: string } {
  const env = envOf({ gas })
  const defs = env.defs as Record<string, { body: Json }>
  const d = { body }
  const h = H(d as unknown as Json)
  defs[h] = d
  return { env, h }
}

const asTerm = (x: unknown): TermT => x as TermT
const constNode = (v: unknown): TermT => asTerm(['c', v])
type Res = ReturnType<typeof evaluate>
const okv = (r: Res): Json => {
  if ('suspend' in r) throw new Error('expected ok, got suspend')
  if (!r.ok) throw new Error('expected ok, got ' + r.error)
  return r.value
}
const err = (r: Res): string => {
  if ('suspend' in r) throw new Error('expected error, got suspend')
  if (r.ok) throw new Error('expected error, got ok')
  return r.error
}
type Susp = { id: string; port: string; method: string; args: Json; caps: Record<string, boolean> }
const susp = (r: Res): Susp => {
  if (!('suspend' in r)) throw new Error('expected suspend, got ' + JSON.stringify(r))
  return r.suspend as unknown as Susp
}
const ev = (t: unknown, e: EnvT) => evaluate(asTerm(t), e)

// ── 8 原语各一正一反 ────────────────────

describe('8 原语各一正一反', () => {
  it('c：Const 取值 / 元数不合 bad_term', () => {
    expect(okv(ev(constNode(7), envOf()))).toBe(7)
    expect(err(ev(asTerm(['c', 1, 2]), envOf()))).toBe('bad_term')
  })
  it('g：按 Path 取值 / 键不存在 missing_path', () => {
    const e = envOf({ ctx: { a: { b: [10, 20] } } as unknown as Json })
    expect(okv(ev(asTerm(['g', ['a', 'b', 1]]), e))).toBe(20)
    expect(err(ev(asTerm(['g', ['a', 'nope']]), e))).toBe('missing_path')
  })
  it('v：按位取实参 / 越界与非整数 bad_var', () => {
    const e = envOf({ args: ['x'] as unknown as Json[] })
    expect(okv(ev(asTerm(['v', 0]), e))).toBe('x')
    expect(err(ev(asTerm(['v', -1]), e))).toBe('bad_var')
    expect(err(ev(asTerm(['v', 5]), e))).toBe('bad_var')
  })
  it('cmp：全序比较 / 元数不合 bad_term', () => {
    expect(okv(ev(asTerm(['cmp', constNode(1), constNode(2)]), envOf()))).toBe(-1)
    expect(err(ev(asTerm(['cmp', constNode(1)]), envOf()))).toBe('bad_term')
  })
  it('if：条件真取 then（不预求 else）/ 元数不合 bad_term', () => {
    const e = envOf({ ctx: { p: 1 } as unknown as Json })
    expect(okv(ev(asTerm(['if', constNode(true), ['g', ['p']], ['g', ['boom']]]), e))).toBe(1)
    expect(err(ev(asTerm(['if', constNode(true), constNode(1)]), e))).toBe('bad_term')
  })
  it('fold：步函数迭代 / coll 非 List → not_a_list', () => {
    const { env, h } = defOf(asTerm(['v', 1]) as unknown as Json)
    expect(okv(ev(asTerm(['fold', constNode([1, 2, 3]), constNode(0), constNode(h)]), env))).toBe(3)
    expect(err(ev(asTerm(['fold', constNode('nope'), constNode(0), constNode(h)]), env))).toBe(
      'not_a_list',
    )
  })
  it('eff：回灌取值 / 未回灌挂起（三态之一）', () => {
    const id = H({ run: RUN, i: 0, n: 0 } as unknown as Json)
    const e = envOf({ results: { [id]: { ok: true, value: 'fed' } } as unknown as EnvT['results'] })
    expect(okv(ev(asTerm(['eff', 'fs', 'read', constNode(null)]), e))).toBe('fed')
    const p = envOf()
    const r = susp(ev(asTerm(['eff', 'fs', 'read', constNode(3)]), p))
    expect(r.id).toBe(id)
  })
  it('call：以 def hash 调用 / 实参表非数组 bad_term', () => {
    const { env, h } = defOf(asTerm(['v', 0]) as unknown as Json)
    expect(okv(ev(asTerm(['call', constNode(h), [constNode(42)]]), env))).toBe(42)
    expect(err(ev(asTerm(['call', constNode(h), constNode([1])]), env))).toBe('bad_term')
  })
})

// ── cmp 全序 ────────────────────────────────────

describe('cmp 全序', () => {
  const typeSamples = { Int: 3, Str: 'i', Bool: false, List: [1], Json: { a: 1 }, None: null }
  const keys = Object.keys(typeSamples) as (keyof typeof typeSamples)[]
  it('TYPE_ORDER 跨型 15 例（6 型两两；Int<Str<Bool<List<Json<None）', () => {
    let n = 0
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        expect([
          cmp(typeSamples[keys[i]], typeSamples[keys[j]]),
          cmp(typeSamples[keys[j]], typeSamples[keys[i]]),
        ]).toEqual([-1, 1])
        n += 1
      }
    }
    expect(n).toBe(15)
  })

  it('Json 分支滤 undefined 键：{a,b:undefined}≡{a} 且 H 相等（与 canonicalJson 同口径）', () => {
    const a = { a: 1, b: undefined } as unknown as Json
    const b = { a: 1 } as unknown as Json
    expect(cmp(a, b)).toBe(0)
    expect(H(a)).toBe(H(b))
  })

  it('同型逐结构：List 首差即返、Json 先键名后值', () => {
    expect(cmp([1, 2], [1, 3, 0])).toBe(-1)
    expect(cmp([1, 2], [1, 2])).toBe(0)
    expect(cmp([1], [1, 0])).toBe(-1)
    expect(cmp({ a: 1, b: 2 }, { a: 1 })).toBe(1)
    expect(cmp({ a: 2 }, { b: 1 })).toBe(-1)
    expect(cmp('abc', 'ab')).toBe(1)
    expect(cmp(true, false)).toBe(1)
    expect(cmp(null, undefined as unknown as Json)).toBe(0)
  })

  it('全序性属性测试：固定种子随机 200 组，反对称 + 传递', () => {
    let seedState = 20260916 >>> 0
    const rnd = (): number => {
      seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0
      return seedState / 0x100000000
    }
    const randTerm = (depth: number): Json => {
      const k = Math.floor(rnd() * 6)
      if (k === 0) return Math.floor(rnd() * 5) - 2
      if (k === 1) return 'ab'.slice(0, Math.floor(rnd() * 3))
      if (k === 2) return rnd() < 0.5
      if (k === 3) return depth > 2 ? [rnd() < 0.5] : [randTerm(depth + 1), randTerm(depth + 1)]
      if (k === 4) return { k1: randTerm(depth + 1), k2: depth > 2 ? 1 : randTerm(depth + 1) }
      return null
    }
    for (let g = 0; g < 200; g++) {
      const a = randTerm(0)
      const b = randTerm(0)
      const c = randTerm(0)
      expect(cmp(a, a)).toBe(0)
      const ab = cmp(a, b)
      const bc = cmp(b, c)
      expect(cmp(b, a)).toBe(ab === 0 ? 0 : -ab)
      expect(cmp(c, b)).toBe(bc === 0 ? 0 : -bc)
      if (ab <= 0 && bc <= 0) expect(cmp(a, c)).toBeLessThanOrEqual(0)
      if (ab >= 0 && bc >= 0) expect(cmp(a, c)).toBeGreaterThanOrEqual(0)
      if (ab === 0 && bc === 0) expect(cmp(a, c)).toBe(0)
    }
  })

  it('非有限数不进值域：t() 先报 nonfinite', () => {
    expect(() => cmp(Number.NaN, 1)).toThrow(/nonfinite/)
    expect(() => cmp([1], [Number.POSITIVE_INFINITY])).toThrow(/nonfinite/)
  })
})

// ── 求值纪律与函数即值 ─────────────────

describe('eval 求值纪律', () => {
  it('if 条件非 Bool → bad_cond', () => {
    expect(err(ev(asTerm(['if', constNode(1), constNode(2), constNode(3)]), envOf()))).toBe(
      'bad_cond',
    )
    expect(err(ev(asTerm(['if', constNode('true'), constNode(2), constNode(3)]), envOf()))).toBe(
      'bad_cond',
    )
    expect(err(ev(asTerm(['if', constNode(null), constNode(2), constNode(3)]), envOf()))).toBe(
      'bad_cond',
    )
  })

  it('v 指向值为 null 的实参 → 返回 null，不报 bad_var', () => {
    const e = envOf({ args: [null] as unknown as Json[] })
    expect(ev(asTerm(['v', 0]), e)).toEqual({ ok: true, value: null })
  })

  it('fold：空数组返 init / 单元素返该元素', () => {
    const { env, h } = defOf(asTerm(['v', 1]) as unknown as Json)
    expect(okv(ev(asTerm(['fold', constNode([]), constNode('init'), constNode(h)]), env))).toBe(
      'init',
    )
    const r = defOf(asTerm(['v', 1]) as unknown as Json)
    expect(okv(ev(asTerm(['fold', constNode([9]), constNode(0), constNode(r.h)]), r.env))).toBe(9)
  })

  it('fold 每轮迭代再扣 1：3 元素步 = 4 节点 + 3×2', () => {
    const { env, h } = defOf(asTerm(['v', 1]) as unknown as Json, 100)
    okv(ev(asTerm(['fold', constNode([1, 2, 3]), constNode(0), constNode(h)]), env))
    expect(100 - env.gas).toBe(10)
    const r = defOf(asTerm(['v', 1]) as unknown as Json, 100)
    okv(ev(asTerm(['fold', constNode([]), constNode(0), constNode(r.h)]), r.env))
    expect(100 - r.env.gas).toBe(4)
  })

  it('挂起冒泡：步内 eff 未回灌 → fold 整体 suspend；回灌后从头重跑取前缀', () => {
    const { env, h } = defOf(asTerm(['eff', 'fs', 'go', ['v', 1]]) as unknown as Json)
    const r = susp(ev(asTerm(['fold', constNode([1, 2]), constNode(0), constNode(h)]), env))
    expect([r.port, r.id]).toEqual(['fs', H({ run: RUN, i: 0, n: 0 } as unknown as Json)])
    expect(env.n).toBe(1)
    const secondEffId = H({ run: RUN, i: 0, n: 1 } as unknown as Json) // 每轮 step 各占一个 n（O(k²) 重放）
    const fedEnv = envOf({
      results: {
        [r.id]: { ok: true, value: 'v' },
        [secondEffId]: { ok: true, value: 'w' },
      } as unknown as EnvT['results'],
      defs: env.defs,
    })
    expect(okv(ev(asTerm(['fold', constNode([1, 2]), constNode(0), constNode(h)]), fedEnv))).toBe(
      'w',
    )
    expect(fedEnv.n).toBe(2)
  })

  it('函数侧 = 从 ctx 取 hash 可 call；同一次调用内新写入的 def 可见', () => {
    const { env, h } = defOf(asTerm(['v', 0]) as unknown as Json)
    const e = envOf({ ctx: { f: h } as unknown as Json, defs: env.defs })
    expect(okv(ev(asTerm(['call', ['g', ['f']], [constNode('via-ctx')]]), e))).toBe('via-ctx')
    const fresh = { body: asTerm(['v', 1]) as unknown as Json }
    const freshKey = H(fresh as unknown as Json)
    ;(e.defs as Record<string, unknown>)[freshKey] = fresh // 模拟同一调用里前面的写
    e.ctx = { f: freshKey } as unknown as Json
    expect(okv(ev(asTerm(['call', ['g', ['f']], [constNode(0), constNode('second')]]), e))).toBe(
      'second',
    )
  })

  it('函数侧非 Str / 非 64-hex → bad_fun（格式门槛先于存在性）', () => {
    expect(err(ev(asTerm(['call', constNode(7), []]), envOf()))).toBe('bad_fun')
    expect(err(ev(asTerm(['call', constNode('deadbeef'), []]), envOf()))).toBe('bad_fun')
    expect(err(ev(asTerm(['call', constNode('F'.repeat(64)), []]), envOf()))).toBe('bad_fun')
  })

  it('fold 的函数侧同样过 evalCall 门槛：bad_fun / missing_ref', () => {
    expect(
      err(ev(asTerm(['fold', constNode([1]), constNode(0), constNode('deadbeef')]), envOf())),
    ).toBe('bad_fun')
    expect(
      err(ev(asTerm(['fold', constNode([1]), constNode(0), constNode('a'.repeat(64))]), envOf())),
    ).toBe('missing_ref')
  })

  it('函数侧格式合但 defs 无 → missing_ref', () => {
    expect(err(ev(asTerm(['call', constNode('cd'.repeat(32)), []]), envOf()))).toBe('missing_ref')
  })

  it('fold 函数侧恰求值一次：含 eff 整场只发射一次、只占一个 n', () => {
    const step = defOf(asTerm(['v', 1]) as unknown as Json)
    const pickId = H({ run: RUN, i: 0, n: 0 } as unknown as Json)
    const env = envOf({
      gas: 1000,
      defs: step.env.defs,
      results: { [pickId]: { ok: true, value: step.h } } as unknown as EnvT['results'],
    })
    const r = ev(
      asTerm(['fold', constNode([1, 2, 3]), constNode(0), ['eff', 'fs', 'pick', constNode(null)]]),
      env,
    )
    expect(okv(r)).toBe(3)
    expect(env.n).toBe(1)
    const e2 = envOf({ defs: step.env.defs })
    const p = susp(
      ev(
        asTerm([
          'fold',
          constNode([1, 2, 3]),
          constNode(0),
          ['eff', 'fs', 'pick', constNode(null)],
        ]),
        e2,
      ),
    )
    expect(p.id).toBe(pickId)
    expect(e2.n).toBe(1)
  })

  it('eff 序号确定性：同输入两跑得同一串 id；caps 恒等于输入表', () => {
    const a = asTerm(['eff', 'fs', 'op', ['call', constNode(0), []]])
    const r1 = susp(ev(asTerm(['eff', 'fs', 'op', constNode(1)]), envOf({ i: 3 })))
    const r2 = susp(ev(asTerm(['eff', 'fs', 'op', constNode(1)]), envOf({ i: 3, n: 0 })))
    expect(r1.id).toBe(r2.id)
    expect(r1.id).toBe(H({ run: RUN, i: 3, n: 0 } as unknown as Json))
    expect(r1.caps).toEqual({ fs: true })
    void a
  })

  it('eff 回灌 ok:false → eff_error', () => {
    const id = H({ run: RUN, i: 2, n: 0 } as unknown as Json)
    const e = envOf({
      i: 2,
      results: { [id]: { ok: false, error: 'boom' } } as unknown as EnvT['results'],
    })
    expect(err(ev(asTerm(['eff', 'fs', 'op', constNode(1)]), e))).toBe('eff_error')
  })

  it('gas 耗尽 → {ok:false,error:gas}；usage 归 run 算', () => {
    const e = envOf({ gas: 2 })
    expect(err(ev(asTerm(['cmp', constNode(1), constNode(2)]), e))).toBe('gas')
    expect(e.gas).toBeLessThan(0)
  })

  it('depth 超限 → {ok:false,error:depth}；usage 归 run', () => {
    const e = envOf({ limits: { gas: 1000, depth: 2 } })
    expect(err(ev(asTerm(['cmp', ['cmp', constNode(1), constNode(2)], constNode(3)]), e))).toBe(
      'depth',
    )
    expect(e.peakDepth).toBe(3) // 峰值在自增处更新（usage.depth 取峰值）
  })

  it('finally 成对增减：成功路径回到 0；深而宽不误触', () => {
    const leaf = defOf(asTerm(['v', 0]) as unknown as Json, 100)
    const step = defOf(asTerm(['call', constNode(leaf.h), [constNode(7)]]) as unknown as Json, 100)
    ;(step.env.defs as Record<string, unknown>)[leaf.h] = leaf.env.defs[leaf.h]
    const e = envOf({ defs: step.env.defs, limits: { gas: 1000, depth: 4 } })
    expect(okv(ev(asTerm(['cmp', ['cmp', constNode(1), constNode(2)], constNode(3)]), e))).toBe(-1)
    expect([e.depth, e.peakDepth]).toEqual([0, 3])
    // 三轮 fold × 同深支（顺序迭代）：若 finally 不还原，第二轮即误触 depth
    expect(
      okv(ev(asTerm(['fold', constNode([1, 2, 3]), constNode(0), constNode(step.h)]), e)),
    ).toBe(7)
    expect([e.depth, e.peakDepth]).toEqual([0, 3])
    const e4 = envOf({ defs: step.env.defs, limits: { gas: 1000, depth: 2 } })
    expect(
      err(ev(asTerm(['fold', constNode([1, 2, 3]), constNode(0), constNode(step.h)]), e4)),
    ).toBe('depth')
  })

  it('gas/depth 记在同一 env 实例上跨 call 累计（禁止展开复制）', () => {
    const inner = defOf(asTerm(['v', 0]) as unknown as Json, 100)
    const e = envOf({ gas: 100, defs: inner.env.defs })
    okv(ev(constNode(0), e)) // 1 节点
    okv(ev(asTerm(['call', constNode(inner.h), [constNode(1)]]), e)) // call + 函数侧 + 实参 + 体内 v = 4 节点
    expect(100 - e.gas).toBe(5)
    expect(e.peakDepth).toBe(2)
    expect(e.depth).toBe(0)
  })

  it('bad_term 拒字面 ["let", …] 等语法扩展头', () => {
    expect(err(ev(asTerm(['let', constNode(1), constNode(2)]), envOf()))).toBe('bad_term')
    expect(err(ev(asTerm(['lambda', constNode(1)]), envOf()))).toBe('bad_term')
  })
})

// ── 错误码表逐码 ────────────────────────────────

describe('错误码表逐码触发', () => {
  const codeOf = (t: unknown, e: EnvT): string => {
    const r = ev(t, e)
    if ('suspend' in r) return 'suspend'
    return r.ok ? 'ok' : r.error
  }

  it('gas：节点计费先于分派', () => {
    expect(codeOf(constNode(1), envOf({ gas: 0 }))).toBe('gas')
  })
  it('depth：limits.depth 超限', () => {
    expect(codeOf(constNode(1), envOf({ limits: { gas: 100, depth: 0 } }))).toBe('depth')
  })
  it('nonfinite：cmp / H 口径暴露非有限数', () => {
    const e = envOf({ ctx: { bad: Number.NaN } as unknown as Json })
    expect(codeOf(asTerm(['cmp', constNode(0), ['g', ['bad']]]), e)).toBe('nonfinite')
  })
  it('missing_path：g 的 Path 不存在', () => {
    expect(codeOf(asTerm(['g', ['nope']]), envOf({ ctx: {} }))).toBe('missing_path')
  })
  it('bad_var：v 下标越界', () => {
    expect(codeOf(asTerm(['v', 9]), envOf())).toBe('bad_var')
  })
  it('bad_cond：if 条件非 Bool', () => {
    expect(codeOf(asTerm(['if', constNode(0), constNode(1), constNode(2)]), envOf())).toBe(
      'bad_cond',
    )
  })
  it('not_a_list：fold coll 非数组', () => {
    expect(
      codeOf(asTerm(['fold', constNode(3), constNode(0), constNode('a'.repeat(64))]), envOf()),
    ).toBe('not_a_list')
  })
  it('bad_fun：函数侧非 64 位小写 hex', () => {
    expect(codeOf(asTerm(['call', constNode('nope'), []]), envOf())).toBe('bad_fun')
  })
  it('missing_ref：函数侧合格式但 defs 无', () => {
    expect(codeOf(asTerm(['call', constNode('a'.repeat(64)), []]), envOf())).toBe('missing_ref')
  })
  it('bad_term：头不在 8 原语名单', () => {
    expect(codeOf(asTerm(['let', []]), envOf())).toBe('bad_term')
  })
  it('eff_error：已回灌的 results[id].ok === false', () => {
    const id = H({ run: RUN, i: 0, n: 0 } as unknown as Json)
    const e = envOf({ results: { [id]: { ok: false } } as unknown as EnvT['results'] })
    expect(codeOf(asTerm(['eff', 'p', 'm', constNode(1)]), e)).toBe('eff_error')
  })

  it('def body 不是 Term → bad_term（evalCall 的 body 门槛）', () => {
    const { env, h } = defOf('not-a-list' as unknown as Json)
    expect(err(ev(asTerm(['call', constNode(h), []]), env))).toBe('bad_term')
  })
})
