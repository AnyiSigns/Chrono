// 文案取用：错误码人话来自壳的 `/assets/messages.v1.json`（唯一来源），未登记码走 `unknown` 兜底。
// 非错误码的界面文案（已复制 / 仍在生成… 等）当前共享表未登记，这里以 `UI_TEXT` 作本地兜底；
// 共享表一旦登记同名码即自动优先——避免在本插件硬编码错误人话。

export interface MessageEntry {
  title: string
  body: string
  action?: string
}

export type MessageTable = { [code: string]: MessageEntry }

/** 表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES: MessageTable = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。重试可再试一次。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。', action: '重试' },
}

/** 共享表尚未登记、但本插件需要的界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: { [code: string]: string } = {
  chat_copied: '已复制',
  chat_copy_failed: '复制失败',
  chat_generating: '仍在生成…',
  chat_reasoning: '推理',
  chat_cancelled: '已取消',
  chat_no_more: '没有更多了',
  chat_new_messages: '以下为新消息',
  chat_expired: '已超时',
  chat_media_failed: '媒体加载失败',
  chat_empty_title: '开始新对话',
  chat_empty_hint: '输入消息开始，或先用 + 添加附件',
  chat_loading: '正在读取…',
  chat_submitting: '提交中…',
  chat_retry: '重试',
  chat_copy: '复制',
  chat_close: '关闭',
  chat_play_video: '播放视频',
  chat_custom_input: '自定义输入',
  chat_custom_answer: '自定义回答',
  chat_submit: '提交',
  chat_answer_required: '请先作答',
  chat_system_message: '系统消息',
  chat_error: '错误',
  chat_render_failed: '内容渲染失败',
  chat_file: '文件',
  chat_image: '图片',
  chat_agent: 'agent',
  chat_me: '我',
  chat_subagent: '子代理',
  chat_node_list: '节点列表',
  chat_node_name: '节点 {index}',
  chat_step_progress: '第 {index} / {total} 步',
  chat_new_messages_pill: '↓ {count} 条新消息',
  chat_pill_more: '↓',
  chat_status_running: '运行中',
  chat_status_success: '成功',
  chat_status_failed: '失败',
  chat_status_waiting: '等待审批',
  chat_status_skipped: '跳过',
  chat_status_pending: '等待',
  chat_today: '今天',
  chat_yesterday: '昨天',
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
    const record = value as { title?: unknown; body?: unknown; action?: unknown }
    if (typeof record.title !== 'string' || typeof record.body !== 'string') continue
    const entry: MessageEntry = { title: record.title, body: record.body }
    if (typeof record.action === 'string' && record.action.length > 0) entry.action = record.action
    table[code] = entry
  }
  return Object.keys(table).length > 0 ? table : null
}

/** 按码取文案：共享表 → 本地界面文案 → `unknown` 兜底（不空白、不报错）。 */
export function lookupMessage(table: MessageTable | null | undefined, code: string): MessageEntry {
  const source = typeof table === 'object' && table !== null ? table : FALLBACK_MESSAGES
  const entry = source[code]
  if (entry !== undefined) return entry
  if (typeof UI_TEXT[code] === 'string') return { title: '', body: UI_TEXT[code] }
  const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

/** 取文案正文（错误码人话 / 界面文案统一入口）。 */
export function messageText(table: MessageTable | null | undefined, code: string): string {
  return lookupMessage(table, code).body
}

/** 取带占位符的界面文案模板并代入变量（`{name}` 形式）。 */
export function formatText(code: string, vars?: { [key: string]: unknown } | null): string {
  const template = typeof UI_TEXT[code] === 'string' ? UI_TEXT[code] : ''
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    vars !== null && vars !== undefined && Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key])
      : match,
  )
}

/** 拉取共享文案表；失败保留内置最小表。 */
export async function loadMessages(
  fetchImpl: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>,
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
