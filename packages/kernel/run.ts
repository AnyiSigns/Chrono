// 编排：一次输入 → 一条输出。整次调用原子——cloneWorld 恰一次，refused / waiting /
// idle 一律交回 input.world / input.head（克隆体只服务 done 路径）；错误收口（catch 转
// refused）只做这一次、只在最外层。

import { commit } from './commit.ts'
import { cloneWorld } from './journal.ts'
import { evaluation, TERM_TAGS } from './machine.ts'
import type { Env, EvalResult, Term } from './machine.ts'
import { KernelError } from './types.ts'
import type {
  CommitOutcome,
  Directive,
  Entry,
  Hash,
  Head,
  Json,
  KernelInput,
  KernelOutput,
  World,
} from './types.ts'

type EvalDirective = Extract<Directive, { kind: 'eval' }>

/** run 的观测出口：write 观测的 pos 由 run 传入，观测函数自己不读状态。 */
type ObsOutcome =
  | { kind: 'write'; o: CommitOutcome; pos: Hash | null }
  | { kind: 'eval'; r: EvalResult }
  | { kind: 'extern' }
  | { kind: 'refused'; reasons: string[] }

/** 一次调用的可变状态：head 推进、gas 跨 directive 共享、观测累积。 */
interface RunState {
  input: KernelInput
  world: World
  head: Head
  journal: Entry[]
  obs: Json[]
  gasLeft: number
  peakDepth: number
}

/**
 * `Env` 的唯一构造点：`defs` 取**当前世界**（不是 input.world）——同一次调用里
 * 前面的写，后面的 eval 要能看见；gas 用剩余量（跨 directive 共享），n/depth 每 directive 重置。
 */
function mkEnv(c: {
  input: KernelInput
  world: World
  i: number
  d: EvalDirective
  gasLeft: number
}): Env {
  const { input, world, i, d, gasLeft } = c // 5 项打包为单对象（编码纪律：参数 ≤4）
  return {
    ctx: d.ctx,
    args: [d.args], // `Var 0` 拿它
    defs: world.defs,
    results: input.results,
    caps: input.caps,
    limits: input.limits,
    run: input.run,
    i,
    n: 0,
    gas: gasLeft,
    depth: 0,
    peakDepth: 0,
  }
}

function usageOf(st: RunState): { gas: number; depth: number } {
  return { gas: st.input.limits.gas - st.gasLeft, depth: st.peakDepth }
}

/** run 级拒绝：世界/head 回到入口，观测保留并在末尾补拒因——拒因经 observations 承载。 */
function refuse(st: RunState, reasons: string[]): KernelOutput {
  return {
    world: st.input.world,
    journal: [],
    head: st.input.head,
    pending: null,
    observations: [...st.obs, observationsOf(null, { kind: 'refused', reasons }) as Json],
    status: 'refused',
    usage: usageOf(st),
  }
}

function handleWrite(st: RunState, d: Extract<Directive, { kind: 'write' }>): KernelOutput | null {
  const o = commit(st.head, st.world, d.request, st.input.now) // 唯一写口
  if (!o.verdict.ok) return refuse(st, o.verdict.reasons)
  let pos: Hash | null = st.head.hash // 幂等：位置不变
  if (o.entry !== null) {
    st.journal.push(o.entry)
    st.head = { seq: o.entry.seq, hash: o.hash as Hash } // commit 已算好，不重算
    pos = o.hash as Hash
  }
  const view = observationsOf(d, { kind: 'write', o, pos })
  if (view !== null) st.obs.push(view)
  return null
}

function handleEval(st: RunState, i: number, d: EvalDirective): KernelOutput | null {
  const def = st.world.defs[d.entry]
  if (!def) return refuse(st, ['missing_ref'])
  if (!isBodyTerm(def.body)) return refuse(st, ['bad_term'])
  const env = mkEnv({ input: st.input, world: st.world, i, d, gasLeft: st.gasLeft })
  const r = evaluation(def.body as Term, env)
  st.gasLeft = env.gas
  if (env.peakDepth > st.peakDepth) st.peakDepth = env.peakDepth
  if ('suspend' in r) {
    return {
      world: st.input.world,
      journal: [],
      head: st.input.head,
      pending: r.suspend,
      observations: [...st.obs],
      status: 'waiting',
      usage: usageOf(st),
    }
  }
  if (!r.ok) return refuse(st, [r.error])
  const view = observationsOf(d, { kind: 'eval', r })
  if (view !== null) st.obs.push(view)
  return null
}

function isBodyTerm(body: Json): boolean {
  return Array.isArray(body) && typeof body[0] === 'string' && TERM_TAGS.includes(body[0])
}

/**
 * 观测流：派生视图，不落盘、不入世界；一个 directive 至多一条。`run` 只用这一个函数
 * 产出观测，不自己拼形状。eval 挂起 → null（挂起那条不产观测）。
 * @param d 当前 directive；run 级拒绝时为 null（此时 outcome.kind 必须是 'refused'）
 */
export function observationsOf(d: Directive | null, outcome: ObsOutcome): Json | null {
  switch (outcome.kind) {
    case 'write': {
      const view: { [k: string]: Json | undefined } = {
        kind: 'write',
        op: d && d.kind === 'write' ? d.request.op : null,
        pos: outcome.pos,
      }
      if (outcome.o.entry === null) view.dup = true
      return view as unknown as Json // undefined 键由 canonicalJson 口径剔除
    }
    case 'eval': {
      const r = outcome.r
      if ('suspend' in r) return null
      const view: { [k: string]: Json | undefined } = {
        kind: 'eval',
        entry: d && d.kind === 'eval' ? d.entry : null,
        ok: r.ok,
      }
      if (r.ok) view.value = r.value
      else view.error = r.error
      return view as unknown as Json
    }
    case 'extern':
      return { kind: 'extern', payload: d && d.kind === 'extern' ? d.payload : null }
    case 'refused':
      return { kind: 'refused', reasons: outcome.reasons }
  }
}

/**
 * 推进世界：处理 directives 至挂起点或终止，一次调用不内嵌循环。
 * 四态构造口径写死：refused / waiting / idle 返回 `input.world` 与 `input.head`、
 * journal 为空；refused 末尾补 `{kind:'refused', reasons}`；usage 四态都带（idle 全 0）。
 * @param input 完整内核输入（含 run_id、now、能力表与已回灌的效果结果）
 * @returns done 时 world / journal / head 可直接落盘；waiting 时以同一 run_id、同一份完整
 *   directives、同一 now 回灌 results 后重调（续跑契约）
 */
export function run(input: KernelInput): KernelOutput {
  const st: RunState = {
    input,
    world: cloneWorld(input.world), // 整体成本 = 一次复制 + 每条 entry O(1)
    head: input.head,
    journal: [],
    obs: [],
    gasLeft: input.limits.gas,
    peakDepth: 0,
  }
  if (input.directives.length === 0) {
    return {
      world: input.world,
      journal: [],
      head: input.head,
      pending: null,
      observations: [],
      status: 'idle',
      usage: { gas: 0, depth: 0 },
    }
  }
  try {
    for (let i = 0; i < input.directives.length; i++) {
      const d = input.directives[i]
      let early: KernelOutput | null = null
      if (d.kind === 'write') early = handleWrite(st, d)
      else if (d.kind === 'eval') early = handleEval(st, i, d)
      else st.obs.push(observationsOf(d, { kind: 'extern' }) as Json)
      if (early !== null) return early
    }
  } catch (err) {
    if (err instanceof KernelError) return refuse(st, [err.code]) // 仅此一处 catch 转 refused
    throw err
  }
  return {
    world: st.world,
    journal: st.journal,
    head: st.head,
    pending: null,
    observations: st.obs,
    status: 'done',
    usage: usageOf(st),
  }
}
