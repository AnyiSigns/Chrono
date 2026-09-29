// 待办清单的纯逻辑：参数规范化、限额 / 枚举门禁、增量操作、稳定 id 分配、对外条目形状。
// 清单本体已出世界（住 owner 委托存储），本文件不构造写计划、不读投影、不自取时间。
// 条目 id 稳定：写入 / 新增时缺省分配 `t<seq>`（seq 随会话持久化），整表替换带上读到的 id 即保持身份。

import { BadArgsError } from 'plugin-sdk'
import { asArray, asString, isRecord } from './plan.ts'
import { ToolError } from './types.ts'
import type { Json, Rec } from 'plugin-sdk'
import type { TodoLimits } from './config.ts'

export interface ResolvedItems {
  items: Json[]
  total: number
  done: number
}

/** 对外声明的条目字段（其余内部 / 历史字段一律不外泄）。 */
const ITEM_KEYS = ['id', 'text', 'status', 'activeForm', 'at'] as const

/** 按 Unicode 码点计长（与宿主 argsSchema 的 minLength / maxLength 同口径）。 */
export function codePointLength(text: string): number {
  return [...text].length
}

/** 只保留对外声明的条目字段。 */
export function projectItem(item: Rec): Rec {
  const out: Rec = {}
  for (const key of ITEM_KEYS) {
    if (item[key] !== undefined) out[key] = item[key]
  }
  return out
}

/** 文本门禁（必填非空 + 码点上限）。 */
function readText(raw: Rec, where: string, limits: TodoLimits): string {
  const text = asString(raw['text'])
  if (text === null || text.length === 0) throw new BadArgsError(`${where}.text required`)
  const length = codePointLength(text)
  if (length > limits.maxTextLength) {
    throw new ToolError('text_too_long', `${where}.text ${length} > ${limits.maxTextLength}`)
  }
  return text
}

/** 状态门禁（缺省回落 fallback，越界回结构化拒并给出合法枚举）。 */
function readStatus(raw: Rec, where: string, limits: TodoLimits, fallback: string): string {
  const value = raw['status']
  if (value === undefined || value === null) return fallback
  const status = asString(value)
  if (status === null) throw new BadArgsError(`${where}.status must be a string`)
  if (!limits.statuses.includes(status)) {
    throw new ToolError(
      'bad_status',
      `${status} not in [${limits.statuses.join(', ')}] (${where}.status)`,
    )
  }
  return status
}

/** 进行时描述：可选、非空串；空串视作未给（更新时用于清除）。 */
function readActiveForm(raw: Rec, where: string, limits: TodoLimits): string | undefined {
  const value = raw['activeForm']
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BadArgsError(`${where}.activeForm must be a string`)
  if (value.length === 0) return undefined
  const length = codePointLength(value)
  if (length > limits.maxTextLength) {
    throw new ToolError('text_too_long', `${where}.activeForm ${length} > ${limits.maxTextLength}`)
  }
  return value
}

/** 组装对外条目（可选字段仅在存在时写入）。 */
function buildItem(
  id: string,
  text: string,
  status: string,
  activeForm: string | undefined,
  at: string | null,
): Rec {
  const item: Rec = { id, text, status }
  if (activeForm !== undefined) item['activeForm'] = activeForm
  if (at !== null) item['at'] = at
  return item
}

/** 焦点唯一：把除 focusId 外的 in_progress 降回 pending。 */
function applyFocus(items: Json[], focusId: string): void {
  for (const item of items) {
    if (isRecord(item) && item['id'] !== focusId && item['status'] === 'in_progress') {
      item['status'] = 'pending'
    }
  }
}

const ID_RE = /^t(\d+)$/

/** 已分配 id 的最大序号 + 1（保证新分配的 `t<n>` 不与存量冲突）。 */
function maxIdSeq(items: Json[]): number {
  let max = -1
  for (const item of items) {
    if (!isRecord(item)) continue
    const id = asString(item['id'])
    const match = id === null ? null : ID_RE.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/** 下一个可用 id 序号 = max(持久化的 seq, 存量 id 最大序号 + 1)。 */
export function nextSeqFor(items: Json[], storedSeq: number): number {
  return Math.max(storedSeq, maxIdSeq(items))
}

/** 缺省时间：args.at 优先，其次 bag.at（调用方入口 term 提供）。 */
export function defaultAtOf(args: Rec, bag: Rec): string | null {
  const direct = asString(args['at'])
  if (direct !== null) return direct
  return asString(bag['at'])
}

/** 校验并规范化整表条目；返回对外声明的条目形状 + 下一个可用 id 序号。 */
export function normalizeItems(
  args: Rec,
  limits: TodoLimits,
  startSeq: number,
): { items: Json[]; summary: ResolvedItems; nextSeq: number } {
  const rawItems = asArray(args['items'])
  if (rawItems === null) throw new BadArgsError('items must be an array')
  if (rawItems.length > limits.maxItems) {
    throw new ToolError('too_many_items', `${rawItems.length} > ${limits.maxItems}`)
  }
  const defaultAt = asString(args['at'])
  let seq = startSeq
  for (const raw of rawItems) {
    if (!isRecord(raw)) continue
    const provided = asString(raw['id'])
    const match = provided === null ? null : ID_RE.exec(provided)
    if (match !== null) seq = Math.max(seq, Number(match[1]) + 1)
  }
  let focusId: string | null = null
  const seen = new Set<string>()
  const items: Json[] = []
  rawItems.forEach((raw, index) => {
    const where = `items[${index}]`
    if (!isRecord(raw)) throw new BadArgsError(`${where} must be an object`)
    const id = asString(raw['id']) ?? `t${seq++}`
    if (seen.has(id)) throw new BadArgsError(`${where}.id duplicated: ${id}`)
    seen.add(id)
    const text = readText(raw, where, limits)
    const status = readStatus(raw, where, limits, 'pending')
    const activeForm = readActiveForm(raw, where, limits)
    const at = asString(raw['at']) ?? defaultAt
    if (status === 'in_progress') {
      if (focusId !== null) {
        throw new ToolError(
          'multiple_in_progress',
          `items 含多个 in_progress（${focusId}, ${id}）；同一清单至多一个`,
        )
      }
      focusId = id
    }
    items.push(buildItem(id, text, status, activeForm, at))
  })
  return { items, summary: summarize(items), nextSeq: seq }
}

export interface OpsOutcome {
  items: Json[]
  changed: Json[]
  summary: ResolvedItems
  nextSeq: number
}

function requireId(raw: Rec, where: string): string {
  const id = asString(raw['id'])
  if (id === null || id.length === 0) throw new BadArgsError(`${where}.id required`)
  return id
}

function indexOfId(items: Json[], id: string): number {
  return items.findIndex((item) => isRecord(item) && item['id'] === id)
}

/**
 * 按序把增量操作应用到演进中的清单：
 * `add` 追加、`update` 改字段、`remove` 删除、`move` 移到下标。
 * 焦点唯一：任一把条目置为 in_progress 的操作会把其它 in_progress 降回 pending。
 */
export function applyOps(
  current: Json[],
  opsRaw: Json[],
  limits: TodoLimits,
  startSeq: number,
  defaultAt: string | null,
): OpsOutcome {
  const items = current.filter(isRecord).map(projectItem)
  let seq = startSeq
  const changed: Json[] = []
  opsRaw.forEach((raw, index) => {
    const where = `ops[${index}]`
    if (!isRecord(raw)) throw new BadArgsError(`${where} must be an object`)
    const op = asString(raw['op'])
    switch (op) {
      case 'add': {
        const id = `t${seq++}`
        const text = readText(raw, where, limits)
        const status = readStatus(raw, where, limits, 'pending')
        const activeForm = readActiveForm(raw, where, limits)
        const at = asString(raw['at']) ?? defaultAt
        if (status === 'in_progress') applyFocus(items, id)
        const item = buildItem(id, text, status, activeForm, at)
        items.push(item)
        changed.push(projectItem(item))
        break
      }
      case 'update': {
        const id = requireId(raw, where)
        const at = indexOfId(items, id)
        if (at < 0) throw new ToolError('item_not_found', `${id} (${where}.id)`)
        const item = items[at] as Rec
        if (raw['text'] !== undefined) item['text'] = readText(raw, where, limits)
        if (raw['status'] !== undefined) {
          const status = readStatus(raw, where, limits, 'pending')
          if (status === 'in_progress') applyFocus(items, id)
          item['status'] = status
        }
        if (raw['activeForm'] !== undefined) {
          const activeForm = readActiveForm(raw, where, limits)
          if (activeForm === undefined) delete item['activeForm']
          else item['activeForm'] = activeForm
        }
        if (raw['at'] !== undefined) {
          const nextAt = asString(raw['at'])
          if (nextAt === null) delete item['at']
          else item['at'] = nextAt
        }
        changed.push(projectItem(item))
        break
      }
      case 'remove': {
        const id = requireId(raw, where)
        const at = indexOfId(items, id)
        if (at < 0) throw new ToolError('item_not_found', `${id} (${where}.id)`)
        items.splice(at, 1)
        changed.push({ id, removed: true })
        break
      }
      case 'move': {
        const id = requireId(raw, where)
        const target = raw['index']
        if (typeof target !== 'number' || !Number.isInteger(target)) {
          throw new BadArgsError(`${where}.index must be an integer`)
        }
        const at = indexOfId(items, id)
        if (at < 0) throw new ToolError('item_not_found', `${id} (${where}.id)`)
        const [item] = items.splice(at, 1)
        const to = Math.max(0, Math.min(target, items.length))
        items.splice(to, 0, item)
        changed.push({ id, index: to })
        break
      }
      default:
        throw new ToolError('unknown_op', `${String(raw['op'])} (${where}.op)`)
    }
  })
  if (items.length > limits.maxItems) {
    throw new ToolError('too_many_items', `${items.length} > ${limits.maxItems}`)
  }
  return { items, changed, summary: summarize(items), nextSeq: seq }
}

/** 汇总条目：总数与完成数（完成数不计 cancelled）。 */
export function summarize(items: Json[]): ResolvedItems {
  const clean = items.filter(isRecord).map(projectItem)
  return {
    items: clean,
    total: clean.length,
    done: clean.filter((item) => item['status'] === 'completed').length,
  }
}
