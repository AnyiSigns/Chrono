// 外部 MCP 服务器 stdio 客户端（零依赖，自己实现，不引 SDK）。
//
// 传输细节（按 MCP 规范 stdio binding）：客户端 spawn 服务器子进程后，双向以**换行分隔的
// JSON-RPC 消息**通信——每行一条完整消息、UTF-8 编码、消息内不得内嵌换行；**不是** LSP 的
// `Content-Length` 分帧。服务器 stderr 是日志通道（不是错误判据）。握手：
// `initialize` 请求 → 响应 → `notifications/initialized` 通知；随后 `tools/list` / `tools/call`。
//
// 本模块只认识 MCP；不认识宿主 / 内核，也不读投影。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

/** 协商的 MCP 协议版本（客户端声明，服务器可回带自己支持的版本）。 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** 单次 JSON-RPC 请求的等待上限（运维定时器，非世界时钟）。 */
export const MCP_REQUEST_TIMEOUT_MS = 15_000

/** 单行消息上限：防异常服务器撑爆内存（与宿主单帧上限同量级）。 */
export const MCP_MAX_LINE_BYTES = 16 * 1024 * 1024

/** 关闭子进程时等待其自行退出的宽限期，超时兜底强杀。 */
const MCP_CLOSE_GRACE_MS = 1000

export interface McpServerConfig {
  id: string
  command: string
  args?: string[]
  /** 已解析的追加环境变量（auth_ref 由 registry 在 spawn 前经 secrets.resolve 解析后填入）。 */
  env?: Record<string, string>
  cwd?: string
}

/** `tools/list` 条目（只取本插件用到的字段，其余原样丢弃）。 */
export interface McpTool {
  name: string
  description: string | null
  inputSchema: Json
  outputSchema: Json | null
  annotations: Json | null
}

export interface McpClientHandlers {
  onLog: (line: string) => void
  onDirty: () => void
  onExit: (reason: string) => void
}

interface Pending {
  resolve: (value: Json) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

function stringArgs(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function errorText(value: Json): string {
  if (isRecord(value)) {
    const message = value['message']
    if (typeof message === 'string') return message
  }
  return JSON.stringify(value)
}

export class McpConnection {
  private readonly config: McpServerConfig
  private readonly handlers: McpClientHandlers
  private child: ChildProcess | null = null
  private buffer = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private closing = false
  private torn = false

  constructor(config: McpServerConfig, handlers: McpClientHandlers) {
    this.config = config
    this.handlers = handlers
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.closing
  }

  /** spawn 子进程并完成 MCP `initialize` 握手；失败抛错（由调用方计失败 / 隔离）。 */
  async connect(): Promise<void> {
    if (this.alive) return
    if (this.closing) throw new Error('mcp_connection_closed')
    this.torn = false
    this.buffer = ''
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.config.env ?? {}) }
    const child = spawn(this.config.command, stringArgs(this.config.args), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.config.cwd,
      windowsHide: true,
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.on('data', (chunk: string) => this.onStderr(chunk))
    child.on('error', (err: Error) => this.teardown(`spawn_error: ${err.message}`))
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      this.teardown(`exit(${code ?? signal ?? 'unknown'})`),
    )
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'chrono-mcp', version: '0.0.0' },
    })
    this.notify('notifications/initialized', {})
  }

  /** `tools/list` → 规范化后的工具条目。 */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {})
    const raw = isRecord(result) && Array.isArray(result['tools']) ? result['tools'] : []
    const tools: McpTool[] = []
    for (const item of raw) {
      if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'].length === 0) continue
      tools.push({
        name: item['name'],
        description: typeof item['description'] === 'string' ? item['description'] : null,
        inputSchema: item['inputSchema'] ?? { type: 'object' },
        outputSchema: item['outputSchema'] ?? null,
        annotations: item['annotations'] ?? null,
      })
    }
    return tools
  }

  /** `tools/call` → MCP 结果对象（原样回传，本插件不解释）。 */
  callTool(name: string, args: Json): Promise<Json> {
    return this.request('tools/call', { name, arguments: args ?? {} })
  }

  /**
   * 终止子进程：先关 stdin（EOF，服务器应自退），宽限期内不退则 `SIGKILL`，
   * 并等真实 `exit` 才结算——忽略 SIGTERM / EOF 的 server 不会在父进程退出后成孤儿。
   * 定时器不 `unref`，避免进程提前退出令强杀落空。
   */
  async close(): Promise<void> {
    this.closing = true
    this.rejectPending('mcp_connection_closed')
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    try {
      child.stdin?.end()
    } catch {
      // stdin 已断：忽略，直接进入强杀兜底
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已退出：忽略
      }
    }, MCP_CLOSE_GRACE_MS)
    await exited
    clearTimeout(timer)
  }

  /** 同步硬杀（进程 `exit` / 信号兜底）：发 `SIGKILL` 并拒绝在途请求，不等待退出。 */
  kill(): void {
    this.closing = true
    this.rejectPending('mcp_connection_closed')
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已退出：忽略
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MCP_MAX_LINE_BYTES) {
      this.handlers.onLog('stdout line exceeds limit; dropping buffer')
      this.buffer = ''
      return
    }
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      this.onLine(line)
    }
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim().length > 0) this.handlers.onLog(line)
    }
  }

  private onLine(line: string): void {
    let message: Json
    try {
      message = JSON.parse(line) as Json
    } catch {
      this.handlers.onLog('invalid JSON-RPC line from server; ignored')
      return
    }
    if (!isRecord(message)) return
    const id = message['id']
    const hasResult = Object.hasOwn(message, 'result')
    const hasError = Object.hasOwn(message, 'error')
    if (typeof id === 'number' && (hasResult || hasError)) {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (hasError) pending.reject(new Error(errorText(message['error'] as Json)))
      else pending.resolve((message['result'] ?? null) as Json)
      return
    }
    const method = message['method']
    if (typeof method !== 'string') return
    if (id !== undefined && id !== null) {
      // 服务器 → 客户端的请求：v1 不支持（多轮往返后置），按 JSON-RPC 回 method_not_found。
      this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } })
      return
    }
    if (method === 'notifications/tools/list_changed') {
      this.handlers.onDirty()
      return
    }
    this.handlers.onLog(`notification ${method} ignored`)
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = (this.seq += 1)
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp_request_timeout: ${method}`))
      }, MCP_REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private notify(method: string, params: Json): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: Json): void {
    const child = this.child
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      throw new Error('mcp_not_connected')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  /** 子进程退出 / spawn 失败：拒绝在途请求并上报（close() 主动关闭时不重复上报）。 */
  private teardown(reason: string): void {
    if (this.torn) return
    this.torn = true
    if (this.closing) {
      this.child = null
      this.rejectPending('mcp_connection_closed')
      return
    }
    this.child = null
    this.rejectPending(reason)
    this.handlers.onExit(reason)
  }
}
