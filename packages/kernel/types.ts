// 全部共用类型与错误形态 + `KernelError`——放这里是因为依赖 DAG 里
// 它是唯一人人可达的公共上游；错误的**数据形态**，零逻辑。

// ── 值 ────────────────────────────────────────────────
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Hash = string // 64 个十六进制字符（sha256 全长，不截断）
export type Path = (string | number)[]

// ── 世界 ──────────────────────────────────────────────
export interface Def {
  body: Json
  pins?: Record<string, Hash> // 不透明：内核不解释 pin 名
  sig?: Hash
}
// Def 就是 put 的载荷本身：put.args: Def，defs[H(Def)] = Def。
// 键覆盖 body + pins + sig（不是 H(body)），否则改 pin / sig 不动 worldRev。

export interface Gen {
  seq: number // 从 0 起、严格 +1；由内核分配，不由写请求提交
  payload: Hash
  pins: Record<string, Hash>
  sig: Hash
  adopted: { at: number; by: string; write: string } // at/by = 该 Entry；
  // write = 完成采纳的 entry 位置：普通 add_gen = 自身 entryHash；batch 内 = 外层 batch entry 位置
  graft?: { from: string; gen: number } // from = 来源身份 id；gen = 该身份 gens 下标
  // 补丁世代：base = 同身份内基础世代的下标（seq）。存在即「补丁世代」——
  // payload 指向补丁 def（body = {ops:[…]}），组装 = base 世代 body + 补丁按序应用；
  // 不存在即「整份世代」——payload 指向整份 body def。active 对两种世代同义（都指 payload）。
  base?: number
}

export interface Identity {
  id: string
  schema: Hash
  gens: Gen[]
  active: Hash | null // null = retired
  born: { at: number; by: string; parent?: string } // parent = 父身份 id（fork 专用）
}

export interface World {
  defs: Record<Hash, Def>
  ids: Record<string, Identity>
}

// ── 链位置 ────────────────────────────────────────────
export interface Head {
  seq: number // 最后一条 entry 的 seq；空世界 = -1（EMPTY_HEAD）
  hash: Hash | null // 最后一条 entry 的 entryHash；空世界 = null
}

export interface Anchor {
  world: World
  head: Head // 校验起点；与 KernelInput.head 同形
}

// ── 日志 ──────────────────────────────────────────────
export type Op =
  | 'put'
  | 'add_identity'
  | 'add_gen'
  | 'set_active'
  | 'retire'
  | 'fork'
  | 'graft'
  | 'batch'
  | 'note'
  | 'snapshot'

export interface Entry {
  seq: number
  prev: Hash | null
  op: Op
  args: Json // 该 op 的全部参数（batch 里保留占位符，替换是确定性的）
  argsHash: Hash // 本条 args 的内容哈希（按 op 口径）。输出位：entryOf 留占位，由
  // commit 从 applyEntry 返回值回填（全库唯一回填点）；applyEntry / verify / replay 不改入参
  by: string // 谁提的（溯源，内核不据此判定）
  ref?: Hash // 指向世界里的审计记录（上层写的，内核不解释）
  at: number // 时间戳，来自 KernelInput.now；entryHash 覆盖它 ⇒ 可重放
}

// ── 写请求 ────────────────────────────────────────────
export interface WriteRequest {
  id: string // 上层给这条请求的身份（去重 / 审计）；内核不据此判定，不进 entryHash
  op: Op
  target: { expect_pos: Hash | null } // 位置身份（O(1) 校验）；空世界 head.hash = null 故可空
  args: Json // 形状逐 op 见写口的形状表；put.args 就是 Def 本身
  ref?: Hash // 审计记录（世界里的一条 def），进 entryHash
  by: string // 仅供溯源，内核不据此判定
}

// ── 效果 ──────────────────────────────────────────────
export interface EffRequest {
  id: Hash // = H({run, i, n})
  port: string
  method: string
  args: Json
  caps: Record<string, boolean> // 恒等于输入的能力表
}

export interface EffResult {
  ok: boolean
  value?: Json
  error?: string
}

// ── 入口 / 出口 ───────────────────────────────────────
export type Directive =
  | { kind: 'eval'; entry: Hash; args: Json; ctx: Json }
  | { kind: 'extern'; payload: Json }
  | { kind: 'write'; request: WriteRequest }

export interface KernelInput {
  world: World
  head: Head // 日志链头；内核据此续链（seq 与 prev）。空世界 = EMPTY_HEAD
  run: string // run_id，同一逻辑执行内不变
  directives: Directive[]
  results: Record<Hash, EffResult> // 已解析的效果结果（不回灌 = 不存在）
  limits: { gas: number; depth: number }
  caps: Record<string, boolean>
  now: number // 写入 Entry.at；同一逻辑执行的每次续跑必须传同一值
}

export interface CommitResult {
  ok: boolean
  reasons: string[] // 空 = 无异常；'dup' = 幂等命中；ok=false 时携带失败码（单 op，或 batch 段 2 上浮）
  pos: Hash | null // 写入后的链位置；无写入时 = 当前 head.hash
  written: Hash[] // 本次写入的 def 键
}

export interface CommitOutcome {
  verdict: CommitResult
  entry: Entry | null // null = 本次不产生日志（幂等命中 / 被拒）
  hash: Hash | null // = entryHash(entry)；run 直接复用，不重算（null 时无 entry）
}

export interface KernelOutput {
  world: World
  journal: Entry[]
  head: Head // 本次输出对应的链头；refused / waiting / idle 时 === input.head
  pending: EffRequest | null // 串行求值：最多一个待解效果
  observations: Json[]
  status: 'idle' | 'waiting' | 'done' | 'refused'
  usage: { gas: number; depth: number }
}

// ── 错误形态────────────────────────────────
export class KernelError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}
