// 文案取用：文案单一来源 = 壳的 `/assets/messages.v1.json`，按码取用、禁硬编码人话。
// 本插件的界面标签 / 按钮 / 空态 / 错误文案一律登记进共享表（`ui-shell/execute/web/messages.v1.json`）。
// 下面的 `UI_TEXT` 只是**最小兜底**：共享表拉取失败或键暂缺时保证骨架文案不空白；新增文案一律进共享表。

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES: any = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。', action: '重试' },
}

/** 共享表不可用 / 未登记时的最小骨架兜底（不承载业务文案；新增文案进共享表，勿加键）。 */
export const UI_TEXT: any = {
  settings_title: '设置',
  settings_close: '关闭设置',
  settings_retry: '重试',
  settings_empty: '暂无内容',
  settings_loading_more: '仍在读取…',
  settings_dependency_missing: '依赖未就绪',
  settings_dependency_missing_hint: '所需身份尚未就绪，相关视图暂不可用。',
  settings_saved: '已保存',
}

const LOCALE_KEY = 'locale'
export const UNKNOWN_CODE = 'unknown'

/** 解析文案表文本；形态非法返回 null（调用方保留内置最小表）。 */
export function parseMessages(text: any): any {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const table: any = {}
  for (const [code, value] of Object.entries(parsed)) {
    if (code === LOCALE_KEY) continue
    if (typeof value !== 'object' || value === null) continue
    const entry = value as any
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') continue
    const out: any = { title: entry.title, body: entry.body }
    if (typeof entry.action === 'string' && entry.action.length > 0) out.action = entry.action
    table[code] = out
  }
  return Object.keys(table).length > 0 ? table : null
}

/** 按码取文案：共享表 → 本地界面文案 → `unknown` 兜底（不空白、不报错）。 */
export function lookupMessage(table: any, code: string): any {
  const source = typeof table === 'object' && table !== null ? table : FALLBACK_MESSAGES
  const entry = source[code]
  if (entry !== undefined) return entry
  if (typeof UI_TEXT[code] === 'string') return { title: '', body: UI_TEXT[code] }
  const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

/** 取文案正文（错误码人话 / 界面文案统一入口）。 */
export function messageText(table: any, code: string): string {
  return lookupMessage(table, code).body
}

/** 取带占位符的界面文案模板并代入变量（`{name}` 形式）。 */
export function formatText(table: any, code: string, vars: any): string {
  const template = messageText(table, code)
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    vars !== null && vars !== undefined && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  )
}

/** 拉取共享文案表；失败保留内置最小表。 */
export async function loadMessages(fetchImpl: any, url: string): Promise<any> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return FALLBACK_MESSAGES
    const parsed = parseMessages(await response.text())
    return parsed ?? FALLBACK_MESSAGES
  } catch {
    return FALLBACK_MESSAGES
  }
}
