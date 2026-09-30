// 判定求值：`plugin.json.judgments` 声明的能力方法由 term 承载，宿主路由命中时就地求值，不 spawn 服务。
// term 以 `args[0]` 收调用参数、以返回值出判定结果——与命令入口同一求值口径（内核 `evaluation`）。
// 判定可发射 `eff`（取数 / 调自身服务方法）：由宿主注入的 `invoke` 解析并执行，效果结果回灌后续跑
// （与测试器同一「攒 results、重求值」续跑口径）。嵌套调用的审计 / 超时 / 取消由 `invoke` 一侧负责。

import { evaluation } from '../../kernel/machine.ts'
import type { EndpointCallResult } from '../endpoint-table.ts'
import type { Env, Term } from '../../kernel/machine.ts'
import type { EffRequest, EffResult, Hash, Json, World } from '../../kernel/index.ts'

/** 一条判定目标：被调身份（`owner`）在能力类 `cap` 的方法 `method`，由入口 term `entry` 承载。 */
export interface JudgmentTarget {
  owner: string
  gen: Hash
  cap: string
  method: string
  /** 判定入口 term def 哈希（`terms/` 成员，`$ref` 已替换）。 */
  entry: Hash
}

/**
 * 判定求值器：给定路由解析世界与判定目标，求值该 term 的 `args[0]` 输入。
 * 返回值恒是数据（成功值或错误码），不抛错——与端点调用同形，供 `run-loop` 统一处理与审计。
 */
export type JudgmentCall = (
  world: World,
  target: JudgmentTarget,
  args: Json,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<EndpointCallResult>

/** 判定求值依赖：判定发射的 `eff`（取数 / 调服务方法）的解析与执行由宿主接线。 */
export interface JudgmentDeps {
  /**
   * 执行判定内发射的效果：`world` 是判定的解析世界、`emitter` 是判定属主身份，
   * 返回内核 `EffResult`（失败作数据，不抛）。缺省时判定发射 `eff` 即 fail-closed（纯项）。
   */
  invoke?: (
    world: World,
    emitter: string,
    eff: EffRequest,
    signal?: AbortSignal,
  ) => Promise<EffResult>
}

/** 单条判定的效果发射上限：防实现缺陷死循环，正常远低于此。 */
export const MAX_JUDGMENT_EFFECTS = 10_000

/** 纯项判定的求值环境：无 `ctx`（判定不读投影，数据由调用方随 args 传入）、无能力扩权。 */
function judgmentEnv(
  world: World,
  run: string,
  args: Json,
  results: Record<Hash, EffResult>,
  limits: { gas: number; depth: number },
): Env {
  return {
    ctx: null,
    args: [args],
    defs: world.defs,
    results,
    caps: {},
    limits,
    run,
    i: 0,
    n: 0,
    gas: limits.gas,
    depth: 0,
    peakDepth: 0,
  }
}

/** 构造判定求值器；`limits` 与出/入口预算同口径（调用方传宿主默认限制）。 */
export function createJudgmentRunner(
  limits: { gas: number; depth: number },
  deps: JudgmentDeps = {},
): JudgmentCall {
  return async (world, target, args, _timeoutMs, signal) => {
    const def = world.defs[target.entry]
    if (def === undefined) {
      return { ok: false, code: 'not_loaded', message: `judgment def missing: ${target.entry}` }
    }
    // 判定内效果身份由入口 term 的 def 键唯一确定：同一次判定的续跑稳定、不同判定互不碰撞。
    const run = `judgment:${target.owner}:${target.entry}`
    const results: Record<Hash, EffResult> = {}
    for (let emitted = 0; emitted < MAX_JUDGMENT_EFFECTS; emitted++) {
      const env = judgmentEnv(world, run, args, results, limits)
      const out = evaluation(def.body as Term, env)
      if ('suspend' in out) {
        if (deps.invoke === undefined) {
          return { ok: false, code: 'bad_term', message: 'judgment must be pure (emitted eff)' }
        }
        results[out.suspend.id] = await deps.invoke(world, target.owner, out.suspend, signal)
        continue
      }
      if (!out.ok) {
        return { ok: false, code: out.error, message: `judgment failed: ${out.error}` }
      }
      return { ok: true, value: out.value }
    }
    return { ok: false, code: 'gas', message: 'too many judgment effects' }
  }
}
