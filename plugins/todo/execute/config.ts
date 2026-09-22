// 运行期限额与状态枚举：从同包 schema 读（每次调用时读取，schema 成员变化属数据、可热改）。
// 文件缺失 / 形态非法回落常量；不 import 宿主，故只按本包 schema 的顶层键读。

import { readFileSync } from 'node:fs'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

/** 缺省单会话条目条数上限（schema 未声明 / 不可读时）。 */
export const DEFAULT_MAX_ITEMS = 200
/** 缺省单条文本长度上限（Unicode 码点）。 */
export const DEFAULT_MAX_TEXT_LENGTH = 500
/** 缺省状态枚举。 */
export const DEFAULT_STATUSES: string[] = ['pending', 'in_progress', 'completed']

export interface TodoLimits {
  maxItems: number
  maxTextLength: number
  statuses: string[]
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function stringList(value: Json | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const list = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return list.length > 0 ? list : fallback
}

/** 读同包 schema 的限额与枚举；按调用时读取，支持 schema 成员热改。 */
export function resolveLimits(): TodoLimits {
  try {
    const text = readFileSync(new URL('../schema/todo.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) {
      return {
        maxItems: positiveInt(parsed['max_items'], DEFAULT_MAX_ITEMS),
        maxTextLength: positiveInt(parsed['max_text_length'], DEFAULT_MAX_TEXT_LENGTH),
        statuses: stringList(parsed['statuses'], DEFAULT_STATUSES),
      }
    }
  } catch {
    // schema 不可读不是致命：用缺省门禁
  }
  return { maxItems: DEFAULT_MAX_ITEMS, maxTextLength: DEFAULT_MAX_TEXT_LENGTH, statuses: DEFAULT_STATUSES }
}
