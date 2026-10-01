// 能力类 `graph-run` 的两个方法：`run`（服务自驱图执行引擎，一次调用跑一段 = 一个 iter）与
// `cancel`（置本回合取消标志，运行中的 run 在派发边界查、命中即停）。
// 图数据 / 解析后的模型 / pins / refs / 续跑依据随 args 传入（服务不读投影、不 import 宿主与内核）；
// 反向调用（节点能力类）走 `port.call`。同输入同输出（LLM 项除外，eff_log 回灌配对下等价）。

import { interpretGraph } from './interpreter.ts'
import { clearCancel, requestCancel } from './cancel.ts'
import { clearTrace, traceFor } from './segment-trace.ts'
import { SEGMENT_ENDED } from './lifecycle.ts'
import { PINS } from './plugin.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, GraphModel, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

export interface GraphRunDeps {
  port: PortCaller
  /** 宿主注入的有效 pins（声明 `pins` ∪ one-needs）；args 内场景覆盖优先于它。 */
  pins?: Rec
  /** 世界 `context-source` 成员表（身份名码元序）：`context.assemble` 前置汇集时逐一反向 `collect`。 */
  contextSources?: string[]
  /** 世界 `loop-rule` 成员表（身份名码元序）：判据按名向成员求值。 */
  ruleProviders?: string[]
  /** 世界 `turn-hook` 成员表（身份名码元序）：回合固定点逐成员取中立增量。 */
  turnHooks?: string[]
}

function asRecord(value: Json | undefined): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null
}

function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `run(args)`：跑一段图执行并回执行结果与 trace 事实（回合尾账本归 turn-ledger）。 */
async function run(args: Json, env: CallEnv, deps: GraphRunDeps): Promise<Json> {
  const input = asRecord(args)
  if (input === null) throw new BadArgsError('args must be an object')
  const bag = asRecord(input['bag'])
  const model = asRecord(input['model'])
  if (bag === null) throw new BadArgsError('args.bag must be an object')
  if (model === null) throw new BadArgsError('args.model must be an object')
  const pins = asRecord(input['pins']) ?? deps.pins ?? PINS
  const resume = asRecord(input['resume'])
  const refs = asRecord(input['refs']) ?? {}
  const turnId = asString(bag['turn_id'])
  const trace = traceFor(turnId)
  const result = await interpretGraph({
    bag,
    env,
    model: model as GraphModel,
    pins,
    port: deps.port,
    trace,
    resume,
    refs,
    contextSources: deps.contextSources ?? [],
    ruleProviders: deps.ruleProviders ?? [],
    turnHooks: deps.turnHooks ?? [],
  })
  const ended = result.ended
  // 段终态（stepping）：保留取消标志与 trace 累积，让下一段仍能看见取消、回合尾一次写出。
  if (ended !== SEGMENT_ENDED) {
    clearTrace(turnId)
    clearCancel(turnId)
  }
  return {
    directives: result.directives,
    events: result.events,
    pending: result.pending,
    summary: result.summary,
    ended,
    lifecycle: result.lifecycle,
    progress: result.progress,
    stop_reason: result.stopReason,
    refused_outcome: result.refusedOutcome,
    trace: trace.facts(),
  }
}

/** `cancel(turn_id)`：置取消标志（幂等）；run 在派发边界查、命中即停。 */
function cancel(args: Json): Json {
  const input = asRecord(args)
  const turnId = input === null ? null : asString(input['turn_id'])
  if (turnId === null) return { ok: false, reason: 'bad_args' }
  requestCancel(turnId)
  return { ok: true, turn_id: turnId, cancelled: true }
}

/** 构造方法表（依赖注入：反向调用通道由 main 提供）。 */
export function createHandlers(deps: GraphRunDeps): Record<string, Handler> {
  return {
    run: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: await run(args, env, deps),
      events: [],
    }),
    cancel: async (args: Json): Promise<HandlerResult> => ({
      value: cancel(args),
      events: [],
    }),
  }
}
