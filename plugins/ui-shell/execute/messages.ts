// 文案表（错误码 → 人话）唯一来源：`execute/web/messages.v1.json`。
// 表结构 `{ "<code>": { title, body, action? }, "locale": … }`；未登记码按 `unknown` 兜底。
// 本模块只做读取 / 形态校验 / 兜底，不含业务判断。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export interface MessageEntry {
  title: string
  body: string
  action?: string
}

/** 文案表须覆盖的插件错误码前缀（ui-design §15 文案表）。 */
export const MESSAGE_PREFIXES = [
  'ui_',
  'model_',
  'discover_',
  'approval_',
  'sandbox_',
  'guard_',
  'tool_',
  'mcp_',
  'plugin_',
]

export const UNKNOWN_CODE = 'unknown'
export const LOCALE_KEY = 'locale'

/**
 * 兼容别名：宿主实际发出的裸码 → 表中同义键。
 * 表里已登记裸码时直查命中，此映射只作历史 `plugin_*` / `mcp_*` 命名的兜底。
 */
export const MESSAGE_ALIASES: { [code: string]: string } = {
  unresolved_pin: 'plugin_unresolved_pin',
  identity_mismatch: 'plugin_identity_mismatch',
  hidden_identity: 'plugin_hidden',
  validate_required: 'plugin_validate_required',
  restart_exhausted: 'mcp_restart_exhausted',
}

/** 内置最小文案表：表读取失败时的兜底（错误码原样显示，不阻塞）。 */
export const FALLBACK_MESSAGES: { [code: string]: MessageEntry } = {
  unknown: {
    title: '出现问题',
    body: '错误码 {code} 暂无说明。重试可再试一次。',
  },
  ui_unreachable: {
    title: '宿主不可达',
    body: '与宿主的连接已断开。检查宿主是否在运行，然后重试。',
    action: '重试',
  },
  ui_boot_failed: {
    title: '界面加载失败',
    body: '这个界面未能启动。重试可重新加载。',
    action: '重试',
  },
  ui_version_mismatch: {
    title: '界面版本不符',
    body: '界面与壳的契约版本不一致。更新插件后重试。',
    action: '重试',
  },
  shell_tokens_fallback: {
    title: '样式降级',
    body: '设计 token 未能加载，已用最小样式兜底。',
  },
}

function asMessageEntry(value: Json): MessageEntry | null {
  if (!isRecord(value)) return null
  const title = value['title']
  const body = value['body']
  if (typeof title !== 'string' || typeof body !== 'string') return null
  const entry: MessageEntry = { title, body }
  const action = value['action']
  if (typeof action === 'string' && action.length > 0) entry.action = action
  return entry
}

/**
 * 解析文案表文本：返回 code → entry（`locale` 键保留但不作码）。
 * 任一非 locale 键形态非法即整体判非法（返回 null，回落内置最小表）。
 */
export function parseMessages(text: string): { [code: string]: MessageEntry } | null {
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const table: { [code: string]: MessageEntry } = {}
  for (const [code, value] of Object.entries(parsed)) {
    if (code === LOCALE_KEY) continue
    const entry = asMessageEntry(value)
    if (entry === null) return null
    table[code] = entry
  }
  if (Object.keys(table).length === 0) return null
  return table
}

/** 读文案表；失败回落内置最小表。 */
export function loadMessages(webDir: string): {
  table: { [code: string]: MessageEntry }
  fallback: boolean
} {
  try {
    const parsed = parseMessages(readFileSync(join(webDir, 'messages.v1.json'), 'utf8'))
    if (parsed !== null) return { table: parsed, fallback: false }
  } catch {
    // 文件缺失 / 读失败：走内置兜底
  }
  return { table: FALLBACK_MESSAGES, fallback: true }
}

/** 按码取文案；未登记码先查别名，再回落 `unknown`（不空白、不报错），并回填错误码。 */
export function lookupMessage(
  table: { [code: string]: MessageEntry },
  code: string,
): MessageEntry {
  const entry = table[code]
  if (entry !== undefined) return entry
  const alias = MESSAGE_ALIASES[code]
  if (alias !== undefined) {
    const aliased = table[alias]
    if (aliased !== undefined) return aliased
  }
  const unknown = table[UNKNOWN_CODE] ?? FALLBACK_MESSAGES[UNKNOWN_CODE]
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

/** 表已覆盖的前缀清单。 */
export function coveredPrefixes(table: { [code: string]: MessageEntry }): string[] {
  const codes = Object.keys(table)
  return MESSAGE_PREFIXES.filter((prefix) => codes.some((code) => code.startsWith(prefix)))
}

/** 未覆盖的前缀清单（应为空）。 */
export function missingPrefixes(table: { [code: string]: MessageEntry }): string[] {
  const covered = new Set(coveredPrefixes(table))
  return MESSAGE_PREFIXES.filter((prefix) => !covered.has(prefix))
}
