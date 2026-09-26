// 静态校验器：编译期 fail-closed，把非法判定拦在入世之前。
// 零内核依赖（只读糖化结构，不算哈希）。错误带源 JSON 指针，供作者定位。

import { GEN_PREFIX, lower } from './lower.ts'
import type { Json, LowerCtx, Sugar } from './lower.ts'

/** 一个待校验的判定程序：term 路径 → 糖化表达式 + 该包的能力声明。 */
export interface Program {
  terms: Record<string, Json> // 如 'terms/pick.json' → 糖化表达式
  implements?: string[] // 自身能力类
  pins?: Record<string, string> // 能力类 → 目标身份（引用其他插件）
  methods?: Record<string, string[]> // 能力类 → 方法名
}

export interface Issue {
  path: string // 源 JSON 指针（如 'terms/pick.json/fold/coll'）
  message: string
}

function isRecord(v: unknown): v is { [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 深度遍历糖化表达式；`visit` 收到每个节点与其 JSON 指针。 */
export function walkSugar(
  s: unknown,
  path: string,
  visit: (s: Sugar, path: string) => void,
): void {
  if (!isRecord(s)) return
  visit(s as Sugar, path)
  const at = (key: string): void => walkSugar(s[key], `${path}/${key}`, visit)
  switch (s['k']) {
    case 'get':
      at('of')
      break
    case 'getOr':
      at('of')
      at('fallback')
      break
    case 'let': {
      const bindings = s['bindings']
      if (Array.isArray(bindings)) {
        bindings.forEach((pair, i) => {
          if (Array.isArray(pair)) walkSugar(pair[1], `${path}/bindings/${i}/1`, visit)
        })
      }
      at('in')
      break
    }
    case 'if':
      at('cond')
      at('then')
      at('else')
      break
    case 'pred':
      at('a')
      at('b')
      break
    case 'arith':
      at('a')
      at('b')
      break
    case 'list': {
      const items = s['items']
      if (Array.isArray(items)) items.forEach((x, i) => walkSugar(x, `${path}/items/${i}`, visit))
      break
    }
    case 'obj': {
      const fields = s['fields']
      if (isRecord(fields)) {
        for (const key of Object.keys(fields)) {
          walkSugar((fields as { [k: string]: unknown })[key], `${path}/fields/${key}`, visit)
        }
      }
      break
    }
    case 'fold':
      at('coll')
      at('init')
      if (typeof s['step'] !== 'string') at('step') // 内联 step：继续下钻校验
      break
    case 'call': {
      if (typeof s['ref'] !== 'string') at('ref') // 内联 ref：继续下钻校验
      const args = s['args']
      if (Array.isArray(args)) args.forEach((a, i) => walkSugar(a, `${path}/args/${i}`, visit))
      break
    }
    case 'eff':
      at('args')
      break
    default:
      break
  }
}

/** 收集一个糖化表达式直接引用的包内 term 路径（`fold.step` / `call.ref`）。 */
export function sugarRefs(s: Json): string[] {
  const out: string[] = []
  walkSugar(s, '', (node) => {
    if (node.k === 'fold' && typeof node.step === 'string') out.push(node.step)
    if (node.k === 'call' && typeof node.ref === 'string') out.push(node.ref)
  })
  return out
}

/** 该糖化子树里是否含 `eff`（写期宏复制它会导致效果重复发射）。 */
function containsEff(s: unknown): boolean {
  let found = false
  walkSugar(s, '', (n) => {
    if (n.k === 'eff') found = true
  })
  return found
}

/** 该糖化子树里 `bind(name)` 的出现次数。 */
function countBinds(s: unknown, name: string): number {
  let count = 0
  walkSugar(s, '', (n) => {
    if (n.k === 'bind' && n.name === name) count += 1
  })
  return count
}

/** 引用图是否无环（结点 = term 路径）。 */function acyclic(terms: Record<string, Json>): string[] {
  const cycles: string[] = []
  const state = new Map<string, 0 | 1 | 2>() // 0=未访 1=在栈 2=完成
  const visit = (path: string): void => {
    const st = state.get(path) ?? 0
    if (st === 2) return
    if (st === 1) {
      cycles.push(path)
      return
    }
    state.set(path, 1)
    for (const ref of sugarRefs(terms[path])) {
      if (Object.hasOwn(terms, ref)) visit(ref)
    }
    state.set(path, 2)
  }
  for (const path of Object.keys(terms)) visit(path)
  return cycles
}

/**
 * 校验一个判定程序。返回全部问题（空即通过）。
 * 覆盖：形态（lower）/ 引用存在 / 引用无环 / eff 的 port 与 method 声明。
 */
export function validateProgram(p: Program): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = []
  const ports = new Set([
    ...(p.implements ?? []),
    ...Object.keys(p.pins ?? {}),
    ...Object.keys(p.methods ?? {}), // 声明了方法的能力类即视为已声明端口，减少 implements/methods 双填摩擦
  ])
  // 内联 step / ref 的落点：只为形态检查，产物丢弃
  const discard: LowerCtx = {
    emit(s, env) {
      lower(s, env, discard)
      return `${GEN_PREFIX}discard.json`
    },
  }

  for (const [termPath, sugar] of Object.entries(p.terms)) {
    if (termPath.startsWith(GEN_PREFIX)) {
      issues.push({ path: termPath, message: 'reserved_path' })
      continue
    }
    try {
      lower(sugar as unknown as Sugar, {}, discard)
    } catch (e) {
      issues.push({ path: termPath, message: (e as Error).message })
      continue // 形态不合，后续结构检查无意义
    }
    walkSugar(sugar, termPath, (node, at) => {
      if (node.k === 'let') {
        const bindings = node.bindings
        if (Array.isArray(bindings)) {
          bindings.forEach((pair, i) => {
            if (!Array.isArray(pair)) return
            const [name, value] = pair as [unknown, unknown]
            if (typeof name !== 'string') return
            // `let` 是写期宏：绑定被引用 N 次即复制 N 份；含 eff 时会重复发射效果
            if (countBinds(node.in, name) > 1 && containsEff(value)) {
              issues.push({ path: `${at}/bindings/${i}/1`, message: `effect_reemitted: ${name}` })
            }
          })
        }
      }
      if (node.k === 'fold' && typeof node.step === 'string' && !Object.hasOwn(p.terms, node.step)) {
        issues.push({ path: `${at}/step`, message: `missing_ref: ${node.step}` })
      }
      if (node.k === 'call' && typeof node.ref === 'string' && !Object.hasOwn(p.terms, node.ref)) {
        issues.push({ path: `${at}/ref`, message: `missing_ref: ${node.ref}` })
      }
      if (node.k === 'eff') {
        const port = node.port
        if (typeof port === 'string' && !ports.has(port)) {
          issues.push({ path: `${at}/port`, message: `undeclared_port: ${port}` })
        }
        // 方法名只在自调用（port ∈ implements，或仅声明了 methods 的能力类）可校验；
        // 跨身份（port 只在 pins 里）的方法名住在被调身份声明里，工具链只有单包源、看不到被调声明，
        // 故放弃校验（宿主入世按被调身份声明判，两侧口径刻意不同，见 docs/term-toolchain.md §六.1）。
        const selfDeclared =
          typeof port === 'string' &&
          ((p.implements ?? []).includes(port) || Object.hasOwn(p.methods ?? {}, port))
        if (selfDeclared) {
          const declared = p.methods?.[port]
          if (declared === undefined) {
            // 契约：自调用 port 必须在 methods 里有条目（哪怕空数组）；否则方法名无从校验
            issues.push({ path: `${at}/port`, message: `undeclared_method: ${port}` })
          } else if (typeof node.method === 'string' && !declared.includes(node.method)) {
            issues.push({ path: `${at}/method`, message: `undeclared_method: ${port}.${node.method}` })
          }
        }
      }
    })
  }

  for (const path of acyclic(p.terms)) {
    issues.push({ path, message: 'term_cycle' })
  }

  return { ok: issues.length === 0, issues }
}
