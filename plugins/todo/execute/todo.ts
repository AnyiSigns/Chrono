// 待办清单的纯逻辑：把整表条目构造成「条目 def 链 + 本会话键新 body + add_gen」写计划，
// 以及从调用方传入的投影数据里解析某会话的条目链。不读投影、不落账、不自取时间。

import { asArray, asString, baseSeqOf, isRecord, planOf, pushBodyGen, putOp } from './plan.ts'
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

/** 去掉链式管线的 `prev` 键，只留对外声明的条目形状。 */
function stripPrev(item: Rec): Rec {
  const out: Rec = {}
  for (const key of Object.keys(item)) {
    if (key !== 'prev') out[key] = item[key]
  }
  return out
}

/** 从调用方传入的投影数据里取待办 body：`{body}` 包裹 / 裸 body / 其它回落空 body。 */
export function extractBody(data: Json | undefined): Rec {
  if (!isRecord(data)) return {}
  if (isRecord(data['body'])) return data['body']
  if (isRecord(data['conversations'])) return data
  return {}
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

/** 只重写本会话键、保留 body 里其它会话键（旧 def 不进新链，仍留世界 defs 上，可回放）。 */
function mergeConversation(body: Rec, conversationId: string, items: Rec): Rec {
  const existing = isRecord(body['conversations']) ? body['conversations'] : {}
  const conversations: Rec = { ...existing, [conversationId]: { items } }
  return { ...body, conversations }
}

/** 数据 body 的规范形状：剥离入口切片并进来的投影元数据（`data_gen` / `refs`），只留身份数据字段。 */
function stripMeta(body: Rec): Rec {
  const out: Rec = {}
  for (const key of Object.keys(body)) {
    if (key === 'data_gen' || key === 'refs') continue
    out[key] = body[key]
  }
  return out
}

/**
 * `todo.write` 的写计划：条目按输入顺序各自成 def、`prev` 串成新链（首条 prev = null），
 * body 只替换本会话键（tail 指新链头、count = 条数），再 `add_gen('todo', put(body))`。
 * 空数组 = 本会话清空（tail = null、count = 0）。
 * @param args 工具参数（conversation_id / items / at / body）
 * @param data 调用方传入的当前待办投影（bag.todo），用于保留其它会话键
 * @param limits 从同包 schema 解析的限额与状态枚举
 */
export function buildWritePlan(args: Rec, data: Json | undefined, limits: TodoLimits): Json {
  const conversationId = asString(args['conversation_id'])
  if (conversationId === null) throw new BadArgsError('conversation_id required')
  const items = asArray(args['items'])
  if (items === null) throw new BadArgsError('items must be an array')
  if (items.length > limits.maxItems) {
    throw new ToolError('too_many_items', `${items.length} > ${limits.maxItems}`)
  }
  const defaultAt = asString(args['at'])
  const normalized = items.map((raw, index) =>
    normalizeItem(raw, index, conversationId, defaultAt, limits),
  )

  const ops: Json[] = []
  normalized.forEach((item, index) => {
    const body: Rec = {
      id: item.id,
      text: item.text,
      status: item.status,
      prev: index === 0 ? null : { def: { $n: index - 1 } },
    }
    if (item.at !== null) body['at'] = item.at
    if (item.priority !== undefined) body['priority'] = item.priority
    ops.push(putOp(body))
  })
  const tail: Json = normalized.length > 0 ? { def: { $n: normalized.length - 1 } } : null
  const prevBody = stripMeta(extractBody(data))
  const nextBody = mergeConversation(prevBody, conversationId, { tail, count: normalized.length })
  pushBodyGen(ops, 'todo', prevBody, nextBody, baseSeqOf(isRecord(data) ? data : {}))

  const summaryItems = normalized.map((item) => {
    const out: Rec = { id: item.id, text: item.text, status: item.status }
    if (item.at !== null) out['at'] = item.at
    if (item.priority !== undefined) out['priority'] = item.priority
    return out
  })
  return planOf(ops, {
    ok: true,
    conversation_id: conversationId,
    total: summaryItems.length,
    done: summaryItems.filter((item) => item['status'] === 'completed').length,
    items: summaryItems,
  })
}

/**
 * `todo.read`：从调用方传入的数据里解析某会话的条目（老→新，与写入顺序一致）。
 * 数据可为已解析的 `{items}`，或投影片段 `{body, refs}` / 裸 body（条目 def 链经 refs 回溯）。
 */
export function resolveItems(data: Json | undefined, conversationId: string): ResolvedItems {
  if (!isRecord(data)) throw new ToolError('missing_todo', 'todo data not provided by caller')
  if (Array.isArray(data['items'])) {
    const items = (data['items'] as Json[]).map((item) => (isRecord(item) ? stripPrev(item) : item))
    return { items, total: items.length, done: items.filter(isCompleted).length }
  }
  const body = isRecord(data['body']) ? data['body'] : data
  const refs = isRecord(data['refs']) ? data['refs'] : {}
  const conversations = isRecord(body['conversations']) ? body['conversations'] : {}
  const entry = conversations[conversationId]
  if (!isRecord(entry) || !isRecord(entry['items'])) return { items: [], total: 0, done: 0 }
  const tailField = entry['items']['tail']
  const tail = isRecord(tailField) ? asString(tailField['def']) : null
  if (tail === null) return { items: [], total: 0, done: 0 }

  const backwards: Rec[] = []
  const seen = new Set<string>()
  let current: string | null = tail
  while (current !== null) {
    if (seen.has(current)) throw new ToolError('todo_cycle', current)
    seen.add(current)
    const raw = refs[current]
    if (!isRecord(raw)) throw new ToolError('missing_refs', current)
    backwards.push(raw)
    const prev = raw['prev']
    current = isRecord(prev) ? asString(prev['def']) : null
  }
  const items = backwards.reverse().map(stripPrev)
  return { items, total: items.length, done: items.filter(isCompleted).length }
}
