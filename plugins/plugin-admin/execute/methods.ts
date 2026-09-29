// 能力类 `plugin-admin` 的两个方法：describe（工具自述）与 invoke（按工具名派发）。
// 工具面是薄适配：重逻辑与凭据住管理平面 `plugin`，invoke 经反向调用 `port.call plugin.<method>` 委派。
// 业务失败作 `{ok:false,error:{code,message}}` 值（不炸本轮）；未知工具 `unknown_tool`。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { PluginPlaneError } from './port-link.ts'
import { describeValue } from './tools.ts'
import { ToolError } from './types.ts'
import type { PluginPlane } from './port-link.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

function requireString(args: Rec, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadArgsError(`${key} required`)
  return value
}

/** 工具名 → 管理平面方法（invoke 的派发表）。 */
const TOOL_METHODS: Record<string, string> = {
  'plugin.list': 'list',
  'plugin.read': 'read',
  'plugin.validate': 'validate',
  'plugin.write': 'write',
}

/** `plugin-admin.describe`：回四工具 + 四要素 + render 描述符。 */
async function describeTool(): Promise<Json> {
  return describeValue()
}

/** `plugin-admin.invoke`：按工具名派发到管理平面；业务失败作值（不炸本轮）。 */
async function invokeTool(plane: PluginPlane, args: Rec): Promise<Json> {
  const tool = requireString(args, 'tool')
  const toolArgs = isRecord(args['args']) ? (args['args'] as Rec) : {}
  try {
    const method = TOOL_METHODS[tool]
    if (method === undefined) throw new ToolError('unknown_tool', tool)
    const value = await plane.call(method, toolArgs)
    return { ok: true, result: value }
  } catch (err) {
    if (err instanceof PluginPlaneError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof ToolError) {
      return { ok: false, error: { code: err.code, message: err.message } }
    }
    if (err instanceof BadArgsError) {
      return { ok: false, error: { code: 'bad_args', message: err.message } }
    }
    throw err
  }
}

function wrap(fn: (args: Rec, env: CallEnv) => Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    const record: Rec = isRecord(args) ? args : {}
    return { value: await fn(record, env), events: [] }
  }
}

/** 构造能力类 `plugin-admin` 的方法表：SDK 派发器按方法名取用。 */
export function createHandlers(plane: PluginPlane): Record<string, Handler> {
  return {
    describe: wrap(() => describeTool()),
    invoke: wrap((args) => invokeTool(plane, args)),
  }
}
