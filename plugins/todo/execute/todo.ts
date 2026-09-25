// 待办清单的纯逻辑：参数规范化、限额 / 枚举门禁、对外条目形状。
// 清单本体已出世界（住 owner 委托存储），本文件不构造写计划、不读投影、不自取时间。

import { asArray, asString, isRecord } from './plan.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { Json, Rec } from './types.ts'
import type { TodoLimits } from './config.ts'

export interface ResolvedItems {
  items: Json[]
  total: number
  done: number
}

/** 按 Unicode 码点计长（与宿主 argsSchema 的 minLength / maxLength 同口径）。 */
export function codePointLength(text: string): number {
  return [...text].length
}

function isCompleted(item: Json): boolean {
  return isRecord(item) && item['status'] === 'completed'
}

interface NormalizedItem {
  id: string
  text: string
  status: string
  priority: Json | undefined
  at: string | null
}

function normalizeItem(
  raw: Json,
  index: number,
  conversationId: string,
  defaultAt: string | null,
  limits: TodoLimits,
): NormalizedItem {
  if (!isRecord(raw)) throw new BadArgsError(`items[${index}] must be an object`)
  const text = asString(raw['text'])
  if (text === null) throw new BadArgsError(`items[${index}].text required`)
  const length = codePointLength(text)
  if (length > limits.maxTextLength) {
    throw new ToolError('text_too_long', `items[${index}] ${length} > ${limits.maxTextLength}`)
  }
  let status = 'pending'
  if (raw['status'] !== undefined && raw['status'] !== null) {
    const provided = asString(raw['status'])
    if (provided === null) throw new BadArgsError(`items[${index}].status must be a string`)
    status = provided
  }
  if (!limits.statuses.includes(status)) throw new ToolError('bad_status', status)
  const id = asString(raw['id']) ?? `${conversationId}-${index}`
  const rawPriority = raw['priority']
  let priority: Json | undefined
  if (rawPriority !== undefined && rawPriority !== null) {
    if (typeof rawPriority !== 'number' && typeof rawPriority !== 'string') {
      throw new BadArgsError(`items[${index}].priority must be a number or string`)
    }
    priority = rawPriority
  }
  return { id, text, status, priority, at: asString(raw['at']) ?? defaultAt }
}

/** 校验并规范化整表条目；返回对外声明的条目形状（不含内部链式字段）。 */
export function normalizeItems(
  args: Rec,
  conversationId: string,
  limits: TodoLimits,
): { items: Json[]; summary: ResolvedItems } {
  const rawItems = asArray(args['items'])
  if (rawItems === null) throw new BadArgsError('items must be an array')
  if (rawItems.length > limits.maxItems) {
    throw new ToolError('too_many_items', `${rawItems.length} > ${limits.maxItems}`)
  }
  const defaultAt = asString(args['at'])
  const normalized = rawItems.map((raw, index) => normalizeItem(raw, index, conversationId, defaultAt, limits))
  const items: Json[] = normalized.map((item) => {
    const out: Rec = { id: item.id, text: item.text, status: item.status }
    if (item.at !== null) out['at'] = item.at
    if (item.priority !== undefined) out['priority'] = item.priority
    return out
  })
  return { items, summary: summarize(items) }
}

/** 汇总条目：总数与完成数。 */
export function summarize(items: Json[]): ResolvedItems {
  const clean = items.map((item) => (isRecord(item) ? stripInternal(item) : item))
  return { items: clean, total: clean.length, done: clean.filter(isCompleted).length }
}

/** 去掉可能混入的内部字段，只留对外声明的条目形状。 */
function stripInternal(item: Rec): Rec {
  const out: Rec = {}
  for (const key of Object.keys(item)) {
    if (key === 'prev') continue
    out[key] = item[key]
  }
  return out
}
