// 归约机求值实现：14 原语的逐条求值、分派表与 cmp 全序；公共面由 machine.ts 转口。
// 严格深度优先左到右、无 lambda / 无递归 / 无 while。
// 内部求值返回 Json 并抛 KernelError（层层干净），公共 `evaluation` 收三态；
// `env` 是共享可变对象（gas / depth / n 靠同一实例累加，evalCall 禁止展开复制）。

import { H } from './hash.ts'
import { TYPE_ORDER, isHash, isRecord, t } from './value.ts'
import { KernelError } from './types.ts'
import type { Env, EvalResult, Term, TermTag } from './machine.ts'
import type { EffRequest, Hash, Json, Path } from './types.ts'

/** 14 原语头；机器分派与 run 的事前 bad_term 检查共用此名单。 */
export const TERM_TAGS: ReadonlySet<string> = new Set([
  'c',
  'g',
  'get',
  'getOr',
  'v',
  'cmp',
  'pred',
  'if',
  'fold',
  'eff',
  'call',
  'arith',
  'list',
  'obj',
])

/** `pred` 的谓词算子；返回 Bool，复用 `cmp` 的全序（不引入隐式转换）。 */
const PRED_OPS: ReadonlySet<string> = new Set(['lt', 'le', 'gt', 'ge', 'eq', 'ne'])

/** `arith` 的算术算子；仅有限数，结果非有限报 `bad_arith`。 */
const ARITH_OPS: ReadonlySet<string> = new Set(['add', 'sub', 'mul'])

/** 挂起信号：不是错误，是与三态并列的第三条返回路径（——不捕获续体，结果回灌后从入口重跑）。 */
class Suspend {
  readonly request: EffRequest
  constructor(request: EffRequest) {
    this.request = request
  }
}

/**
 * 求值路径的父链节点：逐节点只挂一个父指针，成功路径不构造路径数组；
 * 失败时由 `atPath` 从当前节点回溯出从当前 def 入口起的 Path。
 */
interface AtNode {
  parent: AtNode | null
  seg: string | number
}

/** 在父链末端接一个子段（不展开父路径）。 */
function atChild(at: AtNode | null, seg: string | number): AtNode {
  return { parent: at, seg }
}

/** 把父链回溯为路径（从根到当前节点）；只在失败路径调用。 */
function atPath(at: AtNode | null): Path {
  const out: Path = []
  for (let node = at; node !== null; node = node.parent) out.push(node.seg)
  out.reverse()
  return out
}

/**
 * 全序比较：跨型按 TYPE_ORDER 下标；同型逐结构。值域内（有限数由 t() 保证）永不抛错，
 * 非有限 number 在进入前由 t() 报 'nonfinite'。
 * @param a 左值——必须是 Json 域内值（不做隐式转换，true 与 1 不属同型可比对）
 * @param b 右值
 * @returns -1 | 0 | 1
 * @throws KernelError('nonfinite') 任一侧是非有限数
 */
export function cmp(a: Json, b: Json): number {
  const ta = t(a)
  const tb = t(b)
  if (ta !== tb) return TYPE_ORDER.indexOf(ta) < TYPE_ORDER.indexOf(tb) ? -1 : 1
  switch (ta) {
    case 'Bool':
      return (a ? 1 : 0) - (b ? 1 : 0)
    case 'Int': {
      const na = a as number
      const nb = b as number
      return na < nb ? -1 : na > nb ? 1 : 0
    }
    case 'Str': {
      const sa = a as string
      const sb = b as string
      return sa < sb ? -1 : sa > sb ? 1 : 0 // 逐 code unit，短者在前
    }
    case 'None':
      return 0
    case 'List': {
      const la = a as Json[]
      const lb = b as Json[]
      const shared = Math.min(la.length, lb.length)
      for (let i = 0; i < shared; i++) {
        const c = cmp(la[i], lb[i])
        if (c !== 0) return c
      }
      return la.length < lb.length ? -1 : la.length > lb.length ? 1 : 0
    }
    default: {
      // 与 canonicalJson / deepEq 同口径：先滤 undefined 键，否则"哈希相等而 cmp ≠ 0"。
      // 单次遍历两对象：先各取最小/最大键与首个值差，再按排序序上的首个差异定序（不排序键）。
      const ra = a as { [k: string]: Json | undefined }
      const rb = b as { [k: string]: Json | undefined }
      let valueKey: string | undefined // 最小「值不同」的共有键
      let valueCmp = 0
      let onlyA: string | undefined // 最小「仅 a 有」的键
      let onlyB: string | undefined // 最小「仅 b 有」的键
      let maxA: string | undefined
      let maxB: string | undefined
      for (const key of Object.keys(ra)) {
        const left = ra[key]
        if (left === undefined) continue
        if (maxA === undefined || key > maxA) maxA = key
        const right = rb[key]
        if (right === undefined) {
          if (onlyA === undefined || key < onlyA) onlyA = key
          continue
        }
        const c = cmp(left, right)
        if (c !== 0 && (valueKey === undefined || key < valueKey)) {
          valueKey = key
          valueCmp = c
        }
      }
      for (const key of Object.keys(rb)) {
        if (rb[key] === undefined) continue
        if (maxB === undefined || key > maxB) maxB = key
        if (ra[key] === undefined && (onlyB === undefined || key < onlyB)) onlyB = key
      }
      let firstKey: string | undefined
      let firstCmp = 0
      const consider = (key: string | undefined, c: number): void => {
        if (key !== undefined && (firstKey === undefined || key < firstKey)) {
          firstKey = key
          firstCmp = c
        }
      }
      consider(valueKey, valueCmp)
      // 仅 a 有的最小键：b 若还有更大的键则 a 在前，否则 b 已结束、a 在后
      if (onlyA !== undefined) consider(onlyA, maxB !== undefined && maxB > onlyA ? -1 : 1)
      // 仅 b 有的最小键：a 若还有更大的键则 a 在后，否则 a 已结束、a 在前
      if (onlyB !== undefined) consider(onlyB, maxA !== undefined && maxA > onlyB ? 1 : -1)
      return firstCmp
    }
  }
}

type Handler = (node: Json[], env: Env, at: AtNode | null) => Json

/**
 * 14 原语分派表：按 `term[0]` 取处理函数，未知头报 `bad_term`。
 * 每个节点扣 1 gas 与一层 depth 在 `evalNode` 统一记账，处理函数只负责各自语义。
 */
const HANDLERS: ReadonlyMap<TermTag, Handler> = new Map<TermTag, Handler>([
  ['c', (node) => evalConst(node)],
  ['g', (node, env) => evalGet(node, env)],
  ['get', (node, env, at) => evalGetAt(node, env, at)],
  ['getOr', (node, env, at) => evalGetOr(node, env, at)],
  ['v', (node, env) => evalVar(node, env)],
  ['cmp', (node, env, at) => evalCmp(node, env, at)],
  ['pred', (node, env, at) => evalPred(node, env, at)],
  ['if', (node, env, at) => evalIf(node, env, at)],
  ['fold', (node, env, at) => evalFold(node, env, at)],
  ['eff', (node, env, at) => evalEff(node, env, at)],
  ['call', (node, env, at) => evalCallTerm(node, env, at)],
  ['arith', (node, env, at) => evalArith(node, env, at)],
  ['list', (node, env, at) => evalList(node, env, at)],
  ['obj', (node, env, at) => evalObj(node, env, at)],
])

/**
 * 求值一个 Term：返回三态而非抛错——`ok:false` 携带机器错误码、
 * `suspend` 携带待解 EffRequest（每 directive 至多一个 pending）。
 * @param term 14 原语之一（形态不合报 'bad_term'）
 * @param env 共享可变环境（gas / depth / n 记账其上）
 * @returns EvalResult 三态
 */
export function evaluation(term: Term, env: Env): EvalResult {
  try {
    return { ok: true, value: evalNode(term as unknown as Json | undefined, env, null) }
  } catch (e) {
    if (e instanceof Suspend) return { suspend: e.request }
    if (e instanceof KernelError) {
      return { ok: false, error: e.code, at: e.at, def: e.def, callAt: e.callAt }
    }
    throw e
  }
}

/**
 * `at` 是从**当前 def 的入口**到本节点的父链；失败时由最近的一层 `evalNode` 回溯成 `KernelError.at`。
 * 进入 `call`/`fold` 的被调 term 后失败时，`evalCall` 另记 `def`（被调 term 哈希）与 `callAt`（调用点路径）。
 */
function evalNode(term: Json | undefined, env: Env, at: AtNode | null): Json {
  env.gas -= 1 // 每个 Term 节点扣 1；剩余量即 env.gas
  env.depth += 1
  try {
    if (env.gas < 0) throw new KernelError('gas')
    if (env.depth > env.peakDepth) env.peakDepth = env.depth
    if (env.depth > env.limits.depth) throw new KernelError('depth')
    if (!Array.isArray(term)) throw new KernelError('bad_term')
    const node = term as Json[]
    const handler = HANDLERS.get(node[0] as TermTag)
    // 头不是 14 原语之一——字面 "let" 等语法扩展头即在此被拒
    if (handler === undefined) throw new KernelError('bad_term')
    return handler(node, env, at)
  } catch (e) {
    if (e instanceof KernelError && e.at === undefined) e.at = atPath(at)
    throw e
  } finally {
    env.depth -= 1 // 每条返回路径都减，含 suspend / Err（规范的一部分）
  }
}

function evalConst(node: Json[]): Json {
  if (node.length !== 2) throw new KernelError('bad_term')
  return node[1] as Json
}

function evalGet(node: Json[], env: Env): Json {
  if (node.length !== 2) throw new KernelError('bad_term')
  return walk(env.ctx, node[1] as Path)
}

/**
 * `["get", value, path]` → 对求值结果沿静态 path 投影（与 `g` 对称：`g` 的根是 `ctx`）。
 * 缺失 / 穿过标量抛 `missing_path`；空 path 返回该值本身。
 */
function evalGetAt(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 3) throw new KernelError('bad_term')
  return walk(evalNode(node[1], env, atChild(at, 1)), node[2] as Path)
}

/**
 * `["getOr", value, path, default]` → 同 `get`，但路径缺失时惰性求 `default`（不抛 `missing_path`）。
 * path 形态不合（非数组）报 `bad_term`；`value` 内的 `nonfinite` 等值域错误照常冒泡。
 */
function evalGetOr(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4 || !Array.isArray(node[2])) throw new KernelError('bad_term')
  const value = evalNode(node[1], env, atChild(at, 1))
  try {
    return walk(value, node[2] as Path)
  } catch (e) {
    if (e instanceof KernelError && e.code === 'missing_path') {
      return evalNode(node[3], env, atChild(at, 3))
    }
    throw e
  }
}

function evalVar(node: Json[], env: Env): Json {
  if (node.length !== 2) throw new KernelError('bad_term')
  const k = node[1]
  // 不用 ?? 判缺失：args[k] 本身可以是 null
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k >= env.args.length) {
    throw new KernelError('bad_var')
  }
  return env.args[k] as Json
}

function evalCmp(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 3) throw new KernelError('bad_term')
  const left = evalNode(node[1], env, atChild(at, 1)) // 严格左→右
  return cmp(left, evalNode(node[2], env, atChild(at, 2)))
}

/**
 * `["pred", op, a, b]` → Bool：复用 `cmp` 的全序，是 `if` 唯一可计算出来的布尔来源。
 * 形态不合（长度 / 未知 op）报 `bad_term`；`cmp` 的 `nonfinite` 照常冒泡。
 */
function evalPred(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const op = node[1]
  if (typeof op !== 'string' || !PRED_OPS.has(op)) {
    throw new KernelError('bad_term')
  }
  const left = evalNode(node[2], env, atChild(at, 2)) // 严格左→右
  const c = cmp(left, evalNode(node[3], env, atChild(at, 3)))
  switch (op) {
    case 'lt':
      return c < 0
    case 'le':
      return c <= 0
    case 'gt':
      return c > 0
    case 'ge':
      return c >= 0
    case 'eq':
      return c === 0
    default:
      return c !== 0 // ne
  }
}

function evalIf(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const cond = evalNode(node[1], env, atChild(at, 1))
  if (t(cond) !== 'Bool') throw new KernelError('bad_cond')
  return evalNode(cond ? node[2] : node[3], env, atChild(at, cond ? 2 : 3)) // 不预求另一支
}

function evalFold(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const coll = evalNode(node[1], env, atChild(at, 1))
  if (t(coll) !== 'List') throw new KernelError('not_a_list')
  const fun = evalNode(node[3], env, atChild(at, 3)) // 函数侧每次 fold 求值恰一次（其内 eff 至多一次发射）
  let acc = evalNode(node[2], env, atChild(at, 2))
  const items = coll as Json[]
  const stepAt = atChild(at, 3)
  for (let i = 0; i < items.length; i++) {
    env.gas -= 1 // 每轮迭代再扣 1
    if (env.gas < 0) throw new KernelError('gas')
    acc = evalCall(fun, [acc, items[i], i], env, stepAt) // 目标循环内恒定；挂起则冒泡
  }
  return acc
}

function evalEff(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const argValue = evalNode(node[3], env, atChild(at, 3))
  const id = H({ run: env.run, i: env.i, n: env.n }) // 只带 n 会碰撞，必须带 directive 序号 i
  env.n += 1
  const r = env.results[id]
  if (r === undefined) {
    throw new Suspend({
      id,
      port: node[1] as string,
      method: node[2] as string,
      args: argValue,
      caps: env.caps,
    })
  }
  if (!r.ok) throw new KernelError('eff_error')
  return r.value as Json
}

function evalCallTerm(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 3) throw new KernelError('bad_term')
  const fun = evalNode(node[1], env, atChild(at, 1)) // 函数侧严格先于实参表
  const argTerms = node[2]
  if (!Array.isArray(argTerms)) throw new KernelError('bad_term')
  const values: Json[] = []
  for (let i = 0; i < argTerms.length; i++) {
    values.push(evalNode(argTerms[i], env, atChild(atChild(at, 2), i))) // 逐个、左到右
  }
  return evalCall(fun, values, env, at)
}

/**
 * `["arith", op, a, b]` → 有限数运算（op ∈ add/sub/mul）。仅接受 Int 操作数，
 * 结果非有限（溢出）抛 `bad_arith`；未知 op / 元数不合抛 `bad_term`。
 */
function evalArith(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const op = node[1]
  if (typeof op !== 'string' || !ARITH_OPS.has(op)) {
    throw new KernelError('bad_term')
  }
  const left = evalNode(node[2], env, atChild(at, 2)) // 严格左→右
  const right = evalNode(node[3], env, atChild(at, 3))
  if (t(left) !== 'Int' || t(right) !== 'Int') throw new KernelError('bad_arith')
  const a = left as number
  const b = right as number
  const r = op === 'add' ? a + b : op === 'sub' ? a - b : a * b
  if (!Number.isFinite(r)) throw new KernelError('bad_arith')
  return r
}

/** `["list", [term…]]` → 逐个求值构造新列表（严格左→右）。 */
function evalList(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 2 || !Array.isArray(node[1])) throw new KernelError('bad_term')
  const terms = node[1] as Json[]
  const out: Json[] = new Array<Json>(terms.length)
  for (let i = 0; i < terms.length; i++) {
    out[i] = evalNode(terms[i], env, atChild(atChild(at, 1), i))
  }
  return out
}

/** `["obj", { k: term… }]` → 逐个求值构造新对象（键按 code-unit 升序，与 canonicalJson 同序）。 */
function evalObj(node: Json[], env: Env, at: AtNode | null): Json {
  if (node.length !== 2 || !isRecord(node[1])) throw new KernelError('bad_term')
  const fields = node[1]
  const out: { [k: string]: Json } = {}
  for (const key of Object.keys(fields).sort()) {
    out[key] = evalNode(fields[key], env, atChild(atChild(at, 1), key))
  }
  return out
}

/**
 * `call` 与 `fold` 的 step 共用的同一条路径：格式门槛先于存在性。
 * 参数就地换 env.args、finally 还原——保持同一 env 对象（计数器不快照）。
 */
function evalCall(fun: Json, argumentsIn: Json[], env: Env, callAt: AtNode | null): Json {
  if (!isHash(fun)) throw new KernelError('bad_fun') // 非 Str 或非 64-hex
  const target: Hash = fun
  const def = env.defs[target]
  if (!def) throw new KernelError('missing_ref') // 格式合但不在此世界 defs
  const body = def.body as Json | undefined
  if (!Array.isArray(body) || !TERM_TAGS.has(String(body[0]))) {
    throw new KernelError('bad_term') // body 必须是 14 原语 Term
  }
  const saved = env.args
  env.args = argumentsIn
  try {
    return evalNode(body, env, null) // 同一个 eval：gas 与 depth 都记账
  } catch (e) {
    if (e instanceof KernelError && e.def === undefined) {
      e.def = target // 失败发生在被调 term 内：记被调 def 与调用点
      e.callAt = atPath(callAt)
    }
    throw e
  } finally {
    env.args = saved
  }
}

/**
 * `["g", path]` 的取值：不做隐式转换、不用 null 代缺失、不允许负索引；空 path 返回 ctx。
 */
function walk(v: Json | undefined, path: Path): Json {
  let cur: Json | undefined = v
  if (!Array.isArray(path)) throw new KernelError('missing_path')
  for (const step of path as (string | number)[]) {
    if (typeof step === 'number') {
      if (!Array.isArray(cur)) throw new KernelError('missing_path')
      if (!Number.isInteger(step) || step < 0 || (step as number) >= cur.length) {
        throw new KernelError('missing_path')
      }
      cur = cur[step]
    } else {
      if (t(cur) !== 'Json') throw new KernelError('missing_path')
      const record = cur as { [k: string]: Json }
      if (!Object.hasOwn(record, step)) throw new KernelError('missing_path')
      cur = record[step]
    }
  }
  return cur as Json
}
