// 能力类 `ui-approval` 的方法表：ping 占位 + 三条命令的服务侧装配。
// 服务不读投影、不发 eff：入口 term 把 `ctx.ids` 切片随 args 传入，服务从中取 `#1` 槽与 `#32` 队列，
// 经宿主反向调用（`port.call`，docs/protocol.md §2.4）调 `approval` 端口，并在服务内拼续跑计划。
// 只返回值 / 计划（`$directives`），不落账、不自取时钟。

import {
  asString,
  clearReject,
  directivesOf,
  externOnly,
  failure,
  inputBodyOf,
  itemById,
  itemsFromChain,
  MAIN_THREAD,
  normalizeVerdict,
  pendingItems,
  queueOf,
  refsOf,
  resumeDirectives,
  shadowRefsOf,
  slotOf,
  withExternPayload,
} from './plan.ts'
import type { PortCaller } from './port-link.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'

export interface HandlerDeps {
  identity: string
  approval: PortCaller
}

/** 裁决模式：单条（读槽 `id`）或整批（全部 `pending`）。 */
export type DecideMode = 'single' | 'all'

/** `approval.list` 入参：`#32` 队列 body + item 引用闭包（服务不读投影）。 */
export function assembleListArgs(ids: Json): Rec {
  return { queue: queueOf(ids), refs: refsOf(ids) }
}

/**
 * `approval.decide` / `decide_all` 的裁决入参：队列 + 引用 + 本线程槽 + 线程键。
 * `slots` 传整份输入 body（#32 侧 per-thread 读槽 / 清槽用），`thread_id` 定线程键。
 */
export function assembleDecideArgs(ids: Json, threadKey: string): Rec {
  const inputBody = inputBodyOf(ids)
  const args: Rec = { queue: queueOf(ids), refs: refsOf(ids), thread_id: threadKey }
  if (inputBody !== null) args['slots'] = inputBody
  return args
}

/** 本线程 `approval.decide` 槽体；非该 kind 回 null（坏槽 kind 结构化拒）。 */
export function decideSlotOf(ids: Json, threadKey: string): Rec | null {
  const slot = slotOf(inputBodyOf(ids), threadKey)
  return slot !== null && slot['kind'] === 'approval.decide' ? slot : null
}

/**
 * 顶层裁决计划：`[eval(command:'chat.resume'), …#32 计划]`。
 * 续跑条目按被裁决项逐条产（每项各自游标 / 线程 + 调用方投影切片 `ids`）；
 * `#32` 计划原样接在其后（写裁决 + 清槽 + extern）。
 */
export function buildDecisionPlan(targets: Rec[], verdict: string, approvalPlan: Json[], ids: Json): Json {
  return { $directives: [...resumeDirectives(targets, verdict, ids), ...approvalPlan] }
}

/** 单条裁决的目标项：槽里的 `id` 命中的 item；无 `id` / 找不到回空。 */
function singleTarget(items: Rec[], slot: Rec): Rec[] {
  const id = asString(slot['id'])
  if (id === null) return []
  const target = itemById(items, id)
  return target === null ? [] : [target]
}

/** 裁决主流程（单条 / 整批共用）：校验槽 → 反向调 #32 → 拼续跑计划。 */
async function decideCore(deps: HandlerDeps, args: Json, env: CallEnv, mode: DecideMode): Promise<Json> {
  const ids = args
  const threadKey = asString(env.thread) ?? MAIN_THREAD
  const inputBody = inputBodyOf(ids)
  const slot = decideSlotOf(ids, threadKey)
  const verdict = slot === null ? null : normalizeVerdict(slot['verdict'])
  if (verdict === null) return clearReject(inputBody, threadKey, 'bad_slot')

  const queue = queueOf(ids)
  const refs = refsOf(ids)
  const items = itemsFromChain(queue, refs)
  const targets = mode === 'all' ? pendingItems(items) : singleTarget(items, slot as Rec)
  const method = mode === 'all' ? 'decide_all' : 'decide'
  const outcome = await deps.approval.call('approval', method, assembleDecideArgs(ids, threadKey))
  if (!outcome.ok) return clearReject(inputBody, threadKey, outcome.code)
  const approvalPlan = directivesOf(outcome.value)
  if (approvalPlan === null) return clearReject(inputBody, threadKey, 'bad_plan')
  return buildDecisionPlan(targets, verdict, approvalPlan, ids)
}

/** 构造方法表；`deps.approval` 是反向调用通道（单测注入假端口）。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: (): Json => ({ pong: true, identity: deps.identity }),

    /**
     * 待审批队列（含 pending / expired）：服务装配 `#32` 队列切片后反向调 `approval.list`，结果即命令结果。
     * 只读：不构造任何 write；另附各 item `shadow` def body（有则附），供 UI 解析影子指标。
     */
    list: async (args): Promise<Json> => {
      const outcome = await deps.approval.call('approval', 'list', assembleListArgs(args))
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      const refs = refsOf(args)
      const shadows = shadowRefsOf(itemsFromChain(queueOf(args), refs), refs)
      return withExternPayload(outcome.value, { refs: shadows })
    },

    /** 单条裁决：读本线程 `approval.decide` 槽 → 反向调 #32 → 拼 `chat.resume` 续跑计划。 */
    decide: (args, env): Promise<Json> => decideCore(deps, args, env, 'single'),

    /** 整批裁决：对全部 `pending` 项给同一 verdict。 */
    decide_all: (args, env): Promise<Json> => decideCore(deps, args, env, 'all'),
  }
}
