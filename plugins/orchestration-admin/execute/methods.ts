// 能力类方法表：`orchestration`[list, read, validate, propose] + `orchestration-admin`[describe, invoke]。
// 输入全部来自 bag（#33 装配）；服务不读投影、无写通道、不发 eff：validate 是本地复刻 dry-run，
// propose 只返回写计划（提案条目），宿主落账。invoke 按工具名内部派发到 orchestration.*。

import { validateBag } from './gate.ts'
import { isRecord } from './plan.ts'
import { proposeTool } from './propose.ts'
import { listTool, readTool } from './read.ts'
import { describeValue } from './tools.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

function bagOf(args: Json): Rec {
  return isRecord(args) ? args : {}
}

function wrap(fn: (bag: Rec, env: CallEnv) => Json | Promise<Json>): Handler {
  return async (args: Json, env: CallEnv): Promise<HandlerResult> => {
    return { value: await fn(bagOf(args), env) }
  }
}

/** `orchestration-admin.describe`：回四工具 + 四要素 + render 描述符。 */
function describeTool(): Json {
  return describeValue()
}

/** 工具名 → 实现（invoke 的派发表；未知工具 `unknown_tool`）。 */
function dispatch(tool: string, bag: Rec, env: CallEnv): Json {
  switch (tool) {
    case 'orchestration.list':
      return listTool(bag)
    case 'orchestration.read':
      return readTool(bag)
    case 'orchestration.validate':
      return validateBag(bag)
    case 'orchestration.propose':
      return proposeTool(bag, env)
    default:
      throw new ToolError('unknown_tool', tool)
  }
}

/** `orchestration-admin.invoke`：按工具名派发；业务失败作 `{ok:false,error}` 值（不炸本轮）。 */
function invokeTool(bag: Rec, env: CallEnv): Json {
  const tool = bag['tool']
  if (typeof tool !== 'string' || tool.length === 0) throw new BadArgsError('tool required')
  const toolArgs = isRecord(bag['args']) ? (bag['args'] as Rec) : {}
  try {
    return { ok: true, result: dispatch(tool, toolArgs, env) }
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

/** 按端口分组的方法表：main.ts 校验 `port` / `method` 后取用。 */
export const PORT_HANDLERS: Record<string, Record<string, Handler>> = {
  orchestration: {
    list: wrap((bag) => listTool(bag)),
    read: wrap((bag) => readTool(bag)),
    validate: wrap((bag) => validateBag(bag)),
    propose: wrap((bag, env) => proposeTool(bag, env)),
  },
  'orchestration-admin': {
    describe: wrap(() => describeTool()),
    invoke: wrap((bag, env) => invokeTool(bag, env)),
  },
}
