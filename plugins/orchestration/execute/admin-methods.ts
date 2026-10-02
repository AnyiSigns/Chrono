// 编排平面的工具面方法表：`tool-provider`[describe, invoke]。describe 回四工具自述；invoke 按工具名
// 本地派发到编排平面方法（同一服务，不经反向端口），业务失败作 `{ok:false,error:{code,message}}` 值
// （不炸本轮）。

import { BadArgsError, ServiceError, isRecord } from 'plugin-sdk'
import { describeValue } from './admin-tools.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

/** 本地编排方法派发：按方法名执行编排平面方法并回其值（失败抛结构化错误）。 */
export type OrchestrationDispatch = (method: string, bag: Rec, env: CallEnv) => Promise<Json>

/** 工具面依赖：本地编排平面的方法派发由 `methods.ts` 注入。 */
export interface AdminDeps {
  dispatch: OrchestrationDispatch
}

/** 工具名 → 编排平面方法（工具名命名空间 `orchestration.` 后的方法名）。 */
const TOOL_METHODS: Readonly<Record<string, string>> = {
  'orchestration.list': 'list',
  'orchestration.read': 'read',
  'orchestration.validate': 'validate',
  'orchestration.propose': 'propose',
}

function bagOf(args: Json): Rec {
  return isRecord(args) ? args : {}
}

function wrap(fn: (bag: Rec, env: CallEnv) => Json | Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    return { value: await fn(bagOf(args), env), events: [] }
  }
}

/** `tool-provider.describe`：回四工具 + 四要素 + render 描述符。 */
function describeTool(): Json {
  return describeValue()
}

/** `tool-provider.invoke`：按工具名本地派发；未知工具与业务失败都作 `{ok:false,error}` 值（不炸本轮）。 */
async function invokeTool(bag: Rec, env: CallEnv, deps: AdminDeps): Promise<Json> {
  const tool = bag['tool']
  if (typeof tool !== 'string' || tool.length === 0) throw new BadArgsError('tool required')
  const method = TOOL_METHODS[tool]
  if (method === undefined) return { ok: false, error: { code: 'unknown_tool', message: tool } }
  const toolArgs = isRecord(bag['args']) ? (bag['args'] as Rec) : {}
  try {
    return { ok: true, result: await deps.dispatch(method, toolArgs, env) }
  } catch (err) {
    if (err instanceof ServiceError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof BadArgsError) {
      return { ok: false, error: { code: 'bad_args', message: err.message } }
    }
    throw err
  }
}

/** 构造 `tool-provider` 能力类的方法表：SDK 派发器按方法名取用。 */
export function createHandlers(deps: AdminDeps): Record<string, Handler> {
  return {
    describe: wrap(() => describeTool()),
    invoke: wrap((bag, env) => invokeTool(bag, env, deps)),
  }
}
