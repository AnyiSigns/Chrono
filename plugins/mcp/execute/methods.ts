// 能力类 `mcp` 的方法表：`describe` / `invoke` / `discover`。
// 只构造值 / 写计划；不落账、不读投影、不自取时钟。写计划条目形状与宿主计划通道一致。
// 子进程生命周期事件经 events.ts 的持久出口上行，不随本方法的返回值。

import { emitEvent } from './events.ts'
import { log } from './frames.ts'
import { COMMANDS, IDENTITY } from './plugin.ts'
import { baseSeqOf, externOnly, isRecord, planOf, pushBodyGen } from './plan.ts'
import { McpRegistry } from './registry.ts'
import { SecretsLink } from './secrets-link.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

/** 反向调用链（服务 → 宿主 → secrets）：解析 auth_ref，明文只进子进程 env。 */
export const SECRETS = new SecretsLink()

/** 子进程表住内存（③ 可重算）；drain / 退出时由 main.ts 调 closeAll 终止全部外部子进程。 */
export const REGISTRY = new McpRegistry(log, emitEvent, (authRef, callId) => SECRETS.resolve(authRef, callId))

/** 本插件自述（不回外部工具清单——清单权威 = 数据世代 body 投影）。 */
function describeValue(): Json {
  return {
    tools: [],
    adapter: {
      identity: IDENTITY,
      capability: 'mcp',
      dynamic: true,
      namespace: 'mcp.<server>.<tool>',
      tool_source: 'projection:ids.mcp.body.tools',
      external_tools: 'authoritative in the data-generation body, not in describe',
      inbound_v1: {
        commands: COMMANDS,
        note: '契约就位、能力面待后续波次接线',
      },
    },
  }
}

async function describe(_args: Json, _env: CallEnv): Promise<HandlerResult> {
  return { value: describeValue() }
}

/**
 * `discover(bag)`：bag.servers = 整个 body（宿主 periodic `reads` 机械注入）。
 * 有变化 → 返回 `put(新 body) + add_gen(mcp)` 写计划；无变化且未置脏 → 只回 extern。
 */
async function discover(args: Json, _env: CallEnv, callId: string | null): Promise<HandlerResult> {
  const bag: Rec = isRecord(args) ? args : {}
  const outcome = await REGISTRY.discover(bag['servers'], callId)
  if (!outcome.changed) {
    return { value: externOnly({ ok: true, changed: false, ...outcome.summary }) }
  }
  const ops: Json[] = []
  pushBodyGen(ops, IDENTITY, isRecord(bag['servers']) ? bag['servers'] : {}, outcome.body, baseSeqOf(bag))
  return { value: planOf(ops, { ok: true, changed: true, ...outcome.summary }) }
}

/** `invoke(bag)`：bag = `{tool:"mcp.<server>.<tool>", tool_args}` → 路由到对应子进程。 */
async function invoke(args: Json, _env: CallEnv, callId: string | null): Promise<HandlerResult> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const tool = args['tool']
  if (typeof tool !== 'string' || tool.length === 0) throw new BadArgsError('tool required')
  const toolArgs = args['tool_args'] ?? args['args'] ?? args['arguments'] ?? {}
  const value = await REGISTRY.invoke(tool, toolArgs, callId)
  return { value }
}

export const HANDLERS: Record<string, Handler> = {
  describe,
  invoke,
  discover,
}
