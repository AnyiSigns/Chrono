// 整批 dispatch：批级解析 workspace_root → guard 兜底（有 verdicts 则跳过）→ 按最严批级判定
// 并发扇出到提供者（describe/invoke 提供者经扩展类 `tool-provider` 按成员定位调用；绑定项走能力类方法或投影读）。
// 本插件只返回 results，不落账、不冒泡 $directives；提供者错误原样透传。
// 目录经反向 `port.call tool-registry.list` 解析；args 校验经 `port.call tool-registry.validate-args`；
// 语义门经 `port.call guard.judge`；工具提供者经 `tool-provider` 扩展类按成员定位（成员来自世界，不改本模块）。

import { canonicalJson, isRecord } from 'plugin-sdk'
import type { CallEnv, Json, PortLink, PortOutcome, Rec } from 'plugin-sdk'
import type { ResultCache } from './cache.ts'
import { resolveCacheEnabled, resolveConcurrency } from './config.ts'
import { BadArgsError } from './types.ts'

/** 工具提供方扩展类（拥有方 `slots` 契约）：按目录条目的 `provider` 身份定位成员调用。 */
const TOOL_PROVIDER = 'tool-provider'

/** 派发上下文键：不进提供者 bag（工具声明 caps 会覆盖调用级 caps）。 */
const CONTROL_KEYS = new Set([
  'calls',
  'verdicts',
  'directory',
  'tools',
  'tools_bindings',
  'mcp_tools',
  'concurrency',
  'cache',
  'projection_reads',
  'guard_rules',
  'caps',
])

/** 视为「路径」的参数键：缺工作区时只有这些键下的相对路径才拒。 */
const PATH_KEYS = ['path', 'base', 'cwd', 'file', 'dir', 'directory', 'root']

/** 目录解析后端：生产环境经反向 `port.call tool-registry.list`。 */
export interface RegistryBackend {
  list(bag: Rec): Promise<Directory>
}

/** args 校验后端：生产环境经反向 `port.call tool-registry.validate-args`。 */
export interface SchemaBackend {
  validateArgs(schema: Json, value: Json): Promise<{ ok: boolean; message: string }>
}

export interface DispatchDeps {
  link: PortLink
  emit: (topic: string, payload: Json) => void
  registry: RegistryBackend
  schema: SchemaBackend
  concurrency: number
  cache: ResultCache
  cacheEnabled: boolean
}

export interface Rejection {
  name: string
  code: string
  message: string
}

export interface ToolEntry {
  name: string
  provider: string
  kind: 'invoke' | 'binding'
  method: string | null
  read: string | null
  decl: Rec
}

export interface Directory {
  tools: ToolEntry[]
  byName: Map<string, ToolEntry>
  rejected: Rejection[]
}

/** 从 `list` 的输出重建目录：按名索引，保留 provider / kind / method / read。 */
export function indexDirectory(json: Json): Directory {
  const record = isRecord(json) ? json : {}
  const rawTools = Array.isArray(record['tools']) ? (record['tools'] as Json[]) : []
  const rejected = Array.isArray(record['rejected'])
    ? (record['rejected'] as Json[]).filter(isRecord).map((item) => ({
        name: typeof item['name'] === 'string' ? (item['name'] as string) : '',
        code: typeof item['code'] === 'string' ? (item['code'] as string) : 'bad_tool_decl',
        message: typeof item['message'] === 'string' ? (item['message'] as string) : '',
      }))
    : []
  const tools: ToolEntry[] = []
  for (const raw of rawTools) {
    if (!isRecord(raw)) continue
    const name = raw['name']
    if (typeof name !== 'string' || name.length === 0) continue
    const kind = raw['kind'] === 'binding' ? 'binding' : 'invoke'
    const provider = typeof raw['provider'] === 'string' ? (raw['provider'] as string) : ''
    const method = typeof raw['method'] === 'string' ? (raw['method'] as string) : null
    const read = typeof raw['read'] === 'string' ? (raw['read'] as string) : null
    tools.push({ name, provider, kind, method, read, decl: raw })
  }
  return { tools, byName: new Map(tools.map((entry) => [entry.name, entry])), rejected }
}

/**
 * 解析目录：调用方已随 bag 给出 `directory` / `tools` 则本地索引复用（不依赖 `tool-registry` 存活）；
 * 否则交 `tool-registry.list` 现场装配（拉 describe 并集 + 绑定表 + MCP）。
 */
async function resolveDirectory(bag: Rec, deps: DispatchDeps): Promise<Directory> {
  if (isRecord(bag['directory']) && Array.isArray((bag['directory'] as Rec)['tools'])) {
    return indexDirectory(bag['directory'])
  }
  if (Array.isArray(bag['tools'])) {
    return indexDirectory({ tools: bag['tools'], rejected: [] })
  }
  return deps.registry.list(bag)
}

interface CallEntry {
  index: number
  callId: string
  tool: string
  args: Rec
  entry: ToolEntry | null
  preError: { code: string; message: string } | null
}

/** 结果形状：`{call_id, ok, result|error}`，按 call_id 保序。 */
interface CallResult {
  call_id: string
  ok: boolean
  result?: Json
  error?: Rec
}

/** dispatch(bag) 主入口。 */
export async function dispatchBag(bag: Json, env: CallEnv, deps: DispatchDeps): Promise<Json> {
  if (bag !== null && !isRecord(bag)) throw new BadArgsError('bag must be an object')
  const record: Rec = isRecord(bag) ? bag : {}
  const rawCalls = record['calls']
  if (rawCalls !== undefined && rawCalls !== null && !Array.isArray(rawCalls)) {
    throw new BadArgsError('calls must be an array')
  }
  const calls = Array.isArray(rawCalls) ? (rawCalls as Json[]) : []
  const directory = await resolveDirectory(record, deps)
  const workspaceRoot =
    typeof record['workspace_root'] === 'string' && (record['workspace_root'] as string).length > 0
      ? (record['workspace_root'] as string)
      : null

  const entries = await Promise.all(
    calls.map((call, index) => toEntry(call, index, directory, workspaceRoot, deps.schema)),
  )

  const batchVerdict = await resolveBatchVerdict(record, entries, deps)

  const concurrency = resolveConcurrency(record, deps.concurrency)
  const cacheEnabled = deps.cacheEnabled && resolveCacheEnabled(record, true)
  const results = await pool(entries, concurrency, (entry) =>
    runEntry(entry, record, batchVerdict, env, deps, cacheEnabled),
  )
  return { results: results as unknown as Json }
}

async function toEntry(
  call: Json,
  index: number,
  directory: Directory,
  workspaceRoot: string | null,
  schema: SchemaBackend,
): Promise<CallEntry> {
  const fallbackId = `call-${index}`
  if (!isRecord(call)) {
    return {
      index,
      callId: fallbackId,
      tool: '',
      args: {},
      entry: null,
      preError: { code: 'bad_args', message: 'call must be an object' },
    }
  }
  const callId =
    typeof call['call_id'] === 'string' && (call['call_id'] as string).length > 0
      ? (call['call_id'] as string)
      : fallbackId
  const tool = typeof call['tool'] === 'string' ? (call['tool'] as string) : ''
  const rawArgs = call['args']
  if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
    return {
      index,
      callId,
      tool,
      args: {},
      entry: null,
      preError: { code: 'bad_args', message: 'call.args must be an object' },
    }
  }
  const args: Rec = isRecord(rawArgs) ? rawArgs : {}
  if (tool.length === 0) {
    return {
      index,
      callId,
      tool,
      args,
      entry: null,
      preError: { code: 'bad_args', message: 'call.tool is required' },
    }
  }
  const entry = directory.byName.get(tool)
  if (entry === undefined) {
    const rejected = directory.rejected.find((item) => item.name === tool)
    if (rejected !== undefined) {
      return {
        index,
        callId,
        tool,
        args,
        entry: null,
        preError: { code: 'bad_tool_decl', message: rejected.message },
      }
    }
    return {
      index,
      callId,
      tool,
      args,
      entry: null,
      preError: { code: 'unknown_tool', message: `unknown tool ${tool}` },
    }
  }
  const argsError = await validateCallArgs(entry, args, schema)
  if (argsError !== null) {
    return {
      index,
      callId,
      tool,
      args,
      entry: null,
      preError: { code: 'bad_args', message: argsError },
    }
  }
  if (workspaceRoot === null && needsWorkspace(entry, args)) {
    return {
      index,
      callId,
      tool,
      args,
      entry: null,
      preError: { code: 'workspace_missing', message: 'workspace_root required for relative path' },
    }
  }
  return { index, callId, tool, args, entry, preError: null }
}

/** 逐 call args 校验（同一方言）；失败回可读原因。用完整 schema（含调用方注入参数）。 */
async function validateCallArgs(
  entry: ToolEntry,
  args: Rec,
  schema: SchemaBackend,
): Promise<string | null> {
  const result = await schema.validateArgs(
    entry.decl['validateSchema'] ?? entry.decl['argsSchema'],
    args,
  )
  return result.ok ? null : result.message
}

/** 是否缺工作区才拒：工具触盘（caps.fs 非 none）且 args 里存在相对路径值。 */
function needsWorkspace(entry: ToolEntry, args: Rec): boolean {
  const caps = entry.decl['caps']
  if (!isRecord(caps) || !isRecord(caps['fs'])) return false
  const fs = caps['fs'] as Rec
  const touchesFs =
    (fs['read'] !== 'none' && fs['read'] !== undefined) ||
    (fs['write'] !== 'none' && fs['write'] !== undefined)
  if (!touchesFs) return false
  return hasRelativePath(args)
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('//') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  )
}

function hasRelativePath(args: Rec): boolean {
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0 && !isAbsolutePath(value)) return true
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0 && !isAbsolutePath(item)) return true
      }
    }
  }
  return false
}

/** 规范化 net 范围：只认 none / limited / all，其余视为 none。 */
function netScope(value: Json | undefined): string {
  return value === 'limited' || value === 'all' ? value : 'none'
}

/** 工具声明的 net 需求：从目录条目的 caps.net 取（只认 none / limited / all；缺失 / 畸形按 none）。 */
function declaredNetOf(entry: CallEntry): string {
  const caps = entry.entry?.decl['caps']
  return isRecord(caps) ? netScope(caps['net']) : 'none'
}

/** 内建档位 net 映射（sandbox body 缺失时兜底；与 sandbox tools/default-body.json 同形）。 */
const BUILTIN_TIER_NET: Record<string, string> = {
  auto: 'all',
  severe: 'limited',
  review: 'none',
  deny: 'none',
}

/** 当前档位的 net 范围：bag.sandbox_tiers 覆盖 > 内建；未知 / 缺失档位 fail-closed none。 */
function tierNetOf(tier: Json | undefined, sandboxTiers: Json | undefined): string {
  const tiers = isRecord(sandboxTiers) ? sandboxTiers['tiers'] : undefined
  if (typeof tier === 'string' && isRecord(tiers)) {
    const entry = tiers[tier]
    if (isRecord(entry)) {
      const declared = entry['net']
      if (declared === 'none' || declared === 'limited' || declared === 'all') return declared
    }
  }
  if (typeof tier === 'string' && tier in BUILTIN_TIER_NET) return BUILTIN_TIER_NET[tier]
  return 'none'
}

/**
 * 批级裁决字符串归一：调用方（loop-policy 的 gate）经边只传裁决字符串，消费侧必须按同码理解——
 * 否则字符串被当「无裁决」而静默放行，门禁形同虚设。未知码 fail-closed 为 deny。
 */
function batchVerdictOf(value: string): string {
  if (value === 'allow' || value === 'approved') return 'allow'
  if (value === 'escalate' || value === 'pending' || value === 'needs_approval') return 'escalate'
  return 'deny'
}

/** 批级判定：有 verdicts 直接消费（跳过 guard），否则兜底批级一次调 guard.judge；取最严。 */
async function resolveBatchVerdict(
  bag: Rec,
  entries: CallEntry[],
  deps: DispatchDeps,
): Promise<string> {
  const judged = entries.filter((entry) => entry.entry !== null && entry.preError === null)
  if (judged.length === 0) return 'allow'

  const verdicts = bag['verdicts']
  if (typeof verdicts === 'string') return batchVerdictOf(verdicts)
  if (verdicts !== undefined && verdicts !== null) {
    // 形态不符的 verdicts 不静默当「无裁决」：fail-closed 为 deny，避免畸形输入放行越档调用。
    if (!Array.isArray(verdicts) && !isRecord(verdicts)) return 'deny'
    const list = normalizeVerdicts(verdicts)
    return strictest(judged.map((entry) => matchVerdict(list, entry)))
  }

  // 兜底判定也必须带上 net 判定输入（工具声明 net + 当前档 net 范围），否则 guard 的 net 越档检查
  // 因输入缺失恒判 allow——工具声明侧的 net 没带上，越档调用会被静默派发（门禁未生效）。
  const outcome = await deps.link.call('guard', 'judge', {
    calls: judged.map((entry) => ({
      port: entry.entry?.provider ?? '',
      tool: entry.tool,
      args: entry.args,
      net: declaredNetOf(entry),
    })),
    tier: bag['tier'] ?? null,
    tier_net: tierNetOf(bag['tier'], bag['sandbox_tiers']),
    workspace_root: bag['workspace_root'] ?? null,
    guard_rules: bag['guard_rules'] ?? null,
  })
  if (!outcome.ok) return 'deny'
  const decisions =
    isRecord(outcome.value) && Array.isArray(outcome.value['decisions'])
      ? (outcome.value['decisions'] as Json[])
      : []
  const verdictList = judged.map((_, index) => {
    const decision = decisions[index]
    const verdict =
      isRecord(decision) && typeof decision['verdict'] === 'string'
        ? (decision['verdict'] as string)
        : 'deny'
    return verdict
  })
  return strictest(verdictList)
}

interface VerdictItem {
  callId: string | null
  index: number | null
  verdict: string | null
}

function normalizeVerdicts(value: Json): VerdictItem[] {
  let items: Json[] = []
  if (Array.isArray(value)) items = value
  else if (isRecord(value) && Array.isArray(value['decisions']))
    items = value['decisions'] as Json[]
  else if (isRecord(value)) {
    const out: VerdictItem[] = []
    for (const [callId, verdict] of Object.entries(value)) {
      if (typeof verdict === 'string') out.push({ callId, index: null, verdict })
    }
    return out
  }
  const out: VerdictItem[] = []
  items.forEach((item, position) => {
    if (typeof item === 'string') {
      out.push({ callId: null, index: position, verdict: item })
      return
    }
    if (!isRecord(item)) return
    const callId = typeof item['call_id'] === 'string' ? (item['call_id'] as string) : null
    const rawIndex = item['index']
    const index =
      typeof rawIndex === 'number' && Number.isInteger(rawIndex)
        ? rawIndex
        : callId === null
          ? position
          : null
    const verdict = typeof item['verdict'] === 'string' ? (item['verdict'] as string) : null
    out.push({ callId, index, verdict })
  })
  return out
}

function matchVerdict(list: VerdictItem[], entry: CallEntry): string | null {
  const byId = list.find((item) => item.callId !== null && item.callId === entry.callId)
  if (byId !== undefined) return byId.verdict
  const byIndex = list.find((item) => item.callId === null && item.index === entry.index)
  if (byIndex !== undefined) return byIndex.verdict
  return null
}

/** 最严批级：任一 deny → deny；否则任一 escalate → escalate；否则 allow。 */
function strictest(verdicts: (string | null)[]): string {
  let result = 'allow'
  for (const verdict of verdicts) {
    if (verdict === 'deny') return 'deny'
    if (verdict === 'escalate') result = 'escalate'
  }
  return result
}

/** 单 call 执行：预错 / 批级 deny / escalate 不触提供者（零副作用）；allow 才扇出。 */
async function runEntry(
  entry: CallEntry,
  bag: Rec,
  batchVerdict: string,
  env: CallEnv,
  deps: DispatchDeps,
  cacheEnabled: boolean,
): Promise<CallResult> {
  if (entry.preError !== null) {
    return { call_id: entry.callId, ok: false, error: entry.preError }
  }
  if (batchVerdict === 'deny') {
    return {
      call_id: entry.callId,
      ok: false,
      error: { code: 'denied', message: 'denied by guard' },
    }
  }
  if (batchVerdict === 'escalate') {
    return {
      call_id: entry.callId,
      ok: false,
      error: { code: 'needs_approval', message: 'escalation required' },
    }
  }
  return executeCall(entry, bag, env, deps, cacheEnabled)
}

async function executeCall(
  entry: CallEntry,
  bag: Rec,
  env: CallEnv,
  deps: DispatchDeps,
  cacheEnabled: boolean,
): Promise<CallResult> {
  const tool = entry.entry as ToolEntry
  const idempotent = tool.decl['idempotent'] === true
  const cacheKey = canonicalJson({
    tool: tool.name,
    workspace_root: bag['workspace_root'] ?? null,
    args: entry.args,
  })

  deps.emit('tool.start', {
    run: env.run,
    thread: env.thread,
    call_id: entry.callId,
    tool: tool.name,
    render: tool.decl['render'] ?? null,
    args: entry.args,
  })

  const loader = (): Promise<Outcome> =>
    callProvider(tool, entry.args, bag, deps, env, entry.callId)
  const outcome =
    cacheEnabled && idempotent
      ? ((await deps.cache.run(cacheKey, loader)) as unknown as Outcome)
      : await loader()

  // 结果本体随 `tool.end` 一并下发：在途工具卡「完成即刻」渲染输出，不必等回合定稿快照
  //（否则 read / shell 这类不推 `tool.delta` 的工具在途展开为空，直到刷新才见结果）。
  deps.emit('tool.end', {
    run: env.run,
    thread: env.thread,
    call_id: entry.callId,
    ok: outcome.ok,
    result: outcome.result ?? null,
    error: outcome.error ?? null,
  })
  return { call_id: entry.callId, ...outcome } as CallResult
}

interface Outcome {
  ok: boolean
  result?: Json
  error?: Rec
}

async function callProvider(
  tool: ToolEntry,
  args: Rec,
  bag: Rec,
  deps: DispatchDeps,
  env: CallEnv,
  callId: string,
): Promise<Outcome> {
  if (tool.kind === 'binding' && (tool.method === null || tool.method.length === 0)) {
    return { ok: true, result: projectionRead(tool, bag) }
  }
  const passthrough = passthroughOf(bag)
  if (tool.kind === 'binding') {
    const call = await deps.link.call(tool.provider, tool.method as string, {
      ...passthrough,
      ...args,
      caps: tool.decl['caps'] ?? null,
    })
    return outcomeOf(call, 'binding')
  }
  // 调用身份随 bag 下传：提供者可据此在调用中途发 `tool.delta`（模型可见的 call_id + run / thread）。
  const timeoutMs = providerInvokeTimeout(tool)
  const call = await deps.link.call(
    TOOL_PROVIDER,
    'invoke',
    {
      ...passthrough,
      run: env.run,
      thread: env.thread,
      call_id: callId,
      tool: tool.name,
      args,
      caps: tool.decl['caps'] ?? null,
    },
    { ...(timeoutMs === undefined ? {} : { timeoutMs }), provider: tool.provider },
  )
  return outcomeOf(call, 'invoke')
}

/** 提供者调用等待上限：按工具声明 caps.timeout_ms 抬高（长命令须活过工具自己的执行预算），缺省用通道兜底。 */
function providerInvokeTimeout(tool: ToolEntry): number | undefined {
  const caps = tool.decl['caps']
  if (!isRecord(caps)) return undefined
  const declared = caps['timeout_ms']
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return undefined
  return declared + 10_000
}

/** 投影读：数据由调用方入口 term 读出后放 bag.projection_reads（键 = 绑定 read 或工具名）。 */
function projectionRead(tool: ToolEntry, bag: Rec): Json {
  const reads = isRecord(bag['projection_reads']) ? (bag['projection_reads'] as Rec) : {}
  const key = tool.read ?? tool.name
  return reads[key] ?? null
}

function passthroughOf(bag: Rec): Rec {
  const out: Rec = {}
  for (const [key, value] of Object.entries(bag)) {
    if (CONTROL_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 把提供者回值归一为 `{ok, result|error}`：
 * - describe/invoke 提供者按 `invoke` 契约回 `{ok:true, result}` / `{ok:false, error}`，故拆包取 `result`；
 * - 绑定项回的是能力类方法的原始值（计划值 / 结构化结果），整体作 `result`；
 * - `{ok:false, error}` 一律原样作错误（错误码不改写）；失败若**另带 `result`**（如 `tool-shell` 非零退出
 *   回带的 stdout / exit_code）必须一并透传，否则模型只见错误码、看不到具体报错。
 */
function outcomeOf(call: PortOutcome, kind: 'invoke' | 'binding'): Outcome {
  if (!call.ok) return { ok: false, error: { code: call.code, message: call.message } }
  const value = call.value
  if (isRecord(value) && value['ok'] === false) {
    const error = isRecord(value['error'])
      ? (value['error'] as Rec)
      : { code: 'tool_failed', message: 'tool failed' }
    const outcome: Outcome = {
      ok: false,
      error: {
        code: typeof error['code'] === 'string' ? (error['code'] as string) : 'tool_failed',
        message: typeof error['message'] === 'string' ? (error['message'] as string) : '',
      },
    }
    if (Object.hasOwn(value, 'result')) outcome.result = value['result']
    return outcome
  }
  if (kind === 'invoke' && isRecord(value) && value['ok'] === true) {
    return { ok: true, result: Object.hasOwn(value, 'result') ? value['result'] : value }
  }
  return { ok: true, result: value }
}

/** 有界并发池：结果按输入序回填；超上限的项排队而非丢弃。 */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  if (items.length === 0) return results
  const workerCount = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < workerCount; worker++) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= items.length) return
          results[index] = await fn(items[index], index)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}
