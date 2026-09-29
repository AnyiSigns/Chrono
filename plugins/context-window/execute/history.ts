// 消息体 / 附件 / parts 的宽松解析，以及工具调用 atomic 组标记。
// 历史候选不再沿 `prev` 链还原（真源是会话回合日志）；本模块只做展示载荷的机械解析（本轮输入 /
// 用户附件）与规范消息的原子分组。

import { asAssetRef, isRecord } from './text.ts'
import type { AssetRef, CanonicalPart, Json, Role } from './types.ts'

/** 历史展示 part `{type:'tool'}` 携带的调用与结果（跨回合回灌用）。 */
export interface ParsedToolCall {
  callId: string
  tool: string
  args: Json
  result: Json | null
  /** `ok` / `error` / `null`（挂起未决）。 */
  status: string | null
}

export interface ParsedParts {
  parts: CanonicalPart[]
  hasToolCall: boolean
  toolParts: ParsedToolCall[]
}

function textPart(text: string): CanonicalPart {
  return { type: 'text', text }
}

function assetPart(kind: 'image' | 'audio' | 'file', asset: AssetRef, name: string | null): CanonicalPart {
  return { type: kind, asset, name }
}

/** 宽松解析 parts：文本 / 资产 / 工具 part；工具 part 另作结构化调用（跨回合回灌），推理块跨回合丢弃。 */
export function parseRawParts(value: unknown): ParsedParts {
  if (typeof value === 'string') return { parts: [textPart(value)], hasToolCall: false, toolParts: [] }
  if (!Array.isArray(value)) return { parts: [], hasToolCall: false, toolParts: [] }
  const parts: CanonicalPart[] = []
  const toolParts: ParsedToolCall[] = []
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
    // 展示用工具卡（commit-parts 落盘）：提升为可回灌的调用 + 结果，跨回合不再消失。
    if (type === 'tool') {
      const callId = typeof item['call_id'] === 'string' ? (item['call_id'] as string) : null
      if (callId === null) continue
      const tool = typeof item['tool'] === 'string' ? (item['tool'] as string) : ''
      const status = typeof item['status'] === 'string' ? (item['status'] as string) : null
      toolParts.push({
        callId,
        tool,
        args: (item['args'] ?? null) as Json,
        result: (item['result'] ?? null) as Json,
        status,
      })
      hasToolCall = true
      continue
    }
    // 推理块：跨回合默认丢弃（只留结论），不注入模型上下文。
    if (type === 'reasoning') continue
    if (type === 'tool_call' || type === 'tool_use') hasToolCall = true
    parts.push(textPart(JSON.stringify(item)))
  }
  return { parts, hasToolCall, toolParts }
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
  return {
    parts: parts.concat(parseAttachments(body['attachments'])),
    hasToolCall: parsed.hasToolCall,
    toolParts: parsed.toolParts,
  }
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

