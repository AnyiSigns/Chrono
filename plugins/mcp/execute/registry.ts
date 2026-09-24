// 外部 MCP 服务器表与出站发现编排：按数据世代 body 清单连已确认服务器、拉 `tools/list`、
// 产出新 body（服务器配置 + 命名空间化工具清单）。子进程表与易变运行态住内存（③ 可重算）。
//
// 服务无写通道：本模块只算「新 body」与事件，写计划由 methods.ts 组装、宿主落账。
// 服务不读投影：清单随调用方 bag 传入（宿主 periodic reads 机械注入）。
// 事件经持久 sink 直接上行（不依附某次调用的返回值），故子进程在两次调用之间退出也能上报。

import { McpConnection } from './mcp-client.ts'
import type { McpTool } from './mcp-client.ts'
import { canonicalString, isRecord } from './plan.ts'
import { authRefOf } from './secrets-link.ts'
import type { SecretResult } from './secrets-link.ts'
import type { Json, Rec } from './types.ts'

/** 连续失败到该次数仍无法连接 → 隔离该服务器条目。 */
export const DEFAULT_MAX_FAILURES = 3

/** 持久事件出口：服务 → 宿主 `event` 帧（宿主只透传，不落账、不推进）。 */
export type EventSink = (topic: string, payload: Json) => void

interface RestartConfig {
  policy: 'on-exit' | 'never'
  max: number
}

interface Runtime {
  id: string
  entry: Rec
  signature: string
  confirmed: boolean
  restart: RestartConfig
  failures: number
  isolated: boolean
  isolation: Json | null
  tools: Rec[]
  toolsSignature: string
  lastError: string | null
  conn: McpConnection | null
}

function stringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorValue(code: string, message: string): Json {
  return { ok: false, error: { code, message } }
}

function restartOf(entry: Rec): RestartConfig {
  const raw = isRecord(entry['restart']) ? entry['restart'] : {}
  const policy = raw['policy'] === 'never' ? 'never' : 'on-exit'
  const maxRaw = raw['max']
  const max =
    typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw > 0
      ? maxRaw
      : DEFAULT_MAX_FAILURES
  return { policy, max }
}

/** 服务器「连接配置」签名：命令 / 参数 / 环境 / 工作目录变化 → 重连并复位失败计数。 */
function configSignature(entry: Rec): string {
  return canonicalString({
    command: entry['command'] ?? null,
    args: entry['args'] ?? null,
    env: entry['env'] ?? null,
    cwd: entry['cwd'] ?? null,
  })
}

/** `mcp.<server>.<tool>` → `{server, tool}`；形态不符返回 null。 */
function parseToolRef(toolRef: string): { server: string; tool: string } | null {
  const parts = toolRef.split('.')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  const server = parts[1]
  const tool = parts.slice(2).join('.')
  if (server.length === 0 || tool.length === 0) return null
  return { server, tool }
}

/** 能映射到渲染器就映射，映射不出一律 `json`（中性兜底，展示端不空白、不报错）。 */
function detailKind(tool: McpTool): string {
  if (isRecord(tool.annotations)) {
    const type = tool.annotations['content_type'] ?? tool.annotations['contentType']
    if (typeof type === 'string' && type.startsWith('image')) return 'image'
  }
  if (isRecord(tool.outputSchema) && tool.outputSchema['format'] === 'image') return 'image'
  return 'json'
}

/** 外部 MCP 工具声明：命名空间化 + 四要素兜底 + 中性 render 描述符。 */
function toolDecl(serverId: string, tool: McpTool): Rec {
  const name = `mcp.${serverId}.${tool.name}`
  const description = tool.description
  const argsSchema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' }
  const paramSemantics: Rec = {}
  if (isRecord(argsSchema) && isRecord(argsSchema['properties'])) {
    for (const [key, prop] of Object.entries(argsSchema['properties'])) {
      const text =
        isRecord(prop) && typeof prop['description'] === 'string' && prop['description'].length > 0
          ? prop['description']
          : `参数 ${key}`
      paramSemantics[key] = text
    }
  }
  return {
    name,
    server: serverId,
    tool: tool.name,
    intent: description ?? `调用外部 MCP 工具 ${tool.name}`,
    when_to_use: description ?? `需要外部 MCP 服务器 ${serverId} 的 ${tool.name} 能力时`,
    param_semantics: paramSemantics,
    boundaries: '由外部 MCP 服务器定义',
    description: description ?? `外部 MCP 工具 ${name}`,
    argsSchema,
    caps: {
      fs: { read: 'none', write: 'none' },
      net: false,
      timeout_ms: 30000,
      mem_mb: 1024,
      output_max: 1048576,
      procs_max: 32,
    },
    idempotent: false,
    render: {
      form: 'card',
      label: name,
      summary: '{tool}',
      tone: 'ghost',
      detail: { kind: detailKind(tool) },
      live: false,
    },
  }
}

function isolationReason(runtime: Runtime): string {
  if (isRecord(runtime.isolation) && typeof runtime.isolation['reason'] === 'string') {
    return runtime.isolation['reason']
  }
  return 'isolated'
}

export interface DiscoverOutcome {
  body: Rec
  changed: boolean
  summary: Rec
}

export class McpRegistry {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly log: (line: string) => void
  private readonly sink: EventSink
  private readonly resolveAuthRef: (authRef: Rec, callId: string | null) => Promise<SecretResult>
  /** 停机标志：置位后不再建连，且在途建连在 await 点后拒绝。 */
  private closing = false
  /** 在途建连 promise（含 buildEnv 的 await 间隙）：`closeAll` 等它们落地再关闭。 */
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(
    log: (line: string) => void,
    sink: EventSink,
    resolveAuthRef: (authRef: Rec, callId: string | null) => Promise<SecretResult>,
  ) {
    this.log = log
    this.sink = sink
    this.resolveAuthRef = resolveAuthRef
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

  /** 关闭当前已登记连接并置空 `runtime.conn`；返回结算 promise 集合。 */
  private closeRuntimes(): Promise<unknown> {
    const closes: Promise<void>[] = []
    for (const runtime of this.runtimes.values()) {
      const conn = runtime.conn
      runtime.conn = null
      if (conn !== null) closes.push(conn.close())
    }
    return Promise.allSettled(closes)
  }

  /**
   * 按清单重新发现：连已确认服务器 → `initialize` → `tools/list`，产出新 body。
   * `changed=false`（body 内容无变化）时调用方只回 extern、不产写计划。
   */
  async discover(bodyInput: Json | undefined, callId: string | null = null): Promise<DiscoverOutcome> {
    const { record, servers: inputServers } = normalizeBody(bodyInput)
    const seen = new Set<string>()
    const outServers: Json[] = []
    const outTools: Json[] = []
    let isolatedCount = 0

    for (const entry of inputServers) {
      const id = typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : null
      const command =
        typeof entry['command'] === 'string' && entry['command'].length > 0 ? entry['command'] : null
      if (id === null || command === null) {
        outServers.push(entry)
        continue
      }
      seen.add(id)
      const runtime = this.runtimeFor(entry)
      if (!runtime.confirmed) {
        runtime.conn?.close()
        runtime.conn = null
        runtime.tools = []
        runtime.toolsSignature = ''
      } else if (runtime.isolated) {
        runtime.tools = []
      } else {
        await this.refresh(runtime, callId)
      }
      if (runtime.isolated) isolatedCount += 1
      outServers.push(statusEntry(runtime))
      for (const decl of runtime.tools) outTools.push(decl)
    }

    for (const id of [...this.runtimes.keys()]) {
      if (seen.has(id)) continue
      this.runtimes.get(id)?.conn?.close()
      this.runtimes.delete(id)
    }

    const next: Rec = { ...record, version: 1, servers: outServers, tools: outTools }
    // 只按 body 内容判定变化：易变运行态不写回，故同一状态重复 discover 不产生新世代。
    const changed = canonicalString(next) !== canonicalString(record)
    return {
      body: next,
      changed,
      summary: {
        servers: outServers.length,
        tools: outTools.length,
        isolated: isolatedCount,
      },
    }
  }

  /** `invoke`：按最近一次 discover 建立的服务器表路由到对应子进程 `tools/call`。 */
  async invoke(toolRef: string, toolArgs: Json, callId: string | null = null): Promise<Json> {
    const parsed = parseToolRef(toolRef)
    if (parsed === null) {
      return errorValue('bad_tool_ref', `tool must be mcp.<server>.<tool>: ${toolRef}`)
    }
    const runtime = this.runtimes.get(parsed.server)
    if (runtime === undefined) {
      return errorValue('mcp_server_unknown', `unknown MCP server ${parsed.server}`)
    }
    if (!runtime.confirmed) {
      return errorValue('mcp_server_unconfirmed', `server ${parsed.server} is not confirmed`)
    }
    if (runtime.isolated) {
      return errorValue(
        'mcp_server_isolated',
        `server ${parsed.server} is isolated: ${isolationReason(runtime)}`,
      )
    }
    if (!runtime.tools.some((decl) => decl['tool'] === parsed.tool)) {
      return errorValue(
        'mcp_tool_unknown',
        `tool ${parsed.tool} is not in the discovered list of ${parsed.server}`,
      )
    }
    let conn: McpConnection | null = null
    try {
      conn = await this.ensureConnected(runtime, callId)
      const result = await conn.callTool(parsed.tool, toolArgs)
      return { ok: true, result }
    } catch (err) {
      const reason = errMessage(err)
      // 仅当失败者仍是当前连接时记账：子进程退出已由 handleExit 计过，避免同一失败双计。
      if (conn !== null && runtime.conn === conn) {
        runtime.conn = null
        runtime.toolsSignature = ''
        void conn.close()
        this.recordFailure(runtime, reason)
      }
      return errorValue('mcp_call_failed', reason)
    }
  }

  private async refresh(runtime: Runtime, callId: string | null): Promise<void> {
    let conn: McpConnection | null = null
    try {
      conn = await this.ensureConnected(runtime, callId)
      const list = await conn.listTools()
      // 重拉期间子进程可能已退出：退出回调已改写运行态，此处不再用死连接的数据覆盖。
      if (runtime.conn !== conn || !conn.alive) return
      const decls = list.map((tool) => toolDecl(runtime.id, tool))
      const signature = decls.map((decl) => String(decl['name'])).join('\n')
      if (signature !== runtime.toolsSignature) {
        this.emitServer(runtime, 'discovered', { tools: decls.length })
      }
      runtime.failures = 0
      runtime.lastError = null
      runtime.tools = decls
      runtime.toolsSignature = signature
    } catch (err) {
      const reason = errMessage(err)
      if (conn !== null && runtime.conn === conn) {
        runtime.conn = null
        void conn.close()
        this.recordConnectFailure(runtime, reason)
      }
      // conn === null：ensureConnected 已记账；handleExit 已处理的失败不再重复。
    }
  }

  private async ensureConnected(runtime: Runtime, callId: string | null): Promise<McpConnection> {
    if (runtime.conn !== null && runtime.conn.alive) return runtime.conn
    runtime.conn?.close()
    runtime.conn = null
    // 建连含 `buildEnv` 的 await 间隙（可能经 secrets 反向调用）：先登记在途 promise，
    // 令 `closeAll` 能等它落地再关闭，避免建连途中退出留下孤儿子进程。
    const task = this.connect(runtime, callId)
    this.inflight.add(task)
    try {
      return await task
    } finally {
      this.inflight.delete(task)
    }
  }

  private async connect(runtime: Runtime, callId: string | null): Promise<McpConnection> {
    if (this.closing) throw new Error('mcp_registry_closing')
    let env: Record<string, string>
    try {
      env = await this.buildEnv(runtime.entry, callId)
    } catch (err) {
      this.recordConnectFailure(runtime, errMessage(err))
      throw err
    }
    if (this.closing) throw new Error('mcp_registry_closing')
    let conn!: McpConnection
    conn = new McpConnection(
      {
        id: runtime.id,
        command: runtime.entry['command'] as string,
        args: stringArray(runtime.entry['args']),
        env,
        cwd: typeof runtime.entry['cwd'] === 'string' ? (runtime.entry['cwd'] as string) : undefined,
      },
      {
        onLog: (line) => this.log(`[server ${runtime.id}] ${line}`),
        // list_changed 无需标记：下一次 discover 一律重拉，清单真变化时由 body 差异驱动写世代。
        onDirty: () => undefined,
        // 回带连接身份：仅当退出者仍是当前连接时才改写运行态（旧连接退出不覆盖新连接）。
        onExit: (reason) => this.handleExit(runtime, conn, reason),
      },
    )
    runtime.conn = conn
    try {
      await conn.connect()
    } catch (err) {
      void conn.close()
      if (runtime.conn === conn) {
        runtime.conn = null
        runtime.toolsSignature = ''
        this.recordConnectFailure(runtime, errMessage(err))
      }
      throw err
    }
    return conn
  }

  /**
   * 组装子进程 env：字符串值原样，`{auth_ref}` 值经 `secrets.resolve` 解析后注入同名变量。
   * 解析失败抛错（由调用方计入连接失败），明文只进 spawn env，不进日志 / 世界 / 计划。
   */
  private async buildEnv(entry: Rec, callId: string | null): Promise<Record<string, string>> {
    const raw = isRecord(entry['env']) ? entry['env'] : {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        out[key] = value
        continue
      }
      const authRef = authRefOf(value)
      if (authRef === null) continue
      const resolved = await this.resolveAuthRef(authRef, callId)
      if (!resolved.ok) {
        throw new Error(`auth_ref resolve failed for env ${key}: ${resolved.code}`)
      }
      out[key] = resolved.value
    }
    return out
  }

  /**
   * 子进程退出：计一次失败（空闲崩溃也计），按 `restart.policy` / `restart.max` 决定隔离。
   * 仅当退出者仍是当前连接时改写（旧连接退出不覆盖新连接），避免与在途 invoke / refresh 交错。
   */
  private handleExit(runtime: Runtime, conn: McpConnection, reason: string): void {
    if (runtime.conn !== conn) return
    runtime.conn = null
    runtime.toolsSignature = ''
    const text = `server_exited: ${reason}`
    if (runtime.restart.policy === 'never') {
      runtime.failures += 1
      runtime.lastError = text
      runtime.isolated = true
      runtime.isolation = { reason: text, failures: runtime.failures }
      this.emitServer(runtime, 'isolated', { reason: text, failures: runtime.failures })
      return
    }
    this.recordFailure(runtime, text)
    if (!runtime.isolated) this.emitServer(runtime, 'exited', { reason, failures: runtime.failures })
  }

  /** 记一次失败；到达 `restart.max` 即隔离并发事件。 */
  private recordFailure(runtime: Runtime, reason: string): void {
    runtime.failures += 1
    runtime.lastError = reason
    if (runtime.failures >= runtime.restart.max) {
      runtime.isolated = true
      runtime.isolation = { reason, failures: runtime.failures }
      this.emitServer(runtime, 'isolated', { failures: runtime.failures, reason })
    }
  }

  /** 连接建立失败（buildEnv / spawn / 握手）：清工具面、记账，未隔离时发 `connect_failed`。 */
  private recordConnectFailure(runtime: Runtime, reason: string): void {
    runtime.tools = []
    runtime.toolsSignature = ''
    this.recordFailure(runtime, reason)
    if (!runtime.isolated) {
      this.emitServer(runtime, 'connect_failed', { failures: runtime.failures, reason })
    }
  }

  private emitServer(runtime: Runtime, event: string, extra: Rec): void {
    this.sink('mcp.server', { server: runtime.id, event, run: null, thread: null, ...extra })
  }

  private runtimeFor(entry: Rec): Runtime {
    const id = entry['id'] as string
    const signature = configSignature(entry)
    let runtime = this.runtimes.get(id)
    if (runtime === undefined) {
      runtime = {
        id,
        entry,
        signature,
        confirmed: entry['confirmed'] === true,
        restart: restartOf(entry),
        failures: 0,
        isolated: false,
        isolation: null,
        tools: [],
        toolsSignature: '',
        lastError: null,
        conn: null,
      }
      this.runtimes.set(id, runtime)
      return runtime
    }
    if (runtime.signature !== signature) {
      // 连接配置变化：重连、复位失败计数，并解除隔离（给修好的配置一次重试机会）
      runtime.conn?.close()
      runtime.conn = null
      runtime.failures = 0
      runtime.lastError = null
      runtime.toolsSignature = ''
      runtime.isolated = false
      runtime.isolation = null
    }
    runtime.entry = entry
    runtime.signature = signature
    runtime.confirmed = entry['confirmed'] === true
    runtime.restart = restartOf(entry)
    return runtime
  }
}

function normalizeBody(value: Json | undefined): { record: Rec; servers: Rec[] } {
  if (Array.isArray(value)) {
    return { record: { version: 1, servers: value }, servers: value.filter(isRecord) }
  }
  if (isRecord(value)) {
    const servers = Array.isArray(value['servers']) ? value['servers'].filter(isRecord) : []
    return { record: value, servers }
  }
  return { record: { version: 1, servers: [] }, servers: [] }
}

/** 写回 body 的服务器条目：只保留配置（含 confirmed / trusted），剥离易变运行态。 */
const VOLATILE_ENTRY_KEYS = [
  'connected',
  'failures',
  'tool_count',
  'isolated',
  'isolation',
  'last_error',
] as const

function statusEntry(runtime: Runtime): Rec {
  const entry: Rec = { ...runtime.entry }
  for (const key of VOLATILE_ENTRY_KEYS) delete entry[key]
  entry['confirmed'] = runtime.confirmed
  return entry
}
