// 能力类 `todo` 的两个方法：`describe`（工具自述）+ `invoke`（按工具名派发）。
// 清单本体已出世界：写即时落委托存储（storage-kv，按 env.emitter 分命名空间），读从自有存储取；
// 不再产世界写计划、不再从 bag 收投影切片。会话 id 仍由调用方经 bag / args 给出（模型看不到）。

import { resolveLimits } from './config.ts'
import { asString, isRecord } from './plan.ts'
import type { TodoStore } from './store.ts'
import { normalizeItems, summarize } from './todo.ts'
import { describeValue } from './tools.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

/** 服务依赖：委托存储（单测注入假后端）。 */
export interface TodoDeps {
  store: TodoStore
}

function requireString(args: Rec, key: string): string {
  if (typeof args[key] !== 'string' || (args[key] as string).length === 0) {
    throw new BadArgsError(`${key} required`)
  }
  return args[key] as string
}

/**
 * 会话 id：工具参数 `conversation_id` 只作内部显式覆盖（不进 argsSchema，模型看不到、不会传），
 * 正常路径由系统从 bag 取——`session_id` 直给，或 `session` 为字符串 / 投影切片
 * `{body:{current}}`（入口 term 读 `ids.session.body.current` 后传入）。模型无法指定其它会话。
 */
function sessionIdOf(toolArgs: Rec, bag: Rec): string | null {
  const direct = toolArgs['conversation_id']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const sessionId = bag['session_id']
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  const session = bag['session']
  if (typeof session === 'string' && session.length > 0) return session
  if (isRecord(session)) {
    const body = isRecord(session['body']) ? (session['body'] as Rec) : session
    const current = body['current']
    if (typeof current === 'string' && current.length > 0) return current
    const id = body['id']
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/** `todo.describe`：回 `todo.write` / `todo.read` 两工具 + 四要素 + render 描述符。 */
function describeTool(_args: Rec, _env: CallEnv): Json {
  return describeValue()
}

/** `todo.write`：整表替换本会话清单，即时写委托存储（边跑边追加）。 */
async function writeTool(toolArgs: Rec, bag: Rec, env: CallEnv, deps: TodoDeps): Promise<Json> {
  const args: Rec = { ...toolArgs }
  if (typeof args['at'] !== 'string' || args['at'].length === 0) {
    const bagAt = bag['at']
    if (typeof bagAt === 'string' && bagAt.length > 0) args['at'] = bagAt
  }
  const conversationId = sessionIdOf(toolArgs, bag)
  if (conversationId === null) {
    throw new BadArgsError('conversation id not provided by caller')
  }
  const { items, summary } = normalizeItems(args, conversationId, resolveLimits())
  await deps.store.write(env.run, conversationId, asString(args['at']), items)
  return { ok: true, conversation_id: conversationId, ...summary }
}

/** `todo.read`：从自有存储取本会话清单（服务不读投影）。 */
async function readTool(toolArgs: Rec, bag: Rec, _env: CallEnv, deps: TodoDeps): Promise<Json> {
  const conversationId = sessionIdOf(toolArgs, bag)
  if (conversationId === null) {
    throw new BadArgsError('conversation id not provided by caller')
  }
  const items = await deps.store.read(conversationId)
  return summarize(items)
}

/** `todo.invoke`：按工具名派发；业务失败作 `{ok:false,error}` 值（不炸本轮）。 */
async function invokeTool(args: Rec, env: CallEnv, deps: TodoDeps): Promise<Json> {
  const tool = requireString(args, 'tool')
  const toolArgs = isRecord(args['args']) ? (args['args'] as Rec) : {}
  try {
    let value: Json
    if (tool === 'todo.write') value = await writeTool(toolArgs, args, env, deps)
    else if (tool === 'todo.read') value = await readTool(toolArgs, args, env, deps)
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

/** 构造方法表（依赖注入：委托存储由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: TodoDeps): Record<string, Handler> {
  return {
    describe: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: describeTool(isRecord(args) ? args : {}, env),
    }),
    invoke: async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: await invokeTool(isRecord(args) ? args : {}, env, deps),
    }),
  }
}
