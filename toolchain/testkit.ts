// 测试器（独立入口，可依赖内核）：把判定程序编译成 defs、驱动效果回灌、调用内核 `evaluate`。
// 只服务作者侧测试；不进插件包、不进运行路径（依赖边界见 docs/term-toolchain.md §七/§八）。

import { H, eval as evaluate } from '../packages/kernel/index.ts'
import type { Def, Hash, Json } from '../packages/kernel/index.ts'
import { astRefs, lowerProgram } from './lower.ts'
import type { Path } from './lower.ts'
import { sourceAt } from './sourcemap.ts'
import { validateProgram } from './validate.ts'
import type { Issue, Program } from './validate.ts'

/** 把 AST 里的 `{ $ref }` 换成真实 def 哈希（镜像宿主 `replaceTermRefs`）。 */
export function resolveRefs(ast: Json, table: Record<string, string>): Json {
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

export interface Compiled {
  defs: Record<Hash, Def>
  keys: Record<string, Hash> // term 路径 → def 键
  sugars: Record<string, Json> // term 路径 → 源糖化（含生成 term），供源映射
}

/** callee 先于 caller 的拓扑序（引用图须无环；由校验器保证）。 */
function topoOrder(asts: Record<string, Json>): string[] {
  const order: string[] = []
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (path: string): void => {
    const st = state.get(path) ?? 0
    if (st !== 0) return
    state.set(path, 1)
    for (const ref of astRefs(asts[path])) {
      if (Object.hasOwn(asts, ref)) visit(ref)
    }
    state.set(path, 2)
    order.push(path)
  }
  for (const path of Object.keys(asts)) visit(path)
  return order
}

/** 编译整个判定程序：每个 term 降级 → 解析 `$ref` → 算 def 键 → 建 defs。 */
export function compileProgram(p: Program): Compiled {
  const { asts, sugars } = lowerProgram(p.terms)
  const keys: Record<string, Hash> = {}
  const defs: Record<Hash, Def> = {}
  for (const path of topoOrder(asts)) {
    const ast = resolveRefs(asts[path], keys)
    const hash = H({ body: ast } as Json)
    keys[path] = hash
    defs[hash] = { body: ast }
  }
  return { defs, keys, sugars }
}

export interface Fixtures {
  ctx?: Json
  args?: Json[]
  effects?: Json[] // 按发射顺序回灌的效果值
  trace?: boolean // 为真时结果附已发射效果的轨迹（port/method/args）
}

/** 一次效果发射的轨迹（断言「恰好发射一次 / 某效果未发射」用）。 */
export interface EffTrace {
  port: string
  method: string
  args: Json
}

export type RunResult =
  | { ok: true; value: Json; trace?: EffTrace[] }
  | { ok: false; error: string; at?: Path; def?: Hash; callAt?: Path; trace?: EffTrace[] }

export type Invalid = { ok: false; error: 'invalid'; issues: Issue[] }
export type RunOutcome = RunResult | Invalid

/** 判定 `runTerm` 的结果是否为「静态校验不过」。 */
export function isInvalid(r: RunOutcome): r is Invalid {
  return !r.ok && 'issues' in r
}

/** 求值一个 term（不校验）：效果不足回 `missing_effect`，其余错误码原样透出。 */
export function runTermUnchecked(p: Program, termPath: string, fixtures: Fixtures = {}): RunResult {
  const compiled = compileProgram(p)
  const hash = compiled.keys[termPath]
  const ast = hash === undefined ? undefined : compiled.defs[hash].body
  if (ast === undefined) return { ok: false, error: 'missing_term' }

  const effects = [...(fixtures.effects ?? [])]
  const results: Record<Hash, { ok: boolean; value?: Json }> = {}
  const trace: EffTrace[] = []
  const withTrace = <T extends RunResult>(r: T): T =>
    fixtures.trace ? ({ ...r, trace } as T) : r
  for (;;) {
    const env = {
      ctx: fixtures.ctx ?? null,
      args: fixtures.args ?? [],
      defs: compiled.defs,
      results,
      caps: {},
      limits: { gas: 1000, depth: 16 },
      run: 'testkit',
      i: 0,
      n: 0,
      gas: 1000,
      depth: 0,
      peakDepth: 0,
    }
    const r = evaluate(ast as never, env as never)
    if ('suspend' in r) {
      trace.push({ port: r.suspend.port, method: r.suspend.method, args: r.suspend.args })
      if (effects.length === 0) return withTrace({ ok: false, error: 'missing_effect' })
      results[r.suspend.id] = { ok: true, value: effects.shift() as Json }
      continue
    }
    if (!r.ok) {
      return withTrace({ ok: false, error: r.error, at: r.at, def: r.def, callAt: r.callAt })
    }
    return withTrace({ ok: true, value: r.value })
  }
}

/** 求值一个 term：默认先静态校验，不过回 `{ ok:false, error:'invalid', issues }`。 */
export function runTerm(p: Program, termPath: string, fixtures: Fixtures = {}): RunOutcome {
  const verdict = validateProgram(p)
  if (!verdict.ok) return { ok: false, error: 'invalid', issues: verdict.issues }
  return runTermUnchecked(p, termPath, fixtures)
}

/**
 * 把 `runTerm` 的错误映射回糖化源：定位到 term 路径 + 源指针。
 * `def` 存在时先按编译出的 def 键找到被调 term，再在它内部按 `at` 定位。
 */
export function explainError(
  p: Program,
  termPath: string,
  error: { at?: Path; def?: Hash },
): { term: string; pointer: string; approx: boolean } {
  let term = termPath
  const compiled = compileProgram(p)
  if (error.def !== undefined) {
    const found = Object.entries(compiled.keys).find(([, hash]) => hash === error.def)
    if (found !== undefined) term = found[0]
  }
  const sugar = compiled.sugars[term]
  const mapped =
    sugar === undefined ? { pointer: '', approx: true } : sourceAt(sugar, error.at ?? [])
  return { term, ...mapped }
}

/** 保留旧名：`runTerm` 现已默认校验，二者等价。 */
export const runTermValidated = runTerm
