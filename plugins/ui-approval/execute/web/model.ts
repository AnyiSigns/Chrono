// 审批停靠带的浏览器侧纯模型：模板选择 / 摘要视图 / 影子指标 / 计时格式 / 二次确认状态机 / verdict 映射。
// 只做数据变换，不触 DOM、不触网络、不 import react（便于 node --test 直调）。

export const KIND_TOOL_CALL = 'tool_call' as const
export const KIND_ORCHESTRATION_CHANGE = 'orchestration_change' as const
export const KIND_PLUGIN_WRITE = 'plugin_write' as const
export const KINDS: readonly string[] = [KIND_TOOL_CALL, KIND_ORCHESTRATION_CHANGE, KIND_PLUGIN_WRITE]

export const VERDICT_ACCEPT = 'accept' as const
export const VERDICT_DENY = 'deny' as const

export const CONFIRM_APPROVE_ALL = 'approve_all' as const
export const CONFIRM_DENY_ALL = 'deny_all' as const
export const CONFIRM_TTL_MS = 3000

/** 等待计时 warning 阈值（>2min 转 warning 前景字）。 */
export const WAIT_WARNING_MS = 120000

/** 宽松记录（视图模型吃未知 Json，取值处逐一收窄）。 */
export type Rec = { [key: string]: any }

/** 文案取用函数（组件把 `messageText` / `formatText` 包成同形）。 */
export type Translator = (code: string, vars?: Record<string, unknown>) => string

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留有稳定身份的条目：`id` 必须是非空字符串，且按 `id` 去重。
 * 无 id 的条目无法裁决、无法作 React key；用空串当身份会让多条共享展开 / 忙碌 / 错误态并撞 key。 */
export function identifiedItems(items: unknown): Rec[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const result: Rec[] = []
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
export function identityBody(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'body') ? value.body : value
}

/** 身份视图 → active（64hex 或 null）；非身份视图 / 形状不符回 undefined（不注入 expect_active）。 */
export function identityActive(value: unknown): string | null | undefined {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'active')) return undefined
  const active = value.active
  return typeof active === 'string' || active === null ? active : undefined
}

/** 身份视图 → data_gen（`{seq,payload}` 或 null）；非身份视图 / 形状不符回 undefined。 */
export function identityDataGen(value: unknown): unknown {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'data_gen')) return undefined
  return value.data_gen
}

/** 身份数据侧特征键：出现任一即视为数据 body，不判为代码世代回落。 */
const DATA_SIDE_KEYS = ['version', 'params', 'permission', 'ui', 'providers', 'slots']

/** 代码世代回落 body 判据：拿到的是 active（commit）def body，非身份数据，拒写。
 * commit def body 形如 `{ tree, meta }`；只判顶层含 `tree` 会误伤顶层恰好含 `tree` 的合法数据，
 * 故要求 `tree` 为字符串且不含任一数据侧特征键。 */
export function isCodeGenFallbackBody(body: unknown): boolean {
  if (!isRecord(body) || typeof body.tree !== 'string') return false
  for (const key of DATA_SIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return false
  }
  return true
}

/** 忙碌键集合：加入 / 移除（每项独立，互不清除）。 */
export function withBusy(busy: string[], key: string): string[] {
  return busy.includes(key) ? busy : [...busy, key]
}

export function withoutBusy(busy: string[], key: string): string[] {
  return busy.includes(key) ? busy.filter((item) => item !== key) : busy
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function intOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

// ── 模板选择 / 状态 ─────────────────────────────────────────────────────────

/** 按 `item.kind` 选模板；未知 / 缺省回落 `tool_call`。 */
export function selectTemplate(item: unknown): string {
  const kind = isRecord(item) ? stringOf(item.kind) : null
  return kind !== null && KINDS.includes(kind) ? kind : KIND_TOOL_CALL
}

export function statusOf(item: unknown): string | null {
  return isRecord(item) ? stringOf(item.status) : null
}

export function isExpired(item: unknown): boolean {
  return statusOf(item) === 'expired'
}

/** 停靠带条目（`pending` 与 `expired` 都计入，裁决前不消失）。 */
export function isPending(item: unknown): boolean {
  const status = statusOf(item)
  return status === 'pending' || status === 'expired'
}

/** 条目呈现档：`expired` 弱化（整条降 `--c-text-3` + 「已超时」标签）。 */
export function itemTone(item: unknown): string {
  return isExpired(item) ? 'expired' : 'normal'
}

/** 默认展开：两类结构变更（编排变更 / 插件写）与 `severe` 档条目。 */
export function defaultExpanded(item: unknown): boolean {
  const kind = selectTemplate(item)
  if (kind === KIND_ORCHESTRATION_CHANGE || kind === KIND_PLUGIN_WRITE) return true
  return isRecord(item) && item.tier === 'severe'
}

export function pendingCount(items: unknown): number {
  return Array.isArray(items) ? items.filter(isPending).length : 0
}

/** 最老待审批项的 `at` 毫秒；无有效项回 null。 */
export function oldestPending(items: unknown): number | null {
  if (!Array.isArray(items)) return null
  let oldest: number | null = null
  for (const item of items) {
    if (!isPending(item)) continue
    const at = isRecord(item) ? stringOf(item.at) : null
    const atMs = at === null ? NaN : Date.parse(at)
    if (!Number.isFinite(atMs)) continue
    if (oldest === null || atMs < oldest) oldest = atMs
  }
  return oldest
}

// ── 计时格式（§16.10：`mm:ss`，>1h 用 `h:mm:ss`） ─────────────────────────────

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 毫秒 → `mm:ss`（>1h 用 `h:mm:ss`）；负数按 0。 */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`
}

/** 自 `item.at` 到 `now` 的等待毫秒；`at` 缺失 / 非法回 0。 */
export function elapsedMs(item: unknown, now: number): number {
  const at = isRecord(item) ? stringOf(item.at) : null
  const atMs = at === null ? NaN : Date.parse(at)
  if (!Number.isFinite(atMs) || !Number.isFinite(now)) return 0
  return Math.max(0, now - atMs)
}

/** >2min 转 warning 前景字。 */
export function waitWarning(ms: number, threshold = WAIT_WARNING_MS): boolean {
  return Number.isFinite(ms) && ms > threshold
}

// ── 停靠带整体状态（显式区分 loading / offline / failed / empty / ready） ─────

/** >8s 仍在读取的追加提示阈值（与 ui-chat / ui-settings 同档）。 */
export const LOADING_NOTE_MS = 8000

export type ApprovalStatus = 'loading' | 'offline' | 'failed' | 'empty' | 'ready'

/** 插件不可达 / 传输中断的错误码：归入 offline（可重试），不当作显式业务失败。 */
export function isUnreachableCode(code: unknown): boolean {
  return code === 'ui_unreachable' || code === 'transport_failed'
}

export interface ApprovalStatusInput {
  loading: boolean
  error: { code: string; kind: string } | null
  connected: boolean
  itemCount: number
}

/** 停靠带状态：有可裁决项恒为 ready（错误在列表内就地显示）；无项时按连接 / 在途 / 错误区分。
 * 连接断开优先于在途：插件不可达时不显示「读取中…」，避免与慢读混淆。 */
export function approvalStatus(input: ApprovalStatusInput): ApprovalStatus {
  if (input.itemCount > 0) return 'ready'
  if (!input.connected) return 'offline'
  if (input.loading) return 'loading'
  if (input.error !== null) return isUnreachableCode(input.error.code) ? 'offline' : 'failed'
  return 'empty'
}

/** 各状态的标题文案码：组件据此渲染，测试据此证明各态互不混淆；ready / empty 无标题。 */
export function approvalStatusTextCode(status: ApprovalStatus): string | null {
  if (status === 'loading') return 'approval_loading'
  if (status === 'offline') return 'approval_offline'
  if (status === 'failed') return 'approval_load_failed'
  return null
}

// ── verdict 映射（写死：槽词汇 `accept`/`deny`，item 状态 `approved`/`denied`） ──

/** 按钮动作 → 槽 verdict；未知动作回 null。 */
export function verdictOf(action: unknown): string | null {
  if (action === 'approve') return VERDICT_ACCEPT
  if (action === 'deny') return VERDICT_DENY
  return null
}

/** 槽 verdict → item 结果态。 */
export function verdictStatus(verdict: unknown): string | null {
  if (verdict === VERDICT_ACCEPT) return 'approved'
  if (verdict === VERDICT_DENY) return 'denied'
  return null
}

/** item 状态 → 文案码。 */
export function statusLabelCode(status: unknown): string {
  if (status === 'approved') return 'approval_status_approved'
  if (status === 'denied') return 'approval_status_denied'
  if (status === 'expired') return 'approval_status_expired'
  return 'approval_status_pending'
}

// ── 二次确认状态机（原地 3s，[全部批准] / [全部拒绝] 对称） ───────────────────

export interface ConfirmState {
  armed: string | null
  at: number
}

export function createConfirmState(): ConfirmState {
  return { armed: null, at: 0 }
}

export function armConfirm(state: unknown, kind: string, now: number): ConfirmState {
  return { armed: kind, at: Number.isFinite(now) ? now : 0 }
}

/** 该按钮是否处于「已进入确认」且未超时（3s 内）。 */
export function confirmArmed(state: unknown, kind: string, now: number, ttl = CONFIRM_TTL_MS): boolean {
  if (!isRecord(state) || state.armed !== kind) return false
  const at = typeof state.at === 'number' ? state.at : 0
  return now - at < ttl
}

export function clearConfirm(): ConfirmState {
  return createConfirmState()
}

// ── 摘要视图 ───────────────────────────────────────────────────────────────

/** 工具名：`item.port`（实际提供者能力类名）。 */
export function toolNameOf(item: unknown): string | null {
  return isRecord(item) ? stringOf(item.port) : null
}

/** 参数摘要：`item.args_ref.summary`，或 `sha256` 短前缀；缺省空串。 */
export function argsSummaryOf(item: unknown): string {
  if (!isRecord(item) || !isRecord(item.args_ref)) return ''
  const ref = item.args_ref
  if (typeof ref.summary === 'string') return ref.summary
  if (typeof ref.sha256 === 'string') return ref.sha256.slice(0, 12)
  return ''
}

export interface ToolCallView {
  tool: string | null
  args: string
  tier: string | null
}

export function toolCallView(item: unknown): ToolCallView {
  return { tool: toolNameOf(item), args: argsSummaryOf(item), tier: isRecord(item) ? stringOf(item.tier) : null }
}

/** 影子指标定义：键 → 文案码 + 数值单位。 */
export const SHADOW_METRICS: readonly { key: string; code: string; unit: string }[] = [
  { key: 'token', code: 'approval_shadow_token', unit: 'count' },
  { key: 'steps', code: 'approval_shadow_steps', unit: 'steps' },
  { key: 'tool_failure', code: 'approval_shadow_tool_failure', unit: 'percent' },
  { key: 'approval_rate', code: 'approval_shadow_approval', unit: 'percent' },
]

/** `item.shadow` 是内联 body 或 `{def}` 引用；引用从 `refs` 闭包解析。 */
export function shadowBodyOf(item: unknown, refs: unknown): Rec | null {
  if (!isRecord(item) || !isRecord(item.shadow)) return null
  const shadow = item.shadow
  const def = stringOf(shadow.def)
  if (def === null) return shadow
  if (!isRecord(refs)) return null
  const body = refs[def]
  return isRecord(body) ? body : null
}

/** 指标计数格式：≥1M 用 `M`，≥1000 用 `k`（1 位小数、去尾 `.0`）。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1e6) return `${trimZero(value / 1e6)}M`
  if (Math.abs(value) >= 1000) return `${trimZero(value / 1000)}k`
  return String(value)
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

export function formatMetric(value: number, unit: string): string {
  if (!Number.isFinite(value)) return ''
  if (unit === 'percent') return `${trimZero(value * 100)}%`
  if (unit === 'steps') return trimZero(value)
  return formatCount(value)
}

/** 指标增减语气：降 = 改善（success）、升 = 恶化（warning）、不变 = muted。 */
export function metricTone(from: number, to: number): string {
  if (to === from) return 'muted'
  return to < from ? 'success' : 'warning'
}

/** 增减百分比文本（相对 from）；from 为 0 回空串。 */
export function deltaText(from: number, to: number): string {
  if (!Number.isFinite(from) || from === 0) return ''
  const pct = Math.round(((to - from) / from) * 100)
  if (pct === 0) return '±0%'
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

interface MetricPair {
  from: number
  to: number
}

function metricPair(value: unknown): MetricPair | null {
  if (!isRecord(value)) return null
  const from = typeof value.from === 'number' && Number.isFinite(value.from) ? value.from : null
  const to = typeof value.to === 'number' && Number.isFinite(value.to) ? value.to : null
  return from === null || to === null ? null : { from, to }
}

export interface ShadowRow {
  key: string
  code: string
  fromText: string
  toText: string
  delta: string
  tone: string
}

/** 影子指标对照行（只呈现、不否决；缺失指标跳过）。 */
export function shadowRows(shadowBody: unknown): ShadowRow[] {
  const metrics = isRecord(shadowBody) && isRecord(shadowBody.metrics) ? shadowBody.metrics : {}
  const rows: ShadowRow[] = []
  for (const spec of SHADOW_METRICS) {
    const pair = metricPair(metrics[spec.key])
    if (pair === null) continue
    rows.push({
      key: spec.key,
      code: spec.code,
      fromText: formatMetric(pair.from, spec.unit),
      toText: formatMetric(pair.to, spec.unit),
      delta: deltaText(pair.from, pair.to),
      tone: metricTone(pair.from, pair.to),
    })
  }
  return rows
}

/** 影子回放历史回合数；缺失回 null。 */
export function shadowRounds(shadowBody: unknown): number | null {
  if (!isRecord(shadowBody)) return null
  const rounds = shadowBody.rounds
  return typeof rounds === 'number' && Number.isFinite(rounds) ? rounds : null
}

export interface DiffCounts {
  nodesAdded: number
  nodesRemoved: number
  edgesAdded: number
  edgesRemoved: number
  items: Rec[]
}

/** 图 diff 计数（±N 节点 / ±M 边）；无 diff 回 null。 */
export function diffCounts(shadowBody: unknown): DiffCounts | null {
  if (!isRecord(shadowBody) || !isRecord(shadowBody.diff)) return null
  const diff = shadowBody.diff
  return {
    nodesAdded: intOf(diff.nodes_added),
    nodesRemoved: intOf(diff.nodes_removed),
    edgesAdded: intOf(diff.edges_added),
    edgesRemoved: intOf(diff.edges_removed),
    items: Array.isArray(diff.items) ? diff.items.filter(isRecord) : [],
  }
}

export interface OrchestrationView {
  title: string
  rounds: number | null
  rows: ShadowRow[]
  diff: DiffCounts | null
}

export function orchestrationView(item: unknown, refs: unknown): OrchestrationView {
  const shadow = shadowBodyOf(item, refs)
  return {
    title: argsSummaryOf(item),
    rounds: shadowRounds(shadow),
    rows: shadowRows(shadow),
    diff: diffCounts(shadow),
  }
}

export interface PluginWriteView {
  plugin: string | null
  files: Rec[]
  count: number | null
  validate: boolean | null
  isolationRisk: boolean
}

/** 插件写入视图：插件身份 + 变更文件清单 + validate 结果 + 隔离风险。 */
export function pluginWriteView(item: unknown): PluginWriteView {
  if (!isRecord(item)) return { plugin: null, files: [], count: null, validate: null, isolationRisk: true }
  const files = Array.isArray(item.files) ? item.files.filter(isRecord) : []
  const count =
    files.length > 0
      ? files.length
      : typeof item.file_count === 'number' && Number.isFinite(item.file_count)
        ? Math.trunc(item.file_count)
        : null
  const validate =
    isRecord(item.validate) && typeof item.validate.ok === 'boolean'
      ? item.validate.ok
      : typeof item.validate === 'boolean'
        ? item.validate
        : null
  return { plugin: stringOf(item.plugin) ?? toolNameOf(item), files, count, validate, isolationRisk: true }
}

export interface ToolCallFullView extends ToolCallView {
  kind: typeof KIND_TOOL_CALL
}

export interface OrchestrationFullView extends OrchestrationView {
  kind: typeof KIND_ORCHESTRATION_CHANGE
}

export interface PluginWriteFullView extends PluginWriteView {
  kind: typeof KIND_PLUGIN_WRITE
}

export type View = ToolCallFullView | OrchestrationFullView | PluginWriteFullView

/** 条目视图（模板选择 + 摘要）：入口按 `view.kind` 走对应渲染分支。 */
export function viewOf(item: unknown, refs: unknown): View {
  const kind = selectTemplate(item)
  if (kind === KIND_ORCHESTRATION_CHANGE) return { kind: KIND_ORCHESTRATION_CHANGE, ...orchestrationView(item, refs) }
  if (kind === KIND_PLUGIN_WRITE) return { kind: KIND_PLUGIN_WRITE, ...pluginWriteView(item) }
  return { kind: KIND_TOOL_CALL, ...toolCallView(item) }
}

/** 带符号计数（`+N` / `-N`）。 */
export function signedOf(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`
}

/** 图 diff 文案变量：`{nodes, edges}`；无 diff 回 null。 */
export function diffLabelVars(diff: DiffCounts | null): { nodes: string; edges: string } | null {
  if (diff === null) return null
  return {
    nodes: signedOf(diff.nodesAdded) + signedOf(diff.nodesRemoved),
    edges: signedOf(diff.edgesAdded) + signedOf(diff.edgesRemoved),
  }
}

// ── 条目文案组装（组件只渲染，不就地拼串） ───────────────────────────────────

/** 条目主标签：编排变更 / 插件写入 / 工具名（缺失回工具调用）。 */
export function summaryLead(view: View, t: Translator): string {
  if (view.kind === KIND_ORCHESTRATION_CHANGE) return t('approval_orchestration_change')
  if (view.kind === KIND_PLUGIN_WRITE) return t('approval_plugin_write')
  return view.tool !== null ? view.tool : t('approval_tool_call')
}

/** 条目摘要行：编排取标题 / 图 diff，插件写取插件 + 文件数 + validate，其余取参数摘要。 */
export function summaryText(view: View, t: Translator): string {
  if (view.kind === KIND_ORCHESTRATION_CHANGE) return view.title || diffLabel(view.diff, t)
  if (view.kind === KIND_PLUGIN_WRITE) return pluginWriteSummary(view, t)
  return view.args || t('approval_no_args')
}

/** 图 diff 一行文案（`{nodes} 节点 / {edges} 边`）；无 diff 回空串。 */
export function diffLabel(diff: DiffCounts | null, t: Translator): string {
  const vars = diffLabelVars(diff)
  return vars === null ? '' : t('approval_nodes_edges', vars)
}

/** 图 diff 整行（标题 + 计数）；无 diff 回空串。 */
export function graphDiffText(diff: DiffCounts | null, t: Translator): string {
  const label = diffLabel(diff, t)
  return label.length === 0 ? '' : `${t('approval_graph_diff')}：${label}`
}

/** 插件写入文件一行：`path`，缺失兜底 JSON。 */
export function fileText(file: unknown): string {
  if (isRecord(file) && typeof file.path === 'string') return file.path
  return JSON.stringify(file)
}

/** 插件写入摘要：插件名 + 文件数 + validate 结果，`·` 分隔。 */
export function pluginWriteSummary(view: PluginWriteView, t: Translator): string {
  const parts: string[] = []
  if (view.plugin !== null) parts.push(view.plugin)
  if (view.count !== null) parts.push(t('approval_files_count', { count: view.count }))
  if (view.validate === true) parts.push(t('approval_validate_ok'))
  if (view.validate === false) parts.push(t('approval_validate_failed'))
  return parts.join(' · ')
}

/** diff 条目一行文本：优先 `summary`，其次 `op path`，兜底 JSON。 */
export function diffItemText(entry: unknown): string {
  if (isRecord(entry)) {
    if (typeof entry.summary === 'string') return entry.summary
    if (typeof entry.op === 'string' && typeof entry.path === 'string') return `${entry.op} ${entry.path}`
  }
  return JSON.stringify(entry)
}

/** diff 条目稳定 key：`op path` 前缀 + 位置序号（同形条目也能区分）。 */
export function diffItemKey(entry: unknown, index: number): string {
  const op = isRecord(entry) && typeof entry.op === 'string' ? entry.op : ''
  const path = isRecord(entry) && typeof entry.path === 'string' ? entry.path : ''
  const stable = op.length > 0 || path.length > 0 ? `${op} ${path}` : 'item'
  return `${stable}#${index}`
}

/** 插件写入文件稳定 key：`path` 前缀 + 位置序号（同名路径也能区分）。 */
export function fileKey(file: unknown, index: number): string {
  const path = isRecord(file) && typeof file.path === 'string' ? file.path : ''
  return `${path.length > 0 ? path : 'file'}#${index}`
}

/** 条目呈现：一次算好视图与两行文案，组件直接渲染。 */
export function itemPresentation(
  item: unknown,
  refs: unknown,
  t: Translator,
): { view: View; lead: string; summary: string } {
  const view = viewOf(item, refs)
  return { view, lead: summaryLead(view, t), summary: summaryText(view, t) }
}
