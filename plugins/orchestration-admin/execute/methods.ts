// 能力类方法表：`orchestration-admin`[describe, invoke]。describe 回四工具自述；invoke 按工具名
// 反向 `port.call orchestration.<method>` 派发到编排平面（本插件不实现编排逻辑），业务失败作
// `{ok:false,error:{code,message}}` 值（不炸本轮）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { describeValue } from './tools.ts'
import { ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from 'plugin-sdk'

/** 反向调用通道由入口注入（invoke 的派发消费 `orchestration` 提供方）。 */
export interface AdminDeps {
  port: PortCaller
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

/** `orchestration-admin.describe`：回四工具 + 四要素 + render 描述符。 */
function describeTool(): Json {
  return describeValue()
}

/** 工具名 → 反向调用 `orchestration.<method>`；未知工具 `unknown_tool`，远端失败带原码。 */
async function dispatch(tool: string, bag: Rec, port: PortCaller): Promise<Json> {
  const method = TOOL_METHODS[tool]
  if (method === undefined) throw new ToolError('unknown_tool', tool)
  const outcome = await port.call('orchestration', method, bag)
  if (!outcome.ok) throw new ToolError(outcome.code, outcome.message)
  return outcome.value
}

/** `orchestration-admin.invoke`：按工具名派发；业务失败作 `{ok:false,error}` 值（不炸本轮）。 */
async function invokeTool(bag: Rec, port: PortCaller): Promise<Json> {
  const tool = bag['tool']
  if (typeof tool !== 'string' || tool.length === 0) throw new BadArgsError('tool required')
  const toolArgs = isRecord(bag['args']) ? (bag['args'] as Rec) : {}
  try {
    return { ok: true, result: await dispatch(tool, toolArgs, port) }
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof BadArgsError) {
      return { ok: false, error: { code: 'bad_args', message: err.message } }
    }
    throw err
  }
}

/** 构造 `orchestration-admin` 能力类的方法表：SDK 派发器按方法名取用。 */
export function createHandlers(deps: AdminDeps): Record<string, Handler> {
  return {
    describe: wrap(() => describeTool()),
    invoke: wrap((bag) => invokeTool(bag, deps.port)),
  }
}
