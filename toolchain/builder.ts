// 类型化 builder：作者用 TS 构造糖化表达式（拿到 IDE / 类型 / 单测）。
// 只产数据，不参与运行期；覆盖 `lower.ts` 的全部糖化键，并提供常用判定组合子。
//
// 组合子约定：
// - `contains(list, value)` / `in(value, list)`：`value` 求值一次后随 fold 累加器传递，可为任意表达式。
// - `find(coll, predicate, projection)`：`predicate` / `projection` 里 `arg(1)` = 当前元素。
// - `argmin`/`argmax` 返回元素本身，`byPath` 是元素上的静态投影路径。

import type { ArithOp, Json, Path, PredOp, Sugar } from './lower.ts'

function isRecord(v: unknown): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 极值 step：acc 为 null 取 item；否则按 `byPath` 取更优者。 */
const extremumStep = (op: 'lt' | 'gt', byPath: Path): Sugar => ({
  k: 'if',
  cond: { k: 'pred', op: 'eq', a: { k: 'arg', i: 0 }, b: { k: 'lit', v: null } },
  then: { k: 'arg', i: 1 },
  else: {
    k: 'if',
    cond: {
      k: 'pred',
      op,
      a: { k: 'get', of: { k: 'arg', i: 1 }, path: byPath },
      b: { k: 'get', of: { k: 'arg', i: 0 }, path: byPath },
    },
    then: { k: 'arg', i: 1 },
    else: { k: 'arg', i: 0 },
  },
})

/**
 * 把 `body` 里的 `bind(name)` 替换为 `arg(0)`（`let1` 用）。
 * 不进入内联 `fold.step` / `call.ref`：那是独立 term 的实参域，替换会让 `arg(0)` 指错。
 * 内层 `let` 若重新绑定同名，其 `in` 内的引用保守不替换。
 */
function substituteBind(s: Sugar, name: string): Sugar {
  switch (s.k) {
    case 'bind':
      return s.name === name ? { k: 'arg', i: 0 } : s
    case 'lit':
    case 'ctx':
    case 'arg':
      return s
    case 'get':
      return { k: 'get', of: substituteBind(s.of, name), path: s.path }
    case 'getOr':
      return {
        k: 'getOr',
        of: substituteBind(s.of, name),
        path: s.path,
        fallback: substituteBind(s.fallback, name),
      }
    case 'let': {
      const shadowed = s.bindings.some(([n]) => n === name)
      return {
        k: 'let',
        bindings: s.bindings.map(([n, v]) => [n, substituteBind(v, name)] as [string, Sugar]),
        in: shadowed ? s.in : substituteBind(s.in, name),
      }
    }
    case 'if':
      return {
        k: 'if',
        cond: substituteBind(s.cond, name),
        then: substituteBind(s.then, name),
        else: substituteBind(s.else, name),
      }
    case 'pred':
      return { k: 'pred', op: s.op, a: substituteBind(s.a, name), b: substituteBind(s.b, name) }
    case 'arith':
      return { k: 'arith', op: s.op, a: substituteBind(s.a, name), b: substituteBind(s.b, name) }
    case 'list':
      return { k: 'list', items: s.items.map((x) => substituteBind(x, name)) }
    case 'obj': {
      const fields: Record<string, Sugar> = {}
      for (const key of Object.keys(s.fields)) fields[key] = substituteBind(s.fields[key], name)
      return { k: 'obj', fields }
    }
    case 'fold':
      return { k: 'fold', coll: substituteBind(s.coll, name), init: substituteBind(s.init, name), step: s.step }
    case 'call':
      return { k: 'call', ref: s.ref, args: s.args.map((x) => substituteBind(x, name)) }
    case 'eff':
      return { k: 'eff', port: s.port, method: s.method, args: substituteBind(s.args, name) }
  }
}

/** 糖化表达式构造器：每个方法返回一个 `Sugar`（数据）。 */
export const t = {
  lit: (v: Json): Sugar => ({ k: 'lit', v }),
  ctx: (path: Path): Sugar => ({ k: 'ctx', path }),
  get: (of: Sugar, path: Path): Sugar => ({ k: 'get', of, path }),
  /** 安全投影：路径缺失/穿标量/越界时返回 `fallback`（惰性求值），不抛 `missing_path`。 */
  getOr: (of: Sugar, path: Path, fallback: Sugar): Sugar => ({ k: 'getOr', of, path, fallback }),
  arg: (i: number): Sugar => ({ k: 'arg', i }),
  bind: (name: string): Sugar => ({ k: 'bind', name }),
  let: (bindings: Array<[string, Sugar]>, body: Sugar): Sugar => ({ k: 'let', bindings, in: body }),
  /**
   * 单次求值绑定：`value` 求值一次后作位置实参传入 `body`（`bind(name)` 处用 `arg(0)` 复用）。
   * 含 `eff` 的中间结果用它可避免写期宏重复发射；`body` 内联 step/ref 里的同名 `bind` 不受替换（fail-closed）。
   */
  let1: (name: string, value: Sugar, body: Sugar): Sugar => t.call(substituteBind(body, name), [value]),
  if: (cond: Sugar, then: Sugar, otherwise: Sugar): Sugar => ({
    k: 'if',
    cond,
    then,
    else: otherwise,
  }),
  pred: (op: PredOp, a: Sugar, b: Sugar): Sugar => ({ k: 'pred', op, a, b }),
  /** 算术（op ∈ add/sub/mul）；操作数须为有限数，结果非有限报 `bad_arith`。 */
  arith: (op: ArithOp, a: Sugar, b: Sugar): Sugar => ({ k: 'arith', op, a, b }),
  add: (a: Sugar, b: Sugar): Sugar => ({ k: 'arith', op: 'add', a, b }),
  sub: (a: Sugar, b: Sugar): Sugar => ({ k: 'arith', op: 'sub', a, b }),
  mul: (a: Sugar, b: Sugar): Sugar => ({ k: 'arith', op: 'mul', a, b }),
  /** 构造新列表（逐项求值）。 */
  list: (items: Sugar[]): Sugar => ({ k: 'list', items }),
  /** 构造新对象（逐字段求值；键序规范）。 */
  obj: (fields: Record<string, Sugar>): Sugar => ({ k: 'obj', fields }),
  /** `step` 可为同包 term 路径，或内联糖化（生成匿名 term）。 */
  fold: (coll: Sugar, init: Sugar, step: string | Sugar): Sugar => ({ k: 'fold', coll, init, step }),
  /** `ref` 可为同包 term 路径，或内联糖化（生成匿名 term，按位置收 `args`）。 */
  call: (ref: string | Sugar, args: Sugar[]): Sugar => ({ k: 'call', ref, args }),
  eff: (port: string, method: string, args: Sugar): Sugar => ({ k: 'eff', port, method, args }),

  /**
   * 成员判断：`list` 中是否存在等于 `value` 的元素。
   * `value` 求值一次后作 callee 实参，再随 fold 累加器传递——故 `value` 可为动态表达式（如 `t.arg(1)`），
   * 不受内联 step 实参域影响。
   */
  contains: (list: Sugar, value: Sugar): Sugar =>
    t.call(
      t.get(
        t.fold(
          t.arg(0),
          t.obj({ needle: t.arg(1), found: t.lit(false) }),
          t.if(
            t.get(t.arg(0), ['found']),
            t.arg(0),
            t.if(
              t.pred('eq', t.arg(1), t.get(t.arg(0), ['needle'])),
              t.obj({ needle: t.get(t.arg(0), ['needle']), found: t.lit(true) }),
              t.arg(0),
            ),
          ),
        ),
        ['found'],
      ),
      [list, value],
    ),
  /** `value ∈ list`（参数顺序对调，读起来更顺）。 */
  in: (value: Sugar, list: Sugar): Sugar => t.contains(list, value),
  /** 按 `byPath` 取最小元素（空集回 null）。 */
  argmin: (coll: Sugar, byPath: Path): Sugar =>
    t.fold(coll, t.lit(null), extremumStep('lt', byPath)),
  /** 按 `byPath` 取最大元素（空集回 null）。 */
  argmax: (coll: Sugar, byPath: Path): Sugar =>
    t.fold(coll, t.lit(null), extremumStep('gt', byPath)),
  /** 首匹配：`predicate` 里 `arg(1)` = 元素；命中后取 `projection`（空/无命中回 null）。 */
  find: (coll: Sugar, predicate: Sugar, projection: Sugar): Sugar =>
    t.fold(
      coll,
      t.lit(null),
      t.if(
        t.pred('ne', t.arg(0), t.lit(null)),
        t.arg(0),
        t.if(predicate, projection, t.lit(null)),
      ),
    ),
  /** 首匹配 + 兜底：无命中回 `fallback`（`find` 结果单次求值，不重复发射效果）。 */
  findOr: (coll: Sugar, predicate: Sugar, projection: Sugar, fallback: Sugar): Sugar =>
    t.call(
      t.if(t.pred('eq', t.arg(0), t.lit(null)), t.arg(1), t.arg(0)),
      [t.find(coll, predicate, projection), fallback],
    ),
  /** 布尔与：惰性（`a` 为假不求 `b`）。 */
  and: (a: Sugar, b: Sugar): Sugar => t.if(a, b, t.lit(false)),
  /** 布尔或：惰性（`a` 为真不求 `b`）。 */
  or: (a: Sugar, b: Sugar): Sugar => t.if(a, t.lit(true), b),
  /** 布尔非。 */
  not: (a: Sugar): Sugar => t.if(a, t.lit(false), t.lit(true)),
  /** 常量对象 bag（效果实参用）：值须是字面 JSON。 */
  bag: (v: { [k: string]: Json }): Sugar => {
    if (!isRecord(v)) throw new Error('bad_sugar')
    return t.lit(v)
  },
}
