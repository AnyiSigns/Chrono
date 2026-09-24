// 文案取用：错误码人话来自壳的 `/assets/messages.v1.json`（唯一来源），未登记码走 `unknown` 兜底。
// 审批停靠带的界面文案（计数 / 按钮 / 状态 / 计时）共享表尚未登记，这里以 `UI_TEXT` 作本地兜底；
// 共享表一旦登记同名码即自动优先——避免在本插件硬编码错误人话。
// 纯模块：不触 DOM、不 import react（便于 node --test 直调）。

export interface MessageEntry {
  title: string
  body: string
  action?: string
}

export type MessageTable = Record<string, MessageEntry>

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES: MessageTable = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。', action: '重试' },
}

/** 本插件界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: Record<string, string> = {
  approval_dock_label: '审批停靠带',
  approval_waiting: '待审批 {count}',
  approval_waited: '已等待 {time}',
  approval_expired_label: '已超时',
  approval_all_approve: '全部批准',
  approval_all_deny: '全部拒绝',
  approval_confirm_approve: '确认批准 {count} 项？',
  approval_confirm_deny: '确认拒绝并终止本回合？',
  approval_approve: '批准',
  approval_deny: '拒绝',
  approval_deny_hint: '拒绝并终止本回合',
  approval_all_deny_hint: '全部拒绝 = 放弃本回合',
  approval_submitting: '提交中…',
  approval_failed: '裁决提交失败。重试可再试一次。',
  approval_load_failed: '读取待审批队列失败。重试可再试一次。',
  approval_offline: '宿主不可达，审批暂不可用。重试可恢复。',
  approval_loading_more: '仍在读取…',
  approval_retry: '重试',
  approval_orchestration_change: '编排变更',
  approval_plugin_write: '插件写入',
  approval_tool_call: '工具调用',
  approval_validate_ok: 'validate ✓',
  approval_validate_failed: 'validate ✗',
  approval_isolation_risk: '失败将隔离该插件分支，需回滚上一世代',
  approval_shadow_title: '影子回放',
  approval_shadow_rounds: '历史 {count} 回合，零模型调用',
  approval_shadow_token: 'token',
  approval_shadow_steps: '步数',
  approval_shadow_tool_failure: '工具失败',
  approval_shadow_approval: '审批触发',
  approval_graph_diff: '图 diff',
  approval_expand: '展开',
  approval_collapse: '收起',
  approval_empty: '暂无待审批项',
  approval_queue_full: '审批队列已满。先处理现有条目。',
  approval_dependency_missing: '依赖未就绪',
  approval_dependency_missing_hint: '审批服务尚未就绪，停靠带暂不可用。',
  approval_loading: '读取中…',
  approval_status_approved: '已批准',
  approval_status_denied: '已拒绝',
  approval_status_expired: '已超时',
  approval_status_pending: '待审批',
  approval_files_count: '{count} 个文件',
  approval_args_summary: '参数摘要',
  approval_no_args: '无参数摘要',
  approval_nodes_edges: '{nodes} 节点 / {edges} 边',
}

const LOCALE_KEY = 'locale'
export const UNKNOWN_CODE = 'unknown'

/** 解析文案表文本；形态非法返回 null（调用方保留内置最小表）。 */
export function parseMessages(text: string): MessageTable | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const table: MessageTable = {}
  for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (code === LOCALE_KEY) continue
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.title !== 'string' || typeof raw.body !== 'string') continue
    const entry: MessageEntry = { title: raw.title, body: raw.body }
    if (typeof raw.action === 'string' && raw.action.length > 0) entry.action = raw.action
    table[code] = entry
  }
  return Object.keys(table).length > 0 ? table : null
}

/** 按码取文案：共享表 → 本地界面文案 → `unknown` 兜底（不空白、不报错）。 */
export function lookupMessage(table: unknown, code: string): MessageEntry {
  const source = (typeof table === 'object' && table !== null ? table : FALLBACK_MESSAGES) as MessageTable
  const entry = source[code]
  if (entry !== undefined) return entry
  if (typeof UI_TEXT[code] === 'string') return { title: '', body: UI_TEXT[code] }
  const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

/** 取文案正文（错误码人话 / 界面文案统一入口）。 */
export function messageText(table: unknown, code: string): string {
  return lookupMessage(table, code).body
}

/** 取带占位符的界面文案模板并代入变量（`{name}` 形式）。 */
export function formatText(table: unknown, code: string, vars: Record<string, unknown>): string {
  const template = lookupMessage(table, code).body
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars !== null && vars !== undefined && Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key])
      : match,
  )
}

/** 拉取共享文案表；失败保留内置最小表。 */
export async function loadMessages(fetchImpl: typeof fetch, url: string): Promise<MessageTable> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return FALLBACK_MESSAGES
    const parsed = parseMessages(await response.text())
    return parsed ?? FALLBACK_MESSAGES
  } catch {
    return FALLBACK_MESSAGES
  }
}
