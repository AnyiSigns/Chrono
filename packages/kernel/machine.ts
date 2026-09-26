// 归约机公共面：14 原语类型、运行环境、三态结果与分派名单；
// 逐原语求值与分派表在 machine.eval.ts（点分段，经本文件转口）。

import type { Def, EffRequest, EffResult, Hash, Json, Path } from './types.ts'

export { cmp, evaluation, TERM_TAGS } from './machine.eval.ts'

export type TermTag =
  | 'c'
  | 'g'
  | 'get'
  | 'getOr'
  | 'v'
  | 'cmp'
  | 'pred'
  | 'if'
  | 'fold'
  | 'eff'
  | 'call'
  | 'arith'
  | 'list'
  | 'obj'
export type Term = [TermTag, ...Json[]]
// 14 原语的具化形状（仅供阅读与分派；机器按 term[0] 分派，形态不合按 bad_term/bad_var 报出）：
//  Const ["c", Json] · Var ["v", 非负整数] · Cmp ["cmp", Term, Term] → -1|0|1
//  Pred ["pred", op, Term, Term] → Bool（op ∈ lt/le/gt/ge/eq/ne，复用 cmp 全序；if 的布尔来源）
//  If ["if", Term, Term, Term] · Fold ["fold", coll, init, step]（函数侧求值为 def hash，函数即值）
//  Eff ["eff", port, method, Term] · Call ["call", 函数侧 Term, [Term, ...]]
//  Arith ["arith", op, Term, Term]（op ∈ add/sub/mul，仅有限数，非有限结果报 bad_arith）
//  List ["list", [Term, ...]]（新列表） · Obj ["obj", { k: Term, ... }]（新对象，键序规范）
//  Get 在 Json 值域内的形式是 ['g', Json]，path 数组在分派处具化为 Path。
//  GetAt ["get", Term, Path]：对任意值沿静态 path 投影（与 g 对称——g 的根是 ctx）。
//  GetOr ["getOr", Term, Path, Term]：同 get，但路径缺失时返回默认项（不抛 missing_path）。

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
  | { ok: true; value: Json }
  | { ok: false; error: string; at?: Path; def?: Hash; callAt?: Path }
  | { suspend: EffRequest }
