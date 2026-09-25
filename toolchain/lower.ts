// 糖化 JSON → 14 原语 AST 的写期降级器。
// 纯函数、零内核依赖：不 import 内核、不算内核哈希（callee 引用留 `{ $ref }` 占位，交宿主入世 A0b 替换）。
// 非法糖化 fail-closed：未知 `k` / 形态不合 / 越界算子 / 未绑定的 `bind` 一律抛 `Error('bad_sugar')`。
// 内联 step / ref：`fold.step` 与 `call.ref` 可写内联糖化；降级时收进「生成 term 表」，函数侧写 `{ $ref: 生成路径 }`。

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Path = (string | number)[]
export type PredOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne'
export type ArithOp = 'add' | 'sub' | 'mul'

/** 糖化表达式：作者写的判定表面形式（见 `spec.md`）。 */
export type Sugar =
  | { k: 'lit'; v: Json }
  | { k: 'ctx'; path: Path }
  | { k: 'get'; of: Sugar; path: Path }
  | { k: 'getOr'; of: Sugar; path: Path; fallback: Sugar }
  | { k: 'arg'; i: number }
  | { k: 'bind'; name: string }
  | { k: 'let'; bindings: Array<[string, Sugar]>; in: Sugar }
  | { k: 'if'; cond: Sugar; then: Sugar; else: Sugar }
  | { k: 'pred'; op: PredOp; a: Sugar; b: Sugar }
  | { k: 'arith'; op: ArithOp; a: Sugar; b: Sugar }
  | { k: 'list'; items: Sugar[] }
  | { k: 'obj'; fields: Record<string, Sugar> }
  | { k: 'fold'; coll: Sugar; init: Sugar; step: string | Sugar }
  | { k: 'call'; ref: string | Sugar; args: Sugar[] }
  | { k: 'eff'; port: string; method: string; args: Sugar }

/** 写期绑定环境：`let` 的名字 → 已降级的值（降级产物，供 `bind` 复用）。 */
export type Bindings = Record<string, Json>

/** 生成 term 的路径前缀：保留命名空间，源 term 不得占用。 */
export const GEN_PREFIX = 'terms/__gen/'

/** 降级上下文：内联 step / ref 的落点。`emit` 降级内联糖化并登记为生成 term，返回其路径。 */
export interface LowerCtx {
  emit(sugar: Sugar, env: Bindings): string
}

const PRED_OPS: readonly string[] = ['lt', 'le', 'gt', 'ge', 'eq', 'ne']
const ARITH_OPS: readonly string[] = ['add', 'sub', 'mul']

function isRecord(v: unknown): v is { [k: string]: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPath(v: unknown): v is Path {
  return (
    Array.isArray(v) &&
    v.every((s) => typeof s === 'string' || (typeof s === 'number' && Number.isInteger(s)))
  )
}

function isRef(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 稳定序列化（键排序、递归），仅供生成路径取名——与内核 `canonicalJson` 无关。 */
function stableStringify(v: Json): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const rec = v as { [k: string]: Json }
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`
}

function fnv1a(str: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 生成路径名：内容派生（同源同产物、跨调用点可复用），非内核哈希。 */
function genName(ast: Json): string {
  const s = stableStringify(ast)
  return fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x9e3779b9) + s.length.toString(16)
}

/** `fold.step` / `call.ref`：具名路径原样返回；内联糖化经 `ctx` 落成生成路径。 */
function refOf(v: unknown, env: Bindings, ctx?: LowerCtx): string {
  if (typeof v === 'string') {
    if (!isRef(v)) throw new Error('bad_sugar')
    return v
  }
  if (ctx === undefined) throw new Error('bad_sugar') // 内联糖化必须给 LowerCtx
  if (!isRecord(v)) throw new Error('bad_sugar')
  return ctx.emit(v as unknown as Sugar, env)
}

/**
 * 降级一个糖化表达式为原语 AST（`{ $ref }` 占位未解析）。
 * @param s 糖化表达式（形态不合抛 `Error('bad_sugar')`）
 * @param env 写期绑定环境（`let` 引入；缺省空）
 * @param ctx 内联 step / ref 的落点；缺省时内联糖化报 `bad_sugar`
 * @returns 原语 AST（Json）
 */
export function lower(s: Sugar, env: Bindings = {}, ctx?: LowerCtx): Json {
  if (!isRecord(s)) throw new Error('bad_sugar')
  switch (s['k']) {
    case 'lit':
      return ['c', s['v'] as Json]
    case 'ctx':
      if (!isPath(s['path'])) throw new Error('bad_sugar')
      return ['g', s['path'] as Json]
    case 'get':
      if (!isPath(s['path'])) throw new Error('bad_sugar')
      return ['get', lower(s['of'] as Sugar, env, ctx), s['path'] as Json]
    case 'getOr':
      if (!isPath(s['path'])) throw new Error('bad_sugar')
      return [
        'getOr',
        lower(s['of'] as Sugar, env, ctx),
        s['path'] as Json,
        lower(s['fallback'] as Sugar, env, ctx),
      ]
    case 'arg': {
      const i = s['i']
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) throw new Error('bad_sugar')
      return ['v', i]
    }
    case 'bind': {
      const name = s['name']
      if (typeof name !== 'string' || !Object.hasOwn(env, name)) throw new Error('bad_sugar')
      return structuredClone(env[name])
    }
    case 'let': {
      const bindings = s['bindings']
      if (!Array.isArray(bindings)) throw new Error('bad_sugar')
      let scope: Bindings = env
      for (const binding of bindings) {
        if (!Array.isArray(binding) || binding.length !== 2) throw new Error('bad_sugar')
        const [name, value] = binding as [unknown, unknown]
        if (typeof name !== 'string' || name.length === 0) throw new Error('bad_sugar')
        scope = { ...scope, [name]: lower(value as Sugar, scope, ctx) } // 顺序绑定：后者可见前者
      }
      return lower(s['in'] as Sugar, scope, ctx)
    }
    case 'if':
      return [
        'if',
        lower(s['cond'] as Sugar, env, ctx),
        lower(s['then'] as Sugar, env, ctx),
        lower(s['else'] as Sugar, env, ctx),
      ]
    case 'pred': {
      const op = s['op']
      if (typeof op !== 'string' || !PRED_OPS.includes(op)) throw new Error('bad_sugar')
      return ['pred', op, lower(s['a'] as Sugar, env, ctx), lower(s['b'] as Sugar, env, ctx)]
    }
    case 'arith': {
      const op = s['op']
      if (typeof op !== 'string' || !ARITH_OPS.includes(op)) throw new Error('bad_sugar')
      return ['arith', op, lower(s['a'] as Sugar, env, ctx), lower(s['b'] as Sugar, env, ctx)]
    }
    case 'list': {
      const items = s['items']
      if (!Array.isArray(items)) throw new Error('bad_sugar')
      return ['list', items.map((x) => lower(x as Sugar, env, ctx))]
    }
    case 'obj': {
      const fields = s['fields']
      if (!isRecord(fields)) throw new Error('bad_sugar')
      const out: { [k: string]: Json } = {}
      for (const key of Object.keys(fields)) {
        out[key] = lower((fields as { [k: string]: Sugar })[key], env, ctx)
      }
      return ['obj', out]
    }
    case 'fold': {
      // 函数侧包成 Const：宿主把 `{ $ref }` 换成裸哈希串后得 ["c", <hash>]，机器据此直查 defs
      return [
        'fold',
        lower(s['coll'] as Sugar, env, ctx),
        lower(s['init'] as Sugar, env, ctx),
        ['c', { $ref: refOf(s['step'], env, ctx) }],
      ]
    }
    case 'call': {
      const args = s['args']
      if (!Array.isArray(args)) throw new Error('bad_sugar')
      return [
        'call',
        ['c', { $ref: refOf(s['ref'], env, ctx) }],
        args.map((a) => lower(a as Sugar, env, ctx)),
      ]
    }
    case 'eff': {
      const port = s['port']
      const method = s['method']
      if (typeof port !== 'string' || typeof method !== 'string') throw new Error('bad_sugar')
      return ['eff', port, method, lower(s['args'] as Sugar, env, ctx)]
    }
    default:
      throw new Error('bad_sugar')
  }
}

export interface LoweredProgram {
  /** term 路径 → 降级后原语 AST（含生成 term）。 */
  asts: Record<string, Json>
  /** term 路径 → 源糖化（生成 term 指向其内联糖化）；供源映射。 */
  sugars: Record<string, Json>
  /** 本次降级新生成的 term 路径（稳定内容派生）。 */
  generated: string[]
}

/**
 * 降级整个程序：源 term + 内联 step/ref 生成的 term 一并落表。
 * 生成路径由内容稳定派生，同源两次调用逐字节一致。
 */
export function lowerProgram(source: Record<string, Json>): LoweredProgram {
  const asts: Record<string, Json> = {}
  const sugars: Record<string, Json> = {}
  const generated: string[] = []
  const ctx: LowerCtx = {
    emit(sugar, env) {
      const ast = lower(sugar, env, ctx)
      const path = `${GEN_PREFIX}${genName(ast)}.json`
      asts[path] = ast
      sugars[path] = sugar as unknown as Json
      if (!generated.includes(path)) generated.push(path)
      return path
    },
  }
  for (const [path, sugar] of Object.entries(source)) {
    if (path.startsWith(GEN_PREFIX)) throw new Error('reserved_path')
    asts[path] = lower(sugar as unknown as Sugar, {}, ctx)
    sugars[path] = sugar
  }
  return { asts, sugars, generated }
}

/** 收集降级后 AST 里的全部 `{ $ref }` 路径（引用图用）。 */
export function astRefs(ast: Json): string[] {
  const out: string[] = []
  const visit = (v: Json): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const rec = v as { [k: string]: Json }
    const keys = Object.keys(rec)
    if (keys.length === 1 && keys[0] === '$ref' && typeof rec['$ref'] === 'string') {
      out.push(rec['$ref'] as string)
      return
    }
    for (const k of keys) visit(rec[k])
  }
  visit(ast)
  return out
}
