// 流水线第 8 步：把中立 CanonicalMessage 的 parts 编成请求 content。
// 方言分支（part 形状 / 模态降级）纯原语真源在 `plugin-sdk/dialect-format.ts`；本文件只做
// context-window 特有的角色映射、配对字段上提与 `modality_dropped` 标记，保持输出逐字节不变。
// vendor `sdk` / `quirks` / 自定义 `protocol` 由 `bag.config` 携带；多模态按模型 `modalities.input` 编 part，
// 不支持该模态 → 降级为文本引用 + flags `modality_dropped`。二进制只传资产引用，不进字节。

import { buildModelParams, formatDialectParts, partSupported, resolveDialectFormat } from 'plugin-sdk'
import type { DialectFormat, NeutralAssetRef, NeutralPart } from 'plugin-sdk'
import { fillTemplate } from './text.ts'
import type { CanonicalMessage, CanonicalPart, Json, Policy } from './types.ts'

export type { Dialect, DialectFormat } from 'plugin-sdk'

interface FormattedMessage {
  role: string
  content: Json
  tool_call_id?: string
  tool_calls?: Json
  /** 厂商中立推理块：原样上提，由协议层按方言编形（不在此改写 / 截断）。 */
  reasoning?: Json
}

type AssetPart = Extract<NeutralPart, { asset: NeutralAssetRef }>

function textOnly(parts: CanonicalPart[]): boolean {
  return parts.every((part) => part.type === 'text')
}

function joinedText(parts: CanonicalPart[]): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** 不支持该模态 → 文本引用 part；返回 null 表示支持。 */
function dropPart(
  part: CanonicalPart,
  format: DialectFormat,
  policy: Policy,
): { type: 'text'; text: string } | null {
  if (part.type === 'text' || partSupported(format, part.type)) return null
  return {
    type: 'text',
    text: fillTemplate(policy.modality_fallback.text_template, {
      kind: part.type,
      name: part.name ?? part.asset.sha256.slice(0, 8),
      mime: part.asset.mime,
    }),
  }
}

function fallbackText(part: AssetPart, policy: Policy): string {
  return fillTemplate(policy.modality_fallback.text_template, {
    kind: part.type,
    name: part.name ?? part.asset.sha256.slice(0, 8),
    mime: part.asset.mime,
  })
}

function formatContent(
  parts: CanonicalPart[],
  role: string,
  format: DialectFormat,
  policy: Policy,
): Json {
  if (format.dialect === 'openai-chat' && textOnly(parts)) return joinedText(parts)
  return formatDialectParts(
    parts as NeutralPart[],
    role,
    format,
    (part) => fallbackText(part, policy),
  )
}

/**
 * 方言化消息列。`dropped` 记录被降级的模态（调用方据此加 `modality_dropped` flag）。
 */
export function formatMessages(
  messages: CanonicalMessage[],
  config: Record<string, unknown> | null,
  policy: Policy,
): { messages: Json[]; dropped: boolean } {
  const format = resolveDialectFormat(config)
  let dropped = false
  const formatted: Json[] = []

  for (const message of messages) {
    const role = message.role === 'system' ? format.systemRole : message.role
    for (const part of message.parts) {
      if (dropPart(part, format, policy) !== null) dropped = true
    }
    const mappedRole =
      format.dialect === 'anthropic-messages' && message.role === 'tool' ? 'user' : role
    const formattedMessage: FormattedMessage = {
      role: mappedRole,
      content: formatContent(message.parts, role, format, policy),
    }
    if (message.role === 'tool' && message.toolCallId !== null) {
      formattedMessage.tool_call_id = message.toolCallId
    }
    // assistant 的工具调用：中性形状原样上提，由协议层（model-protocol）按方言编成厂商字段。
    if (
      message.role === 'assistant' &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0
    ) {
      formattedMessage.tool_calls = message.toolCalls
    }
    // assistant 的推理块：厂商中立形态原样上提，由协议层按方言编形。
    if (
      message.role === 'assistant' &&
      message.reasoning !== null &&
      message.reasoning !== undefined
    ) {
      formattedMessage.reasoning = message.reasoning as unknown as Json
    }
    formatted.push(formattedMessage as unknown as Json)
  }

  return { messages: formatted, dropped }
}

/** 组装 params（模型名 / 输出上限 / 输出字段名）。 */
export function buildParams(
  config: Record<string, unknown> | null,
  maxOutput: number,
): Record<string, Json> {
  return buildModelParams(config, maxOutput)
}
