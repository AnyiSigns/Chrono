// 归约机：8 原语、严格深度优先左到右、无 lambda / 无递归 / 无 while。
// 内部求值返回 Json 并抛 KernelError（层层干净），公共 `eval` 收三态；
// `env` 是共享可变对象（gas / depth / n 靠同一实例累加，evalCall 禁止展开复制）。

import { H } from './hash.ts'
import { TYPE_ORDER, t } from './value.ts'
import { KernelError } from './types.ts'
import type { Def, EffRequest, EffResult, Hash, Json, Path } from './types.ts'

// ── 求值机的共用类型（Term 8 原语形状 / 运行环境 / 三态结果，归属本模块）──
export type TermTag = 'c' | 'g' | 'v' | 'cmp' | 'if' | 'fold' | 'eff' | 'call'
export type Term = [TermTag, ...Json[]]
// 8 原语的具化形状（仅供阅读与分派；机器按 term[0] 分派，形态不合按 bad_term/bad_var 报出）：
//  Const ["c", Json] · Var ["v", 非负整数] · Cmp ["cmp", Term, Term] · If ["if", Term, Term, Term]
//  Fold ["fold", coll, init, step]（函数侧求值为 def hash，函数即值）
//  Eff ["eff", port, method, Term] · Call ["call", 函数侧 Term, [Term, ...]]
// Get 在 Json 值域内的形式是 ['g', Json]，path 数组在分派处具化为 Path。

export interface Env {
  ctx: Json
  args: Json[]
  defs: Record<Hash, Def> // call 的目标；必须是当前世界的 defs（同一次调用里前面的写要可见）
  results: Record<Hash, EffResult> // 已解析的效果结果（eff 回灌）
  caps: Record<string, boolean> // 恒等于输入的能力表（内核不自造能力）
  limits: { gas: number; depth: number }
  run: string
  i: number // 当前 directive 下标（eff 身份的一半）
  n: number // 本 directive 内已发射的效果序号（可变）
  gas: number // 剩余 gas（可变）
  depth: number // 当前嵌套深度（可变）
  peakDepth: number // 本 directive 内 depth 的历史峰值（可变；usage.depth 取它）
}

export type EvalResult =
  { ok: true; value: Json } | { ok: false; error: string } | { suspend: EffRequest }

/** 8 原语头；机器分派与 run 的事前 bad_term 检查共用此名单（冻结只读）。 */
export const TERM_TAGS: readonly string[] = Object.freeze([
  'c',
  'g',
  'v',
  'cmp',
  'if',
  'fold',
  'eff',
  'call',
])

function isHashStr(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** 挂起信号：不是错误，是与三态并列的第三条返回路径（——不捕获续体，结果回灌后从入口重跑）。 */
class Suspend {
  readonly request: EffRequest
  constructor(request: EffRequest) {
    this.request = request
  }
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
      // 与 canonicalJson / deepEq 同口径：先滤 undefined 键，否则"哈希相等而 cmp ≠ 0"
      const ra = a as { [k: string]: Json | undefined }
      const rb = b as { [k: string]: Json | undefined }
      const keysA = Object.keys(ra).filter((k) => ra[k] !== undefined)
      const keysB = Object.keys(rb).filter((k) => rb[k] !== undefined)
      keysA.sort()
      keysB.sort()
      const shared = Math.min(keysA.length, keysB.length)
      for (let i = 0; i < shared; i++) {
        if (keysA[i] !== keysB[i]) return keysA[i] < keysB[i] ? -1 : 1
        const c = cmp(ra[keysA[i]] as Json, rb[keysB[i]] as Json)
        if (c !== 0) return c
      }
      return keysA.length < keysB.length ? -1 : keysA.length > keysB.length ? 1 : 0
    }
  }
}

/**
 * 求值一个 Term：返回三态而非抛错——`ok:false` 携带机器错误码、
 * `suspend` 携带待解 EffRequest（每 directive 至多一个 pending）。
 * （导出名保持 `eval`——见 index.ts；JS 的 `eval` 在严格模式下不宜作模块内函数名。）
 * @param term 8 原语之一（形态不合报 'bad_term'）
 * @param env 共享可变环境（gas / depth / n 记账其上）
 * @returns EvalResult 三态
 */
export function evaluation(term: Term, env: Env): EvalResult {
  try {
    return { ok: true, value: evalNode(term as unknown as Json | undefined, env) }
  } catch (e) {
    if (e instanceof Suspend) return { suspend: e.request }
    if (e instanceof KernelError) return { ok: false, error: e.code }
    throw e
  }
}

function evalNode(term: Json | undefined, env: Env): Json {
  env.gas -= 1 // 每个 Term 节点扣 1；剩余量即 env.gas
  if (env.gas < 0) throw new KernelError('gas')
  env.depth += 1
  if (env.depth > env.peakDepth) env.peakDepth = env.depth
  if (env.depth > env.limits.depth) throw new KernelError('depth')
  try {
    if (!Array.isArray(term)) throw new KernelError('bad_term')
    const node = term as Json[]
    const tag = node[0]
    switch (tag as TermTag) {
      case 'c':
        return evalConst(node)
      case 'g':
        return evalGet(node, env)
      case 'v':
        return evalVar(node, env)
      case 'cmp':
        return evalCmp(node, env)
      case 'if':
        return evalIf(node, env)
      case 'fold':
        return evalFold(node, env)
      case 'eff':
        return evalEff(node, env)
      case 'call':
        return evalCallTerm(node, env)
      default:
        throw new KernelError('bad_term') // 头不是 8 原语之一——字面 "let" 等语法扩展头即在此被拒
    }
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

function evalVar(node: Json[], env: Env): Json {
  if (node.length !== 2) throw new KernelError('bad_term')
  const k = node[1]
  // 不用 ?? 判缺失：args[k] 本身可以是 null
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k >= env.args.length) {
    throw new KernelError('bad_var')
  }
  return env.args[k] as Json
}

function evalCmp(node: Json[], env: Env): Json {
  if (node.length !== 3) throw new KernelError('bad_term')
  const left = evalNode(node[1], env) // 严格左→右
  return cmp(left, evalNode(node[2], env))
}

function evalIf(node: Json[], env: Env): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const cond = evalNode(node[1], env)
  if (t(cond) !== 'Bool') throw new KernelError('bad_cond')
  return evalNode(cond ? node[2] : node[3], env) // 不预求另一支
}

function evalFold(node: Json[], env: Env): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const coll = evalNode(node[1], env)
  if (t(coll) !== 'List') throw new KernelError('not_a_list')
  const fun = evalNode(node[3], env) // 函数侧每次 fold 求值恰一次（其内 eff 至多一次发射）
  let acc = evalNode(node[2], env)
  const items = coll as Json[]
  for (let i = 0; i < items.length; i++) {
    env.gas -= 1 // 每轮迭代再扣 1
    if (env.gas < 0) throw new KernelError('gas')
    acc = evalCall(fun, [acc, items[i], i], env) // 目标循环内恒定；挂起则冒泡
  }
  return acc
}

function evalEff(node: Json[], env: Env): Json {
  if (node.length !== 4) throw new KernelError('bad_term')
  const argValue = evalNode(node[3], env)
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

function evalCallTerm(node: Json[], env: Env): Json {
  if (node.length !== 3) throw new KernelError('bad_term')
  const fun = evalNode(node[1], env) // 函数侧严格先于实参表
  const argTerms = node[2]
  if (!Array.isArray(argTerms)) throw new KernelError('bad_term')
  const values: Json[] = []
  for (const argTerm of argTerms) values.push(evalNode(argTerm, env)) // 逐个、左到右
  return evalCall(fun, values, env)
}

/**
 * `call` 与 `fold` 的 step 共用的同一条路径：格式门槛先于存在性。
 * 参数就地换 env.args、finally 还原——保持同一 env 对象（计数器不快照）。
 */
function evalCall(fun: Json, argumentsIn: Json[], env: Env): Json {
  if (!isHashStr(fun)) throw new KernelError('bad_fun') // 非 Str 或非 64-hex
  const target: Hash = fun
  const def = env.defs[target]
  if (!def) throw new KernelError('missing_ref') // 格式合但不在此世界 defs
  const body = def.body as Json | undefined
  if (!Array.isArray(body) || !TERM_TAGS.includes(String(body[0]))) {
    throw new KernelError('bad_term') // body 必须是 8 原语 Term
  }
  const saved = env.args
  env.args = argumentsIn
  try {
    return evalNode(body, env) // 同一个 eval：gas 与 depth 都记账
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
