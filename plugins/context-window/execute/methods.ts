// 能力方法 `context.build`：唯一方法。输入 bag（调用方入口 term 装配），返回
// `{messages, params, manifest}`；`budget_impossible` / `budget_exceeded` 作结构化错误值返回（非崩溃）。

import { buildAssembly } from './pipeline.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Policy } from './types.ts'

export interface HandlerResult {
  value: Json
  events: { topic: string; payload: Json }[]
}

/**
 * `context.build(bag)`：执行一次上下文组装。
 * @param args bag（须为对象）
 * @param env 帧 env（run / thread / now）
 * @param policy 当前生效策略（启动 / reload 时读取）
 */
export function handleBuild(args: Record<string, unknown>, env: CallEnv, policy: Policy): HandlerResult {
  const result = buildAssembly(args, env, policy)
  return { value: result.value, events: result.events }
}

/** 供 main 校验：bag 必须是对象。 */
export function assertBag(args: unknown): asserts args is Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new BadArgsError('bag must be an object')
  }
}
