// 能力类 `tool-http` 的方法表：describe / invoke。
// invoke 的 bag 带 tool / args / caps / tier / workspace_root / sandbox_tiers / grant 与配置 body；
// 服务只消费 bag、回结果或结构化错误，不读投影、不取时间、不写世界。

import { createReverseBackend } from './backend.ts'
import { mergeConfig } from './config.ts'
import { describeTools } from './describe.ts'
import { websearch } from './websearch.ts'
import { webfetch } from './webfetch.ts'
import { webresearch } from './webresearch.ts'
import { fail, isRec } from './types.ts'
import type { PortLink } from 'plugin-sdk'
import type { HttpBackend } from './backend.ts'
import type { CallEnv, Json, Rec, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

/** 从 invoke bag 组装调用上下文。 */
export function buildContext(bag: Rec, callId: string | null, backend: HttpBackend): ToolContext {
  return {
    config: mergeConfig(bag['config']),
    caps: isRec(bag['caps']) ? bag['caps'] : undefined,
    tier: typeof bag['tier'] === 'string' ? bag['tier'] : undefined,
    workspaceRoot: typeof bag['workspace_root'] === 'string' ? bag['workspace_root'] : undefined,
    sandboxTiers: bag['sandbox_tiers'],
    grant: bag['grant'],
    backend,
    callId,
  }
}

/** invoke 入口：按工具名路由；websearch 依 `read>0` 决定是否读正文；异常兜底转结构化错误（不炸本轮）。 */
export async function invoke(
  args: Json,
  callId: string | null,
  backend: HttpBackend,
): Promise<ToolResult> {
  try {
    return await dispatch(args, callId, backend)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail('tool_failed', message.length > 0 ? message : 'invoke failed')
  }
}

async function dispatch(
  args: Json,
  callId: string | null,
  backend: HttpBackend,
): Promise<ToolResult> {
  const bag = isRec(args) ? args : {}
  const tool = bag['tool']
  if (typeof tool !== 'string' || tool.length === 0) return fail('bad_args', 'tool is required')
  const toolArgs = bag['args'] ?? {}
  const ctx = buildContext(bag, callId, backend)
  if (tool === 'websearch') {
    const read = isRec(toolArgs) ? toolArgs['read'] : undefined
    const highlights = isRec(toolArgs) ? toolArgs['highlights'] : undefined
    // read>0 或要 highlights 都走研究形态（需抓正文）；否则只检索。
    if ((typeof read === 'number' && read > 0) || highlights === true) {
      return webresearch(toolArgs, ctx)
    }
    return websearch(toolArgs, ctx)
  }
  if (tool === 'webfetch') return webfetch(toolArgs, ctx)
  // 旧名保留：内部调用方 / 既有测试仍可直达研究形态（目录里只广告合并后的 websearch）。
  if (tool === 'webresearch') return webresearch(toolArgs, ctx)
  return fail('unknown_tool', `unknown tool ${tool}`)
}

/**
 * 构造方法表：反向调用通道由 main 注入（三形态共用同一 `ctx.emit`）。
 * `indexMembers` 是宿主机注入的 `search-index` 成员表（many）；缺省空 → 索引关闭，静默降级为纯网络检索。
 */
export function createHandlers(
  link: PortLink,
  indexMembers: readonly string[] = [],
): Record<string, (args: Json, env: CallEnv, callId: string | null) => Promise<Json>> {
  const backend = createReverseBackend(link, indexMembers[0] ?? null)
  return {
    describe: async () => describeTools() as unknown as Json,
    invoke: async (args, _env, callId) => (await invoke(args, callId, backend)) as unknown as Json,
  }
}
