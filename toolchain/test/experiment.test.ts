// 实验：判定作为数据。
// 走完整条链：builder 造糖化 → lower 降级 → 解析 $ref（模拟宿主 A0b）→ 内核 evaluate 求值。
// 判定 = 对 picker.candidates 的效果结果做 argmin（用 pred + if + fold + call + eff）。
import { describe, expect, it } from 'vitest'
import { H, eval as evaluate } from '../../packages/kernel/index.ts'
import type { Json } from '../../packages/kernel/index.ts'
import { t } from '../builder.ts'
import { lower } from '../lower.ts'
import type { Sugar } from '../lower.ts'

type EnvT = Parameters<typeof evaluate>[1]

/** 把 AST 里的 `{ $ref }` 换成真实 def 哈希（镜像宿主 `replaceTermRefs`）。 */
function resolveRefs(ast: Json, table: Record<string, string>): Json {
  if (Array.isArray(ast)) return ast.map((x) => resolveRefs(x, table))
  if (ast === null || typeof ast !== 'object') return ast
  const rec = ast as { [k: string]: Json }
  const keys = Object.keys(rec)
  if (keys.length === 1 && keys[0] === '$ref' && typeof rec['$ref'] === 'string') {
    const hash = table[rec['$ref'] as string]
    if (hash === undefined) throw new Error('unresolved_ref')
    return hash
  }
  const out: { [k: string]: Json } = {}
  for (const key of keys) out[key] = resolveRefs(rec[key], table)
  return out
}

function envOf(over: Partial<EnvT>): EnvT {
  const base = {
    ctx: null,
    args: [],
    defs: {},
    results: {},
    caps: {},
    limits: { gas: 1000, depth: 8 },
    run: 'r-exp',
    i: 0,
    n: 0,
    gas: 1000,
    depth: 0,
    peakDepth: 0,
  }
  return { ...base, ...over } as unknown as EnvT
}

const STEP = 'terms/pick.step.json'

/** 步函数：acc 为 null 取 item；否则取较小者（argmin）。 */
const argminStep: Sugar = t.if(
  t.pred('eq', t.arg(0), t.lit(null)),
  t.arg(1),
  t.if(t.pred('lt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)),
)

/** 步函数：argmax（另一条判定，用于「改判定 = 换数据」）。 */
const argmaxStep: Sugar = t.if(
  t.pred('eq', t.arg(0), t.lit(null)),
  t.arg(1),
  t.if(t.pred('gt', t.arg(1), t.arg(0)), t.arg(1), t.arg(0)),
)

/** 步函数：按字段 `score` 取最小者（用 get 投影；无 get 时写不出来）。 */
const argminByScore: Sugar = t.if(
  t.pred('eq', t.arg(0), t.lit(null)),
  t.arg(1),
  t.if(
    t.pred('lt', t.get(t.arg(1), ['score']), t.get(t.arg(0), ['score'])),
    t.arg(1),
    t.arg(0),
  ),
)

/** 判定入口：对 picker.candidates 的效果结果 fold。 */
const entryOf = (stepRef: string): Sugar =>
  t.fold(t.eff('picker', 'candidates', t.lit(null)), t.lit(null), stepRef)

/** 编译一条判定为可求值的 AST，并返回其 def 键（= H({body})）。 */
function compile(entry: Sugar, step: Sugar): { ast: Json; key: string; stepAst: Json } {
  const stepAst = lower(step)
  const stepHash = H({ body: stepAst } as unknown as Json)
  const ast = resolveRefs(lower(entry), { [STEP]: stepHash })
  return { ast, key: H({ body: ast } as unknown as Json), stepAst }
}

function runJudgment(ast: Json, stepAst: Json, candidates: Json): Json {
  const stepHash = H({ body: stepAst } as unknown as Json)
  const effId = H({ run: 'r-exp', i: 0, n: 0 } as unknown as Json)
  const env = envOf({
    defs: { [stepHash]: { body: stepAst } } as unknown as EnvT['defs'],
    results: { [effId]: { ok: true, value: candidates } } as unknown as EnvT['results'],
  })
  const r = evaluate(ast as never, env)
  if ('suspend' in r) throw new Error('expected ok, got suspend')
  if (!r.ok) throw new Error('expected ok, got ' + r.error)
  return r.value
}

describe('实验：判定作为数据', () => {
  it('表达得出：编译 → 解析 $ref → 内核求值，argmin 选出最小值', () => {
    const { ast, stepAst } = compile(entryOf(STEP), argminStep)
    expect(runJudgment(ast, stepAst, [3, 1, 2])).toBe(1)
    expect(runJudgment(ast, stepAst, [5, 4, 9])).toBe(4)
  })

  it('确定性：同源两次编译逐字节一致', () => {
    const a = compile(entryOf(STEP), argminStep)
    const b = compile(entryOf(STEP), argminStep)
    expect(JSON.stringify(a.ast)).toBe(JSON.stringify(b.ast))
    expect(a.key).toBe(b.key)
  })

  it('字段投影：按 item.score 选最小者（get 解锁结构化判定）', () => {
    const { ast, stepAst } = compile(entryOf(STEP), argminByScore)
    const cands = [
      { id: 'a', score: 5 },
      { id: 'b', score: 2 },
      { id: 'c', score: 9 },
    ] as unknown as Json
    expect(runJudgment(ast, stepAst, cands)).toEqual({ id: 'b', score: 2 })
  })

  it('改判定 = 换数据：argmin 与 argmax 的 def 键不同，同输入得不同结果', () => {
    const min = compile(entryOf(STEP), argminStep)
    const max = compile(entryOf(STEP), argmaxStep)
    expect(min.key).not.toBe(max.key)
    expect(runJudgment(min.ast, min.stepAst, [3, 1, 2])).toBe(1)
    expect(runJudgment(max.ast, max.stepAst, [3, 1, 2])).toBe(3)
  })
})
