// 能力类 `mcp-client` 的方法表：`list_tools` / `call_tool` / `close`。
// 只做 MCP stdio 传输与子进程生命周期：按 args 里的连接配置建连 / 复用 / 关闭，
// 传输错误作数据（结构化码）回灌、不吞；失败 / 隔离 / 重启策略不在此层（归消费方 `mcp`）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import type { McpClientRegistry } from './registry.ts'
import type { CallEnv, Handler, HandlerResult, Json } from 'plugin-sdk'

/** 服务依赖：连接表由 main 注入（单测可注入假实现）。 */
export interface McpClientDeps {
  registry: McpClientRegistry
}

function requireRecord(args: Json): Record<string, Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

/** `list_tools`：按连接配置确保连接后拉 `tools/list`。 */
async function listTools(args: Json, _env: CallEnv, deps: McpClientDeps): Promise<HandlerResult> {
  const parsed = requireRecord(args)
  return { value: await deps.registry.listTools(parsed, null), events: [] }
}

/** `call_tool`：按连接配置确保连接后转发 `tools/call`。 */
async function callTool(args: Json, _env: CallEnv, deps: McpClientDeps): Promise<HandlerResult> {
  const parsed = requireRecord(args)
  const tool = parsed['tool']
  if (typeof tool !== 'string' || tool.length === 0) throw new BadArgsError('tool required')
  return { value: await deps.registry.callTool(parsed, null), events: [] }
}

/** `close`：关闭指定 `server`（缺省全部）连接。 */
async function close(args: Json, _env: CallEnv, deps: McpClientDeps): Promise<HandlerResult> {
  const parsed = isRecord(args) ? args : {}
  return { value: await deps.registry.close(parsed), events: [] }
}

/** 构造方法表（依赖注入：连接表由入口提供，便于测试与确定性）。 */
export function createHandlers(deps: McpClientDeps): Record<string, Handler> {
  return {
    list_tools: (args: Json, env: CallEnv) => listTools(args, env, deps),
    call_tool: (args: Json, env: CallEnv) => callTool(args, env, deps),
    close: (args: Json, env: CallEnv) => close(args, env, deps),
  }
}
