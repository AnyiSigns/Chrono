// 审批停靠带的浏览器侧纯模型：模板选择 / 摘要视图 / 影子指标 / 计时格式 / 二次确认状态机 / verdict 映射。
// 只做数据变换，不触 DOM、不触网络（便于 node --test 直调）。

export const KIND_TOOL_CALL = 'tool_call'
export const KIND_ORCHESTRATION_CHANGE = 'orchestration_change'
export const KIND_PLUGIN_WRITE = 'plugin_write'
export const KINDS = [KIND_TOOL_CALL, KIND_ORCHESTRATION_CHANGE, KIND_PLUGIN_WRITE]

export const VERDICT_ACCEPT = 'accept'
export const VERDICT_DENY = 'deny'

export const CONFIRM_APPROVE_ALL = 'approve_all'
export const CONFIRM_DENY_ALL = 'deny_all'
export const CONFIRM_TTL_MS = 3000

/** 等待计时 warning 阈值（>2min 转 warning 前景字）。 */
export const WAIT_WARNING_MS = 120000

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function intOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

// ── 模板选择 / 状态 ─────────────────────────────────────────────────────────

/** 按 `item.kind` 选模板；未知 / 缺省回落 `tool_call`。 */
export function selectTemplate(item) {
  const kind = isRecord(item) ? stringOf(item.kind) : null
  return kind !== null && KINDS.includes(kind) ? kind : KIND_TOOL_CALL
}

export function statusOf(item) {
  return isRecord(item) ? stringOf(item.status) : null
}

export function isExpired(item) {
  return statusOf(item) === 'expired'
}

/** 停靠带条目（`pending` 与 `expired` 都计入，裁决前不消失）。 */
export function isPending(item) {
  const status = statusOf(item)
  return status === 'pending' || status === 'expired'
}

/** 条目呈现档：`expired` 弱化（整条降 `--c-text-3` + 「已超时」标签）。 */
export function itemTone(item) {
  return isExpired(item) ? 'expired' : 'normal'
}

/** 默认展开：两类结构变更（编排变更 / 插件写）与 `severe` 档条目。 */
export function defaultExpanded(item) {
  const kind = selectTemplate(item)
  if (kind === KIND_ORCHESTRATION_CHANGE || kind === KIND_PLUGIN_WRITE) return true
  return isRecord(item) && item.tier === 'severe'
}

export function pendingCount(items) {
  return Array.isArray(items) ? items.filter(isPending).length : 0
}

// ── 计时格式（§16.10：`mm:ss`，>1h 用 `h:mm:ss`） ─────────────────────────────

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/** 毫秒 → `mm:ss`（>1h 用 `h:mm:ss`）；负数按 0。 */
export function formatWait(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`
}

/** 自 `item.at` 到 `now` 的等待毫秒；`at` 缺失 / 非法回 0。 */
export function elapsedMs(item, now) {
  const at = isRecord(item) ? stringOf(item.at) : null
  const atMs = at === null ? NaN : Date.parse(at)
  if (!Number.isFinite(atMs) || !Number.isFinite(now)) return 0
  return Math.max(0, now - atMs)
}

/** >2min 转 warning 前景字。 */
export function waitWarning(ms, threshold = WAIT_WARNING_MS) {
  return Number.isFinite(ms) && ms > threshold
}

// ── verdict 映射（写死：槽词汇 `accept`/`deny`，item 状态 `approved`/`denied`） ──

/** 按钮动作 → 槽 verdict；未知动作回 null。 */
export function verdictOf(action) {
  if (action === 'approve') return VERDICT_ACCEPT
  if (action === 'deny') return VERDICT_DENY
  return null
}

/** 槽 verdict → item 结果态。 */
export function verdictStatus(verdict) {
  if (verdict === VERDICT_ACCEPT) return 'approved'
  if (verdict === VERDICT_DENY) return 'denied'
  return null
}

/** item 状态 → 文案码。 */
export function statusLabelCode(status) {
  if (status === 'approved') return 'approval_status_approved'
  if (status === 'denied') return 'approval_status_denied'
  if (status === 'expired') return 'approval_status_expired'
  return 'approval_status_pending'
}

// ── 二次确认状态机（原地 3s，[全部批准] / [全部拒绝] 对称） ───────────────────

export function createConfirmState() {
  return { armed: null, at: 0 }
}

export function armConfirm(state, kind, now) {
  return { armed: kind, at: Number.isFinite(now) ? now : 0 }
}

/** 该按钮是否处于「已进入确认」且未超时（3s 内）。 */
export function confirmArmed(state, kind, now, ttl = CONFIRM_TTL_MS) {
  if (!isRecord(state) || state.armed !== kind) return false
  const at = typeof state.at === 'number' ? state.at : 0
  return now - at < ttl
}

export function clearConfirm() {
  return createConfirmState()
}

// ── 摘要视图 ───────────────────────────────────────────────────────────────

/** 工具名：`item.port`（实际提供者能力类名）。 */
export function toolNameOf(item) {
  return isRecord(item) ? stringOf(item.port) : null
}

/** 参数摘要：`item.args_ref.summary`，或 `sha256` 短前缀；缺省空串。 */
export function argsSummaryOf(item) {
  if (!isRecord(item) || !isRecord(item.args_ref)) return ''
  const ref = item.args_ref
  if (typeof ref.summary === 'string') return ref.summary
  if (typeof ref.sha256 === 'string') return ref.sha256.slice(0, 12)
  return ''
}

export function toolCallView(item) {
  return { tool: toolNameOf(item), args: argsSummaryOf(item), tier: isRecord(item) ? stringOf(item.tier) : null }
}

/** 影子指标定义：键 → 文案码 + 数值单位。 */
export const SHADOW_METRICS = [
  { key: 'token', code: 'approval_shadow_token', unit: 'count' },
  { key: 'steps', code: 'approval_shadow_steps', unit: 'steps' },
  { key: 'tool_failure', code: 'approval_shadow_tool_failure', unit: 'percent' },
  { key: 'approval_rate', code: 'approval_shadow_approval', unit: 'percent' },
]

/** `item.shadow` 是内联 body 或 `{def}` 引用；引用从 `refs` 闭包解析。 */
export function shadowBodyOf(item, refs) {
  if (!isRecord(item) || !isRecord(item.shadow)) return null
  const shadow = item.shadow
  const def = stringOf(shadow.def)
  if (def === null) return shadow
  if (!isRecord(refs)) return null
  const body = refs[def]
  return isRecord(body) ? body : null
}

/** 指标计数格式：≥1M 用 `M`，≥1000 用 `k`（1 位小数、去尾 `.0`）。 */
export function formatCount(value) {
  if (!Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1e6) return `${trimZero(value / 1e6)}M`
  if (Math.abs(value) >= 1000) return `${trimZero(value / 1000)}k`
  return String(value)
}

function trimZero(value) {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

export function formatMetric(value, unit) {
  if (!Number.isFinite(value)) return ''
  if (unit === 'percent') return `${trimZero(value * 100)}%`
  if (unit === 'steps') return trimZero(value)
  return formatCount(value)
}

/** 指标增减语气：降 = 改善（success）、升 = 恶化（warning）、不变 = muted。 */
export function metricTone(from, to) {
  if (to === from) return 'muted'
  return to < from ? 'success' : 'warning'
}

/** 增减百分比文本（相对 from）；from 为 0 回空串。 */
export function deltaText(from, to) {
  if (!Number.isFinite(from) || from === 0) return ''
  const pct = Math.round(((to - from) / from) * 100)
  if (pct === 0) return '±0%'
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

function metricPair(value) {
  if (!isRecord(value)) return null
  const from = typeof value.from === 'number' && Number.isFinite(value.from) ? value.from : null
  const to = typeof value.to === 'number' && Number.isFinite(value.to) ? value.to : null
  return from === null || to === null ? null : { from, to }
}

/** 影子指标对照行（只呈现、不否决；缺失指标跳过）。 */
export function shadowRows(shadowBody) {
  const metrics = isRecord(shadowBody) && isRecord(shadowBody.metrics) ? shadowBody.metrics : {}
  const rows = []
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
export function shadowRounds(shadowBody) {
  if (!isRecord(shadowBody)) return null
  const rounds = shadowBody.rounds
  return typeof rounds === 'number' && Number.isFinite(rounds) ? rounds : null
}

/** 图 diff 计数（±N 节点 / ±M 边）；无 diff 回 null。 */
export function diffCounts(shadowBody) {
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

export function orchestrationView(item, refs) {
  const shadow = shadowBodyOf(item, refs)
  return {
    title: argsSummaryOf(item),
    rounds: shadowRounds(shadow),
    rows: shadowRows(shadow),
    diff: diffCounts(shadow),
  }
}

/** 插件写入视图：插件身份 + 变更文件清单 + validate 结果 + 隔离风险。 */
export function pluginWriteView(item) {
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

/** 条目视图（模板选择 + 摘要）：入口按 `view.kind` 走对应渲染分支。 */
export function viewOf(item, refs) {
  const kind = selectTemplate(item)
  if (kind === KIND_ORCHESTRATION_CHANGE) return { kind, ...orchestrationView(item, refs) }
  if (kind === KIND_PLUGIN_WRITE) return { kind, ...pluginWriteView(item) }
  return { kind, ...toolCallView(item) }
}
