// 能力类 `todo` 的两个方法：`describe`（工具自述）+ `invoke`（按工具名派发）。
// 服务不读投影、无写通道：`todo.write` 只产写计划，`todo.read` 只从调用方传入的 bag 数据里解析。
// 会话 id 与待办投影（bag.todo）都由调用方入口 term 读出后随 args 传入。

import { resolveLimits } from './config.ts'
import { isRecord } from './plan.ts'
import { buildWritePlan, resolveItems } from './todo.ts'
import { describeValue } from './tools.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

function requireString(args: Rec, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadArgsError(`${key} required`)
  return value
}

/** 待办投影数据的来源：bag.todo 优先，其次工具参数里的 todo / body。 */
function pickTodoData(toolArgs: Rec, bag: Rec): Json | undefined {
  if (bag['todo'] !== undefined) return bag['todo']
  if (toolArgs['todo'] !== undefined) return toolArgs['todo']
  if (isRecord(toolArgs['body'])) return toolArgs['body']
  return undefined
}

/** `todo.describe`：回 `todo.write` / `todo.read` 两工具 + 四要素 + render 描述符。 */
function describeTool(_args: Rec, _env: CallEnv): Json {
  return describeValue()
}

/** `todo.write`：整表替换，产「条目 def 链 + 本会话键新 body + add_gen」写计划。 */
function writeTool(toolArgs: Rec, bag: Rec): Json {
  const args: Rec = { ...toolArgs }
  if (typeof args['at'] !== 'string' || args['at'].length === 0) {
    const bagAt = bag['at']
    if (typeof bagAt === 'string' && bagAt.length > 0) args['at'] = bagAt
  }
  return buildWritePlan(args, pickTodoData(toolArgs, bag), resolveLimits())
}

/** `todo.read`：从 bag 数据里解析目标会话条目链；服务不自读投影。 */
function readTool(toolArgs: Rec, bag: Rec): Json {
  const conversationId = requireString(toolArgs, 'conversation_id')
  const resolved = resolveItems(pickTodoData(toolArgs, bag), conversationId)
  return { items: resolved.items, total: resolved.total, done: resolved.done }
}

/** `todo.invoke`：按工具名派发；业务失败作 `{ok:false,error}` 值（不炸本轮）。 */
function invokeTool(args: Rec, _env: CallEnv): Json {
  const tool = requireString(args, 'tool')
  const toolArgs = isRecord(args['args']) ? (args['args'] as Rec) : {}
  try {
    let value: Json
    if (tool === 'todo.write') value = writeTool(toolArgs, args)
    else if (tool === 'todo.read') value = readTool(toolArgs, args)
    else throw new ToolError('unknown_tool', tool)
    return { ok: true, result: value }
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

function wrap(fn: (args: Rec, env: CallEnv) => Json): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    const record: Rec = isRecord(args) ? args : {}
    return { value: fn(record, env) }
  }
}

/** 按端口分组的方法表：main.ts 校验 `port` / `method` 后取用。 */
export const PORT_HANDLERS: Record<string, Record<string, Handler>> = {
  todo: {
    describe: wrap(describeTool),
    invoke: wrap(invokeTool),
  },
}
