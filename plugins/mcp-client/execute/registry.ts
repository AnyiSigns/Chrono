// 外部 MCP 服务器连接表与进程生命周期：按 `server` 键复用连接、配置变化重连、显式关闭，
// 以及停机 / 信号的 closeAll / killAllSync 兜底（不泄漏子进程）。传输错误一律作数据回灌，
// 不抛未捕获错误；失败 / 隔离 / 重启**策略**不在此层（归消费方 `mcp`）。
//
// 服务不读投影、不写世界：只按 args 登记并管理子进程，返回值 / 事件。

import { asString, canonicalJson, isRecord } from 'plugin-sdk'
import { McpConnection } from './connection.ts'
import type { McpServerConfig, McpTool } from './connection.ts'
import type { Json, Rec } from 'plugin-sdk'

/** 上行事件出口：宿主只透传、不落账、不推进。 */
export type EventSink = (topic: string, payload: Json) => void

interface Runtime {
  server: string
  signature: string
  conn: McpConnection | null
  /** 上一连接意外退出的原因；下一次建连时作为 `reconnected` 一次性回灌。 */
  pendingExit: string | null
}

/** `list_tools` 结果：成功带工具面，失败给结构化码；`reconnected` 为上一连接意外退出原因。 */
export type ListToolsOutcome =
  | { ok: true; tools: McpTool[]; reconnected: string | null }
  | { ok: false; error: { code: string; message: string }; reconnected: string | null }

/** `call_tool` 结果：成功带 MCP 结果，失败给结构化码；`reconnected` 同上。 */
export type CallToolOutcome =
  | { ok: true; result: Json; reconnected: string | null }
  | { ok: false; error: { code: string; message: string }; reconnected: string | null }

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function stringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 只取字符串值的 env 映射；非字符串值丢弃（auth_ref 由消费方解析后传入）。 */
function stringMap(value: Json | undefined): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}

/** 从 args 解析连接配置；`server` / `command` 缺失或非法回 null。 */
function configOf(input: Rec): McpServerConfig | null {
  const server = asString(input['server'])
  const command = asString(input['command'])
  if (server === null || command === null) return null
  const cwd = asString(input['cwd'])
  const config: McpServerConfig = {
    id: server,
    command,
    args: stringArray(input['args']),
    env: stringMap(input['env']),
  }
  if (cwd !== null) config.cwd = cwd
  return config
}

/** 连接配置签名：命令 / 参数 / 环境 / 工作目录变化 → 重连。 */
function configSignature(config: McpServerConfig): string {
  return canonicalJson({
    command: config.command,
    args: config.args ?? null,
    env: config.env ?? null,
    cwd: config.cwd ?? null,
  })
}

function failOutcome<T extends ListToolsOutcome | CallToolOutcome>(
  code: string,
  message: string,
  reconnected: string | null,
): T {
  return { ok: false, error: { code, message }, reconnected } as T
}

export class McpClientRegistry {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly log: (line: string) => void
  private readonly sink: EventSink
  /** 停机标志：置位后不再建连，且在途建连在 await 点后拒绝。 */
  private closing = false
  /** 在途建连 promise：`closeAll` 等它们落地再关闭，避免建连途中退出留下孤儿子进程。 */
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(log: (line: string) => void, sink: EventSink) {
    this.log = log
    this.sink = sink
  }

  /** 停机：先置 closing 并等在途建连落地，再关闭全部已登记连接（不泄漏子进程）。 */
  async closeAll(): Promise<void> {
    this.closing = true
    // 先关已登记连接（含正在握手的），再等在途建连落地——落地后可能新登记一个连接，
    // 故再扫一遍才清表，保证「建连途中退出」也不留孤儿。
    await this.closeRuntimes()
    await Promise.allSettled([...this.inflight])
    await this.closeRuntimes()
    this.runtimes.clear()
  }

  /**
   * 同步硬杀全部已登记连接（进程 `exit` / 信号兜底）：不等待、直接 `SIGKILL` 子进程。
   * 在途建连在 `connect()` 里已先置 `runtime.conn` 再 spawn，故此处也能触达刚起的子进程。
   */
  killAllSync(): void {
    this.closing = true
    for (const runtime of this.runtimes.values()) {
      const conn = runtime.conn
      runtime.conn = null
      conn?.kill()
    }
  }

  /** `list_tools`：确保连接（必要时 spawn + 握手）后拉工具清单；失败作数据。 */
  async listTools(input: Rec, _callId: string | null = null): Promise<ListToolsOutcome> {
    const config = configOf(input)
    if (config === null) return failOutcome('bad_config', 'server and command required', null)
    const opened = await this.ensureConnected(config)
    if (!opened.ok) return failOutcome(opened.error.code, opened.error.message, opened.reconnected)
    try {
      const tools = await opened.conn.listTools()
      return { ok: true, tools, reconnected: opened.reconnected }
    } catch (err) {
      this.dropConn(config.id, opened.conn)
      return failOutcome('mcp_list_failed', errMessage(err), opened.reconnected)
    }
  }

  /** `call_tool`：确保连接后转发 `tools/call`；失败作数据（不吞、不抛未捕获错误）。 */
  async callTool(input: Rec, _callId: string | null = null): Promise<CallToolOutcome> {
    const config = configOf(input)
    if (config === null) return failOutcome('bad_config', 'server and command required', null)
    const tool = asString(input['tool'])
    if (tool === null) return failOutcome('bad_args', 'tool required', null)
    const toolArgs = input['arguments'] ?? input['args'] ?? {}
    const opened = await this.ensureConnected(config)
    if (!opened.ok) return failOutcome(opened.error.code, opened.error.message, opened.reconnected)
    try {
      const result = await opened.conn.callTool(tool, toolArgs)
      return { ok: true, result, reconnected: opened.reconnected }
    } catch (err) {
      this.dropConn(config.id, opened.conn)
      return failOutcome('mcp_call_failed', errMessage(err), opened.reconnected)
    }
  }

  /** `close`：关闭指定 `server`（缺省全部）连接；返回关闭数量。 */
  async close(input: Rec): Promise<Json> {
    const server = asString(input['server'])
    let closed = 0
    if (server !== null) {
      if (await this.closeRuntime(server)) closed += 1
    } else {
      for (const id of [...this.runtimes.keys()]) {
        if (await this.closeRuntime(id)) closed += 1
      }
    }
    return { ok: true, closed }
  }

  private async closeRuntime(server: string): Promise<boolean> {
    const runtime = this.runtimes.get(server)
    if (runtime === undefined) return false
    this.runtimes.delete(server)
    const conn = runtime.conn
    runtime.conn = null
    if (conn === null) return false
    await conn.close().catch(() => undefined)
    return true
  }

  /** 关闭当前已登记连接并置空 `runtime.conn`；返回结算 promise 集合。 */
  private async closeRuntimes(): Promise<void> {
    const closes: Promise<void>[] = []
    for (const runtime of this.runtimes.values()) {
      const conn = runtime.conn
      runtime.conn = null
      if (conn !== null) closes.push(conn.close())
    }
    await Promise.allSettled(closes)
  }

  /**
   * 确保 `server` 有可用连接：同配置且存活则复用；配置变化 / 连接已死则重连。
   * 建连失败作数据返回；上一连接意外退出的原因经 `reconnected` 一次性回灌。
   */
  private async ensureConnected(
    config: McpServerConfig,
  ): Promise<
    | { ok: true; conn: McpConnection; reconnected: string | null }
    | { ok: false; error: { code: string; message: string }; reconnected: string | null }
  > {
    if (this.closing) {
      return {
        ok: false,
        error: { code: 'mcp_client_closing', message: 'registry closing' },
        reconnected: null,
      }
    }
    const signature = configSignature(config)
    let runtime = this.runtimes.get(config.id)
    if (runtime === undefined) {
      runtime = { server: config.id, signature, conn: null, pendingExit: null }
      this.runtimes.set(config.id, runtime)
    }
    if (runtime.conn !== null && runtime.conn.alive && runtime.signature === signature) {
      return { ok: true, conn: runtime.conn, reconnected: null }
    }
    if (runtime.conn !== null) {
      const stale = runtime.conn
      runtime.conn = null
      void stale.close()
    }
    // 配置变化是调用方主动改配，不算「意外退出」，不复位后的 pendingExit 回灌。
    if (runtime.signature !== signature) runtime.pendingExit = null
    runtime.signature = signature
    const reconnected = runtime.pendingExit
    runtime.pendingExit = null

    const conn = new McpConnection(config, {
      onLog: (line) => this.log(`[server ${config.id}] ${line}`),
      // list_changed 无需标记：消费方下一次 discover 一律重拉，清单真变化时由 body 差异驱动写世代。
      onDirty: () => undefined,
      // 仅当退出者仍是当前连接时才改写运行态（旧连接退出不覆盖新连接）。
      onExit: (reason) => this.handleExit(runtime, conn, reason),
    })
    runtime.conn = conn
    const task = conn.connect()
    this.inflight.add(task)
    try {
      await task
    } catch (err) {
      void conn.close()
      if (runtime.conn === conn) runtime.conn = null
      // 失败建连自身触发的 teardown 不是「上一连接退出」，不回灌。
      runtime.pendingExit = null
      return {
        ok: false,
        error: { code: 'mcp_connect_failed', message: errMessage(err) },
        reconnected,
      }
    } finally {
      this.inflight.delete(task)
    }
    return { ok: true, conn, reconnected }
  }

  /** 子进程意外退出：清连接、留退出原因供下一次建连回灌，并上行一条客户端生命周期事件。 */
  private handleExit(runtime: Runtime, conn: McpConnection, reason: string): void {
    if (runtime.conn !== conn) return
    runtime.conn = null
    runtime.pendingExit = reason
    this.sink('mcp-client.server', { server: runtime.server, event: 'exited', reason })
  }

  /** 连接已死：清 `runtime.conn` 并关闭（失败连接不再复用）。 */
  private dropConn(server: string, conn: McpConnection): void {
    const runtime = this.runtimes.get(server)
    if (runtime === undefined || runtime.conn !== conn) return
    runtime.conn = null
    void conn.close()
  }
}
