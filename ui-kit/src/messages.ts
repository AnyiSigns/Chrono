// 文案取用：错误码人话来自壳的共享文案表，未登记码走 `unknown` 兜底；
// 各界面文案由消费方以 `createMessages(uiText)` 注入，共享表登记同名码时自动优先，
// 避免插件各自硬编码错误人话。纯模块：不触 DOM、不 import react。

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

const LOCALE_KEY = 'locale'
const UNKNOWN_CODE = 'unknown'

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

export interface MessageResponse {
  ok: boolean
  text(): Promise<string>
}

/** 一套按 `uiText` 注入本地兜底文案的取用函数。 */
export interface Messages {
  FALLBACK_MESSAGES: MessageTable
  parseMessages: typeof parseMessages
  lookupMessage(table: unknown, code: string): MessageEntry
  messageText(table: unknown, code: string): string
  formatText(table: unknown, code: string, vars?: unknown): string
  loadMessages(fetchImpl: (url: string) => Promise<MessageResponse>, url: string): Promise<MessageTable>
}

/**
 * 以本地界面文案表构造取用函数：共享表 → 本地 `uiText` → `unknown` 兜底（不空白、不报错）。
 * `vars` 取 `unknown`：调用方既有对象也有 `unknown` 透传，未命中占位符时原样保留。
 */
export function createMessages(uiText: Record<string, string>): Messages {
  const lookupMessage = (table: unknown, code: string): MessageEntry => {
    const source = (typeof table === 'object' && table !== null ? table : FALLBACK_MESSAGES) as MessageTable
    const entry = source[code]
    if (entry !== undefined) return entry
    if (typeof uiText[code] === 'string') return { title: '', body: uiText[code]! }
    const unknown = source[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]!
    return { ...unknown, body: unknown.body.replace('{code}', code) }
  }

  const messageText = (table: unknown, code: string): string => lookupMessage(table, code).body

  const formatText = (table: unknown, code: string, vars?: unknown): string => {
    const template = messageText(table, code)
    const values = typeof vars === 'object' && vars !== null ? (vars as Record<string, unknown>) : null
    return template.replace(/\{(\w+)\}/g, (match, key) =>
      values !== null && Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key])
        : match,
    )
  }

  const loadMessages = async (
    fetchImpl: (url: string) => Promise<MessageResponse>,
    url: string,
  ): Promise<MessageTable> => {
    try {
      const response = await fetchImpl(url)
      if (!response.ok) return FALLBACK_MESSAGES
      const parsed = parseMessages(await response.text())
      return parsed ?? FALLBACK_MESSAGES
    } catch {
      return FALLBACK_MESSAGES
    }
  }

  return { FALLBACK_MESSAGES, parseMessages, lookupMessage, messageText, formatText, loadMessages }
}
