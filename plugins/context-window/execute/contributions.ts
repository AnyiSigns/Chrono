// 外部 `context-source` 贡献的记录解析与候选消息转换（装配器化入口）。
// 调用方（graph-run 的 `context.assemble` 前置）按世界 `many` 成员表逐一反向 `context-source.collect`，
// 汇总为 `bag.context_sources`；形状非法项静默跳过（作数据，不崩装配）。
// 记录只声明事实（来源 / 角色 / 内容 / 稳定性 / 优先级），装配器按记录机械转为候选，不枚举贡献方。

import { isRecord } from './text.ts'
import type { CanonicalPart, ContextRecord, Json, RawMessage, Role, Stability } from './types.ts'

const ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool']

/** 解析单个 content part：文本要求 `text` 字符串；资产要求 `asset.{sha256,mime}`。 */
function parsePart(value: Json): CanonicalPart | null {
  if (!isRecord(value)) return null
  const type = value['type']
  if (type === 'text') {
    return typeof value['text'] === 'string' ? { type: 'text', text: value['text'] } : null
  }
  if (type === 'image' || type === 'audio' || type === 'file') {
    const asset = isRecord(value['asset']) ? value['asset'] : null
    if (asset === null) return null
    const sha256 = asset['sha256']
    const mime = asset['mime']
    if (typeof sha256 !== 'string' || typeof mime !== 'string') return null
    const name = value['name']
    return { type, asset: { sha256, mime }, name: typeof name === 'string' ? name : null }
  }
  return null
}

/** 解析 parts：非空且每一项合法才接受（避免半截消息进装配）。 */
function parseParts(value: Json | undefined): CanonicalPart[] | null {
  if (!Array.isArray(value)) return null
  const parts: CanonicalPart[] = []
  for (const item of value) {
    const part = parsePart(item)
    if (part === null) return null
    parts.push(part)
  }
  return parts.length > 0 ? parts : null
}

function stabilityOf(value: Json | undefined): Stability | null {
  return value === 'stable' || value === 'dynamic' ? value : null
}

function stringOf(value: Json | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** 解析单条中性记录；任一必需字段缺失 / 非法即返回 null（跳过该条）。 */
export function parseRecord(value: Json): ContextRecord | null {
  if (!isRecord(value)) return null
  const source = value['source']
  if (typeof source !== 'string' || source.length === 0) return null
  const role = value['role']
  if (typeof role !== 'string' || !ROLES.includes(role)) return null
  const priority = value['priority']
  if (typeof priority !== 'number' || !Number.isFinite(priority)) return null
  const stability = stabilityOf(value['stability'])
  if (stability === null) return null
  const parts = parseParts(value['parts'])
  if (parts === null) return null

  const record: ContextRecord = { source, role: role as Role, parts, priority, stability }
  if (typeof value['at'] === 'number' && Number.isFinite(value['at'])) record.at = value['at'] as number
  if (value['atomic'] === true) record.atomic = true
  if (typeof value['atomicGroup'] === 'number' && Number.isFinite(value['atomicGroup'])) {
    record.atomicGroup = value['atomicGroup'] as number
  }
  const from = stringOf(value['from'])
  if (from !== null) record.from = from
  const toolCallId = stringOf(value['toolCallId'])
  if (toolCallId !== null) record.toolCallId = toolCallId
  if (value['toolCalls'] !== undefined) record.toolCalls = value['toolCalls'] as Json
  if (isRecord(value['reasoning'])) record.reasoning = value['reasoning'] as ContextRecord['reasoning']
  if (isRecord(value['toolResult'])) record.toolResult = value['toolResult'] as ContextRecord['toolResult']
  if (value['hint'] === true) record.hint = true
  const error = stringOf(value['error'])
  if (error !== null) record.error = error
  const defKey = stringOf(value['defKey'])
  if (defKey !== null) record.defKey = defKey
  const turnId = stringOf(value['turnId'])
  if (turnId !== null) record.turnId = turnId
  if (typeof value['step'] === 'number' && Number.isFinite(value['step'])) record.step = value['step'] as number
  const tokenKey = stringOf(value['tokenKey'])
  if (tokenKey !== null) record.tokenKey = tokenKey
  return record
}

/** 解析 `bag.context_sources`（调用方汇集的外部中性记录数组）；形状非法回空表。 */
export function recordsFromArray(value: Json | undefined): ContextRecord[] {
  if (!Array.isArray(value)) return []
  const records: ContextRecord[] = []
  for (const item of value) {
    const record = parseRecord(item as Json)
    if (record !== null) records.push(record)
  }
  return records
}

/** 中性记录 → 候选消息（orderHint 由装配器按成员顺序续排，保证确定性）。 */
export function recordToRaw(record: ContextRecord, orderHint: number): RawMessage {
  const raw: RawMessage = {
    role: record.role,
    parts: record.parts,
    source: record.source,
    priority: record.priority,
    at: typeof record.at === 'number' ? record.at : 0,
    atomic: record.atomic === true,
    atomicGroup: typeof record.atomicGroup === 'number' ? record.atomicGroup : null,
    toolCallId: record.toolCallId ?? null,
    from: record.from ?? null,
    orderHint,
    stability: record.stability,
  }
  if (record.toolCalls !== undefined && record.toolCalls !== null) raw.toolCalls = record.toolCalls
  if (record.reasoning !== undefined && record.reasoning !== null) raw.reasoning = record.reasoning
  if (record.toolResult !== undefined && record.toolResult !== null) raw.toolResult = record.toolResult
  if (record.hint === true) raw.hint = true
  if (record.error !== undefined) raw.error = record.error
  if (record.defKey !== undefined) raw.defKey = record.defKey
  if (record.turnId !== undefined) raw.turnId = record.turnId
  if (record.step !== undefined) raw.step = record.step
  if (record.tokenKey !== undefined) raw.tokenKey = record.tokenKey
  return raw
}
