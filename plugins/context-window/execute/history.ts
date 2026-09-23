// 历史候选解析：沿 `prev` 链还原会话消息、定位 covered_upto 边界、标记工具调用 atomic 组；
// 以及消息体 / 附件 / parts 的宽松解析。规范消息的组装在 `candidates.ts` 完成。

import { asAssetRef, isRecord } from './text.ts'
import type { AssetRef, CanonicalPart, Role } from './types.ts'

export interface ParsedParts {
  parts: CanonicalPart[]
  hasToolCall: boolean
}

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function assetPart(kind: 'image' | 'audio' | 'file', asset: AssetRef, name: string | null): CanonicalPart {
  return { type: kind, asset, name }
}

/** 宽松解析 parts：文本 / 资产 / 工具 part（工具 part 原样 JSON 化透传，方言化归上层）。 */
export function parseRawParts(value: unknown): ParsedParts {
  if (typeof value === 'string') return { parts: [textPart(value)], hasToolCall: false }
  if (!Array.isArray(value)) return { parts: [], hasToolCall: false }
  const parts: CanonicalPart[] = []
  let hasToolCall = false
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(textPart(item))
      continue
    }
    if (!isRecord(item)) continue
    const type = typeof item['type'] === 'string' ? (item['type'] as string) : 'text'
    if (type === 'text') {
      const text = typeof item['text'] === 'string' ? (item['text'] as string) : ''
      parts.push(textPart(text))
      continue
    }
    if (type === 'image' || type === 'audio' || type === 'file') {
      const asset = asAssetRef(item['asset']) ?? asAssetRef(item['source'])
      if (asset !== null) {
        const name = typeof item['name'] === 'string' ? (item['name'] as string) : null
        parts.push(assetPart(type, asset, name))
      }
      continue
    }
    // 展示专用 part（工具卡 / 推理块）：只给 UI 渲染，不进模型上下文；
    // 工具调用与结果对模型的可见性由 `extra_messages` 回灌（tool_calls / tool_call_id）保证。
    if (type === 'tool' || type === 'reasoning') continue
    if (type === 'tool_call' || type === 'tool_use') hasToolCall = true
    parts.push(textPart(JSON.stringify(item)))
  }
  return { parts, hasToolCall }
}

/** 解析附件：可解析 `text` 内联；二进制只留资产引用。 */
export function parseAttachments(value: unknown): CanonicalPart[] {
  if (!Array.isArray(value)) return []
  const parts: CanonicalPart[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const kindRaw = typeof item['kind'] === 'string' ? (item['kind'] as string) : 'file'
    const kind = kindRaw === 'image' || kindRaw === 'audio' ? kindRaw : 'file'
    const name = typeof item['name'] === 'string' ? (item['name'] as string) : null
    if (typeof item['text'] === 'string') {
      const header = name !== null ? `[附件 ${name}]\n` : ''
      parts.push(textPart(`${header}${item['text'] as string}`))
      continue
    }
    const asset = asAssetRef(item['source']) ?? asAssetRef(item['asset'])
    if (asset !== null) parts.push(assetPart(kind, asset, name))
  }
  return parts
}

/** 解析一条带 parts / attachments 的消息体。 */
export function messageParts(body: Record<string, unknown>): ParsedParts {
  const parsed = parseRawParts(body['parts'])
  const parts = parsed.parts.slice()
  // 展示专用 part 被丢弃后可能为空；此时仅在 content 非空时回落正文（空正文不留空消息）。
  if (parts.length === 0 && typeof body['content'] === 'string' && (body['content'] as string).length > 0) {
    parts.push(textPart(body['content'] as string))
  }
  return { parts: parts.concat(parseAttachments(body['attachments'])), hasToolCall: parsed.hasToolCall }
}

export function normalizeRole(value: unknown): Role {
  return value === 'assistant' || value === 'system' || value === 'tool' ? value : 'user'
}

/** 为历史消息标记 atomic 组（工具调用 + 结果成对，同生共死）。 */
export function atomicGroups(
  entries: { parts: CanonicalPart[]; role: Role; hasToolCall: boolean }[],
): (number | null)[] {
  const groups = new Array<number | null>(entries.length).fill(null)
  let currentGroup: number | null = null
  let nextGroup = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as { parts: CanonicalPart[]; role: Role; hasToolCall: boolean }
    if (entry.role === 'assistant' && entry.hasToolCall) {
      currentGroup = nextGroup
      nextGroup += 1
      groups[index] = currentGroup
      continue
    }
    if (entry.role === 'tool') {
      if (currentGroup === null) {
        currentGroup = nextGroup
        nextGroup += 1
      }
      groups[index] = currentGroup
      continue
    }
    currentGroup = null
  }
  return groups
}

export interface HistoryPlan {
  chain: { hash: string; body: Record<string, unknown> }[]
  coveredUpto: string | null
  coveredIndex: number
  l1Valid: boolean
}

/** 沿 `prev` 链还原历史（从 head 逆序），并定位 covered_upto 边界。 */
export function planHistory(bag: Record<string, unknown>): HistoryPlan {
  const session = isRecord(bag['session']) ? bag['session'] : {}
  const refsRaw = isRecord(session['refs']) ? session['refs'] : {}
  const refs = new Map<string, Record<string, unknown>>()
  for (const [hash, body] of Object.entries(refsRaw)) {
    if (isRecord(body)) refs.set(hash, body)
  }
  const memories = isRecord(bag['memories']) ? bag['memories'] : {}
  const l1 = isRecord(memories['l1']) ? memories['l1'] : {}
  const coveredUpto =
    typeof l1['covered_upto'] === 'string' && (l1['covered_upto'] as string).length > 0
      ? (l1['covered_upto'] as string)
      : null

  if (refs.size === 0) {
    return { chain: [], coveredUpto, coveredIndex: -1, l1Valid: true }
  }

  // `head` 是当前会话的链头：为空 = 本会话尚无消息（历史为空）；非空但不在 `refs` = 投影不一致。
  // **绝不**在 refs 里猜链头——`session.refs` 是会话级全量（含其它会话的消息），猜会把别的会话历史当本会话历史。
  const head = typeof session['head'] === 'string' ? (session['head'] as string) : null
  if (head === null || !refs.has(head)) {
    return { chain: [], coveredUpto, coveredIndex: -1, l1Valid: coveredUpto === null }
  }

  const reversed: { hash: string; body: Record<string, unknown> }[] = []
  const visited = new Set<string>()
  let cursor: string | null = head
  while (cursor !== null && refs.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor)
    const body = refs.get(cursor) as Record<string, unknown>
    reversed.push({ hash: cursor, body })
    const prev = isRecord(body['prev']) ? body['prev'] : null
    cursor = prev !== null && typeof prev['def'] === 'string' ? (prev['def'] as string) : null
  }
  const chain = reversed.reverse()

  let coveredIndex = -1
  let l1Valid = true
  if (coveredUpto !== null) {
    const found = chain.findIndex((entry) => entry.body['id'] === coveredUpto)
    if (found >= 0) coveredIndex = found
    else l1Valid = false
  }
  return { chain, coveredUpto, coveredIndex, l1Valid }
}
