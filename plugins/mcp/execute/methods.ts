// 能力类 `mcp` 的方法表：`describe` / `invoke` / `discover` / `read` / `write`。
// 清单（服务器配置 + 发现到的外部工具）已出世界：写即时落自有持久存储（④，边跑边追加），读从自有存储取。
// 只返回值 / 事件；不落账、不读投影、不自取时钟。子进程生命周期事件经 events.ts 的持久出口上行。

import { emitEvent } from './events.ts'
import { log } from './frames.ts'
import { COMMANDS, IDENTITY } from './plugin.ts'
import { externOnly, isRecord } from './plan.ts'
import { McpRegistry } from './registry.ts'
import { SecretsLink } from './secrets-link.ts'
import { emptyBody, McpStore } from './store.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

/** 反向调用链（服务 → 宿主 → secrets）：解析 auth_ref，明文只进子进程 env。 */
export const SECRETS = new SecretsLink()

/** 子进程表住内存（③ 可重算）；drain / 退出时由 main.ts 调 closeAll 终止全部外部子进程。 */
export const REGISTRY = new McpRegistry(log, emitEvent, (authRef, callId) => SECRETS.resolve(authRef, callId))

/** 服务依赖：自有清单存储（main 注入；单测可注入假存储）。 */
export interface McpDeps {
  store: McpStore
}

/** 本插件自述（不回外部工具清单——清单权威 = owner 自有存储 `mcp.read`）。 */
function describeValue(): Json {
  return {
    tools: [],
    adapter: {
      identity: IDENTITY,
      capability: 'mcp',
      dynamic: true,
      namespace: 'mcp.<server>.<tool>',
      tool_source: 'service:mcp.read',
      external_tools: 'authoritative in the owner durable store, not in describe',
      inbound_v1: {
        commands: COMMANDS,
        note: '契约就位、能力面待后续波次接线',
      },
    },
  }
}

/** `read`：整份清单（服务器配置 + 工具）；owner 存储为空时回空体。 */
function read(_args: Json, _env: CallEnv, deps: McpDeps): Json {
  return deps.store.read()
}

/** `write`：整份替换清单（边跑边追加）；内容未变短路。 */
function write(args: Json, env: CallEnv, deps: McpDeps): Json {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const body = isRecord(args['body']) ? (args['body'] as Rec) : args
  if (!Array.isArray(body['servers']) || !Array.isArray(body['tools'])) {
    throw new BadArgsError('body must contain servers[] and tools[]')
  }
  const changed = deps.store.write(env.run, { ...body, version: 1 })
  return { ok: true, changed }
}

async function describe(_args: Json, _env: CallEnv): Promise<HandlerResult> {
  return { value: describeValue() }
}

/**
 * `discover`：读自有存储的服务器清单 → 连已确认服务器拉工具 → 有变化则写回自有存储。
 * 无变化只回 extern；不产世界写计划、不读投影。
 */
async function discover(_args: Json, env: CallEnv, deps: McpDeps, callId: string | null): Promise<HandlerResult> {
  const current = deps.store.read()
  const outcome = await REGISTRY.discover(current, callId)
  if (!outcome.changed) {
    return { value: externOnly({ ok: true, changed: false, ...outcome.summary }) }
  }
  deps.store.write(env.run, outcome.body)
  return { value: externOnly({ ok: true, changed: true, ...outcome.summary }) }
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

/** 构造方法表（依赖注入：清单存储由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: McpDeps): Record<string, Handler> {
  return {
    describe,
    read: (args: Json, env: CallEnv): Promise<HandlerResult> => Promise.resolve({ value: read(args, env, deps) }),
    write: (args: Json, env: CallEnv): Promise<HandlerResult> => Promise.resolve({ value: write(args, env, deps) }),
    discover: (args: Json, env: CallEnv, callId: string | null): Promise<HandlerResult> =>
      discover(args, env, deps, callId),
    invoke,
  }
}

export { emptyBody }
