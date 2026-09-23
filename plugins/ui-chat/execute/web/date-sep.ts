// 跨天日期分隔（纯函数）：今天 / 昨天 / 同年 `MM-DD` / 跨年 `YYYY-MM-DD`，本地时区。

import { UI_TEXT } from './messages.ts'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function localDateKey(date: unknown): string {
  const value = date instanceof Date ? date : new Date(date as any)
  if (Number.isNaN(value.getTime())) return ''
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function startOfDay(date: unknown): Date {
  const value = date instanceof Date ? date : new Date(date as any)
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

/** 相对 `now` 的日期标签。 */
export function dateLabel(date: unknown, now?: unknown): string {
  const target = date instanceof Date ? date : new Date(date as any)
  if (Number.isNaN(target.getTime())) return ''
  const current = now instanceof Date ? now : new Date((now as any) ?? Date.now())
  const today = startOfDay(current)
  const day = startOfDay(target)
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000)
  if (diffDays === 0) return UI_TEXT.chat_today
  if (diffDays === 1) return UI_TEXT.chat_yesterday
  const month = pad(target.getMonth() + 1)
  const dayOfMonth = pad(target.getDate())
  if (target.getFullYear() === current.getFullYear()) return `${month}-${dayOfMonth}`
  return `${target.getFullYear()}-${month}-${dayOfMonth}`
}

/** 在消息序列间插入日期分隔项：`[{type:'date'|'message', ...}]`。 */
export function buildDateSeparators(messages: any[], now?: unknown): any[] {
  const out: any[] = []
  let lastKey: string | null = null
  for (const entry of messages) {
    const def = entry !== null && typeof entry === 'object' ? entry.def : null
    const at = def !== null && typeof def.at === 'string' ? def.at : ''
    const date = at.length > 0 ? new Date(at) : null
    const key = date !== null && !Number.isNaN(date.getTime()) ? localDateKey(date) : ''
    if (key.length > 0 && key !== lastKey) {
      out.push({ type: 'date', key, label: dateLabel(date, now) })
      lastKey = key
    }
    out.push({ type: 'message', entry })
  }
  return out
}
