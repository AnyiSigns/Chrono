// 文案取用：错误码人话来自壳的 `/assets/messages.v1.json`（唯一来源），未登记码走 `unknown` 兜底。
// 线程顶栏的界面文案当前共享表未登记，这里以 `UI_TEXT` 作单一来源（按码取用，便于日后迁入共享表）。

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。', action: '重试' },
}

/** 本插件界面文案（单一来源；按码取用）。 */
export const UI_TEXT = {
  threads_region: '线程顶栏',
  thread_label_main: '对话',
  thread_label_subagent: '子代理',
  thread_label_group: '群聊',
  thread_label_workflow: '工作流',
  threads_todo: '待办 {count}',
  threads_todo_heading: '待办清单',
  threads_todo_pending: '未完成',
  threads_todo_in_progress: '进行中',
  threads_todo_completed: '已完成',
  threads_unread: '未读 {count}',
  threads_loading: '读取中…',
  threads_retry: '重试',
  threads_status_running: '运行中',
  threads_status_pending: '待审批',
  threads_status_done: '完成',
  threads_status_failed: '失败',
}

const LOCALE_KEY = 'locale'
export const UNKNOWN_CODE = 'unknown'

/** 解析文案表文本；形态非法返回 null（调用方保留内置最小表）。 */
export function parseMessages(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const table = {}
  for (const [code, value] of Object.entries(parsed)) {
    if (code === LOCALE_KEY) continue
    if (typeof value !== 'object' || value === null) continue
    if (typeof value.title !== 'string' || typeof value.body !== 'string') continue
    const entry = { title: value.title, body: value.body }
    if (typeof value.action === 'string' && value.action.length > 0) entry.action = value.action
    table[code] = entry
  }
  return Object.keys(table).length > 0 ? table : null
}

/** 按码取文案：共享表 → 本地界面文案 → `unknown` 兜底（不空白、不报错）。 */
export function lookupMessage(table, code) {
  const source = typeof table === 'object' && table !== null ? table : FALLBACK_MESSAGES
  const entry = source[code]
  if (entry !== undefined) return entry
  if (typeof UI_TEXT[code] === 'string') return { title: '', body: UI_TEXT[code] }
  const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

/** 取文案正文（错误码人话 / 界面文案统一入口）。 */
export function messageText(table, code) {
  return lookupMessage(table, code).body
}

/** 取带占位符的界面文案模板并代入变量（`{name}` 形式）。 */
export function formatText(code, vars) {
  const template = typeof UI_TEXT[code] === 'string' ? UI_TEXT[code] : ''
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    vars !== null && vars !== undefined && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  )
}

/** 拉取共享文案表；失败保留内置最小表。 */
export async function loadMessages(fetchImpl, url) {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return FALLBACK_MESSAGES
    const parsed = parseMessages(await response.text())
    return parsed ?? FALLBACK_MESSAGES
  } catch {
    return FALLBACK_MESSAGES
  }
}
