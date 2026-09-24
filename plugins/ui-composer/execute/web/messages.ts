// 文案取用：错误码人话来自壳的 `/assets/messages.v1.json`（唯一来源），未登记码走 `unknown` 兜底。
// 输入卡的界面文案共享表尚未登记，这里以 `UI_TEXT` 作本地兜底；
// 共享表一旦登记同名码即自动优先——避免在本插件硬编码人话。

export interface MessageEntry {
  title: string
  body: string
  action?: string
}

export interface MessageTable {
  [code: string]: MessageEntry
}

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES: MessageTable = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: {
    title: '宿主不可达',
    body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。',
    action: '重试',
  },
}

/** 本插件界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: { [code: string]: string } = {
  composer_placeholder: '输入消息…（Enter 发送）',
  composer_send: '发送',
  composer_stop: '终止',
  composer_attach: '添加附件',
  composer_attach_failed: '附件读取失败',
  composer_remove_attachment: '移除附件',
  composer_model: '模型',
  composer_reasoning: '推理强度',
  composer_permission: '权限',
  composer_permission_auto: '全过',
  composer_permission_severe: '工作区读写',
  composer_permission_review: '工作区只读',
  composer_permission_deny: '全部拒绝',
  composer_permission_auto_desc: '全部放行',
  composer_permission_severe_desc: '工作区读写；工作区外或危险操作弹卡',
  composer_permission_review_desc: '只读工作区',
  composer_permission_deny_desc: '全部拒绝',
  composer_no_model: '未配置模型',
  composer_config_loading: '配置读取中…',
  composer_config_loading_more: '仍在读取…',
  composer_config_failed: '配置读取失败。重试可再试一次。',
  composer_config_offline: '宿主不可达，配置暂不可用。',
  composer_reasoning_fetching: '获取中…',
  composer_reasoning_failed: '档位读取失败',
  composer_reasoning_on: '开',
  composer_reasoning_off: '关',
  composer_retry: '重试',
  composer_pending: '待发 {count}',
  composer_pending_title: '待发消息',
  composer_pending_remove: '移除',
  composer_context: '上下文 {used} / {budget}',
  composer_context_full: '上下文已满 · {used} / {budget}',
  composer_source_system: '系统提示',
  composer_source_tools: '工具',
  composer_source_memory: '记忆',
  composer_source_history: '历史',
  composer_source_skills: '技能',
  composer_trimmed: '被裁剪 {count} 项',
  composer_trimmed_reason: '原因：{reason}',
  composer_attachment: '附件 {count}',
  composer_more_chip: '+{count}',
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
  for (const [code, value] of Object.entries(parsed as { [key: string]: unknown })) {
    if (code === LOCALE_KEY) continue
    if (typeof value !== 'object' || value === null) continue
    const entry = value as { title?: unknown; body?: unknown; action?: unknown }
    if (typeof entry.title !== 'string' || typeof entry.body !== 'string') continue
    const item: MessageEntry = { title: entry.title, body: entry.body }
    if (typeof entry.action === 'string' && entry.action.length > 0) item.action = entry.action
    table[code] = item
  }
  return Object.keys(table).length > 0 ? table : null
}

/** 按码取文案：共享表 → 本地界面文案 → `unknown` 兜底（不空白、不报错）。 */
export function lookupMessage(table: unknown, code: string): MessageEntry {
  const source =
    typeof table === 'object' && table !== null ? (table as MessageTable) : FALLBACK_MESSAGES
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

/** 取带占位符的文案模板并代入变量（`{name}` 形式）。 */
export function formatText(table: unknown, code: string, vars: unknown): string {
  const template = lookupMessage(table, code).body
  const values =
    typeof vars === 'object' && vars !== null ? (vars as { [key: string]: unknown }) : null
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    values !== null && Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  )
}

export interface MessageResponse {
  ok: boolean
  text(): Promise<string>
}

/** 拉取共享文案表；失败保留内置最小表。 */
export async function loadMessages(
  fetchImpl: (url: string) => Promise<MessageResponse>,
  url: string,
): Promise<MessageTable> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok) return FALLBACK_MESSAGES
    const parsed = parseMessages(await response.text())
    return parsed ?? FALLBACK_MESSAGES
  } catch {
    return FALLBACK_MESSAGES
  }
}
