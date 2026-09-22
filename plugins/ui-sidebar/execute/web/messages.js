// 文案取用：错误码人话的单一来源 = 壳的 `/assets/messages.v1.json`（按码取用）；
// 侧栏界面标签 / 按钮 / 空态 / tooltip 文案集中在本文件（唯一允许出现中文的 web 模块）。
// 共享表拉取失败或键暂缺时用下面的最小兜底，保证骨架文案不空白。

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。', action: '重试' },
}

/** 侧栏界面文案（共享表未登记时的本地兜底；界面标签集中于此，勿散落到其它 web 模块）。 */
export const UI_TEXT = {
  sidebar_add_workspace: '添加工作目录',
  sidebar_new_conversation: '在此工作区新建对话',
  sidebar_settings: '设置',
  sidebar_expand: '展开',
  sidebar_collapse: '收缩',
  sidebar_search_placeholder: '搜索会话',
  sidebar_no_match: '无匹配',
  sidebar_empty_title: '还没有会话',
  sidebar_empty_hint: '添加工作目录后即可开始。',
  sidebar_open_in_explorer: '在文件管理器中打开',
  sidebar_remove_workspace: '移除工作区',
  sidebar_rename: '重命名',
  sidebar_export: '导出',
  sidebar_export_md: '导出 markdown',
  sidebar_export_json: '导出 JSON',
  sidebar_branch: '分支',
  sidebar_delete: '删除',
  sidebar_confirm_delete: '确认删除？',
  sidebar_confirm: '确认',
  sidebar_cancel: '取消',
  sidebar_undo: '撤销',
  sidebar_deleted: '已删除',
  sidebar_exported: '已导出',
  sidebar_export_failed: '导出失败',
  sidebar_exporting: '导出中…',
  sidebar_waiting_picker: '等待选择…',
  sidebar_picker_unavailable: '系统选择器不可用',
  sidebar_picker_unavailable_hint: '可用 CLI 或启动参数指定目录。',
  sidebar_directory_missing: '目录不存在',
  sidebar_terminate: '终止',
  sidebar_confirm_terminate: '确认终止？',
  sidebar_running: '运行中',
  sidebar_pending: '待审批',
  sidebar_failed: '失败',
  sidebar_unread: '未读',
  sidebar_dependency_missing: '依赖未就绪',
  sidebar_retry: '重试',
  sidebar_loading_more: '仍在读取…',
  sidebar_product: 'Chrono',
  sidebar_unread_count: '未读 {count}',
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

/** 取文案正文。 */
export function messageText(table, code) {
  return lookupMessage(table, code).body
}

/** 取带占位符的界面文案模板并代入变量（`{name}` 形式）。 */
export function formatText(table, code, vars) {
  return messageText(table, code).replace(/\{(\w+)\}/g, (match, key) =>
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
