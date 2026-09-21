// 能力类 `tool-http` 的方法表：describe / invoke。
// invoke 的 bag 带 tool / args / caps / tier / workspace_root / sandbox_tiers / grant 与配置 body；
// 服务只消费 bag、回结果或结构化错误，不读投影、不取时间、不写世界。

import { createReverseBackend } from './backend.ts'
import { mergeConfig } from './config.ts'
import { describeTools } from './describe.ts'
import { ReverseLink } from './reverse.ts'
import { websearch } from './websearch.ts'
import { webfetch } from './webfetch.ts'
import { fail, isRec } from './types.ts'
import type { CallEnv, Json, Rec, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

/** 反向调用链（服务 → 宿主 → 隔离执行 / 资产存取）。 */
export const REVERSE = new ReverseLink()

const BACKEND = createReverseBackend(REVERSE)

/** 从 invoke bag 组装调用上下文。 */
export function buildContext(bag: Rec): ToolContext {
  return {
    config: mergeConfig(bag['config']),
    caps: isRec(bag['caps']) ? bag['caps'] : undefined,
    tier: typeof bag['tier'] === 'string' ? bag['tier'] : undefined,
    workspaceRoot: typeof bag['workspace_root'] === 'string' ? bag['workspace_root'] : undefined,
    sandboxTiers: bag['sandbox_tiers'],
    grant: bag['grant'],
    backend: BACKEND,
  }
}

/** invoke 入口：按工具名路由到 websearch / webfetch；异常兜底转结构化错误（不炸本轮）。 */
export async function invoke(args: Json): Promise<ToolResult> {
  try {
    return await dispatch(args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail('tool_failed', message.length > 0 ? message : 'invoke failed')
  }
}

async function dispatch(args: Json): Promise<ToolResult> {
  const bag = isRec(args) ? args : {}
  const tool = bag['tool']
  if (typeof tool !== 'string' || tool.length === 0) return fail('bad_args', 'tool is required')
  const toolArgs = bag['args'] ?? {}
  const ctx = buildContext(bag)
  if (tool === 'websearch') return websearch(toolArgs, ctx)
  if (tool === 'webfetch') return webfetch(toolArgs, ctx)
  return fail('unknown_tool', `unknown tool ${tool}`)
}

export const HANDLERS: Record<string, (args: Json, env: CallEnv) => Promise<Json>> = {
  describe: async () => describeTools() as unknown as Json,
  invoke: async (args) => (await invoke(args)) as unknown as Json,
}
