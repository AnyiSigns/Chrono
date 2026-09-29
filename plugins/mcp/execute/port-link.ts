// `mcp-client` 后端抽象：生产环境经 SDK 反向调用通道发 `port.call mcp-client.*`，单测注入假后端。
// 传输错误作数据（结构化码），不抛未捕获错误、不断通道；失败 / 隔离 / 重启策略留本插件（消费方）。
// 反向调用等待上限严格小于本服务 `mcp.discover` 的 `method_timeouts`，形成嵌套超时。

import { asString, isRecord } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'
import type { PortCaller } from 'plugin-sdk'

/** `mcp-client.list_tools` 的反向调用等待上限；须严格小于 `mcp.discover`（60000）。 */
export const MCP_CLIENT_LIST_TIMEOUT_MS = 40000

/** `mcp-client.call_tool` 的反向调用等待上限。 */
export const MCP_CLIENT_CALL_TIMEOUT_MS = 45000

/** `mcp-client.close` 的反向调用等待上限；关闭含宽限强杀，留足时间。 */
export const MCP_CLIENT_CLOSE_TIMEOUT_MS = 5000

/** `list_tools` 回灌：成功给原始工具条目，失败给结构化码；`reconnected` = 上一连接意外退出原因。 */
export type McpClientListOutcome =
  | { ok: true; tools: Rec[]; reconnected: string | null }
  | { ok: false; code: string; message: string; reconnected: string | null }

/** `call_tool` 回灌：成功给 MCP 结果，失败给结构化码。 */
export type McpClientCallOutcome =
  | { ok: true; result: Json; reconnected: string | null }
  | { ok: false; code: string; message: string; reconnected: string | null }

/** 外部 MCP 连接提供方抽象：生产环境是反向调用 `mcp-client.*`，单测注入假后端。 */
export interface McpClientBackend {
  listTools(input: Rec, callId: string | null): Promise<McpClientListOutcome>
  callTool(input: Rec, callId: string | null): Promise<McpClientCallOutcome>
  close(server: string, callId: string | null): Promise<void>
}

function errorOf(value: Rec): { code: string; message: string } {
  const error = isRecord(value['error']) ? value['error'] : {}
  return {
    code: asString(error['code']) ?? 'mcp_client_failed',
    message: asString(error['message']) ?? 'mcp-client returned a failure',
  }
}

function reconnectedOf(value: Rec): string | null {
  return typeof value['reconnected'] === 'string' ? value['reconnected'] : null
}

/** `mcp-client.*` 的反向调用后端：回包映射成结构化结果，失败不抛。 */
export class RemoteMcpClient implements McpClientBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async listTools(input: Rec, callId: string | null): Promise<McpClientListOutcome> {
    const outcome = await this.link.call('mcp-client', 'list_tools', input, {
      callId,
      timeoutMs: MCP_CLIENT_LIST_TIMEOUT_MS,
    })
    if (!outcome.ok)
      return { ok: false, code: outcome.code, message: outcome.message, reconnected: null }
    const value = isRecord(outcome.value) ? outcome.value : null
    if (value === null) {
      return {
        ok: false,
        code: 'mcp_client_bad_result',
        message: 'list_tools returned a non-object',
        reconnected: null,
      }
    }
    const reconnected = reconnectedOf(value)
    if (value['ok'] === false) {
      const error = errorOf(value)
      return { ok: false, code: error.code, message: error.message, reconnected }
    }
    const tools = Array.isArray(value['tools']) ? value['tools'].filter(isRecord) : []
    return { ok: true, tools, reconnected }
  }

  async callTool(input: Rec, callId: string | null): Promise<McpClientCallOutcome> {
    const outcome = await this.link.call('mcp-client', 'call_tool', input, {
      callId,
      timeoutMs: MCP_CLIENT_CALL_TIMEOUT_MS,
    })
    if (!outcome.ok)
      return { ok: false, code: outcome.code, message: outcome.message, reconnected: null }
    const value = isRecord(outcome.value) ? outcome.value : null
    if (value === null) {
      return {
        ok: false,
        code: 'mcp_client_bad_result',
        message: 'call_tool returned a non-object',
        reconnected: null,
      }
    }
    const reconnected = reconnectedOf(value)
    if (value['ok'] === false) {
      const error = errorOf(value)
      return { ok: false, code: error.code, message: error.message, reconnected }
    }
    return { ok: true, result: value['result'] ?? null, reconnected }
  }

  async close(server: string, callId: string | null): Promise<void> {
    await this.link.call(
      'mcp-client',
      'close',
      { server },
      { callId, timeoutMs: MCP_CLIENT_CLOSE_TIMEOUT_MS },
    )
  }
}
