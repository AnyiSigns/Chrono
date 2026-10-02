// 能力类方法表：`orchestration`[list, read, validate, propose] + `tool-provider`[describe, invoke]。
// 输入全部来自 bag（调用方装配）；服务不读投影、无写通道、不发 eff：validate / propose 的机械闸经
// `port.call graph-gate.validate` 消费提供方（本插件不再本地复刻），propose 只返回写计划，宿主落账。
// 工具面（describe / invoke）本地派发到本服务方法，不经反向端口。

import { createHandlers as createAdminHandlers } from './admin-methods.ts'
import { validateViaGraphGate } from './gate-call.ts'
import { isRecord } from './plan.ts'
import { proposeTool } from './propose.ts'
import { listTool, readTool } from './read.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from 'plugin-sdk'

/** 反向调用通道由入口注入（validate / propose 的机械闸消费 `graph-gate`）。 */
export interface OrchestrationDeps {
  port: PortCaller
}

function bagOf(args: Json): Rec {
  return isRecord(args) ? args : {}
}

function wrap(fn: (bag: Rec, env: CallEnv) => Json | Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    return { value: await fn(bagOf(args), env), events: [] }
  }
}

/** 构造 `orchestration` 能力类的方法表：SDK 派发器按方法名取用。 */
export function createHandlers(deps: OrchestrationDeps): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    list: wrap((bag) => listTool(bag)),
    read: wrap((bag) => readTool(bag)),
    validate: wrap((bag) => validateViaGraphGate(deps.port, bag)),
    propose: wrap((bag, env) => proposeTool(bag, env, deps.port)),
  }
  // 工具面与编排平面同服务：describe / invoke 本地派发到上面的方法，不经反向端口。
  const admin = createAdminHandlers({
    dispatch: async (method, bag, env) => {
      const handler = handlers[method]
      const result = await handler(bag, env)
      return result.value
    },
  })
  return { ...handlers, ...admin }
}
