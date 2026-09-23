// 流水线第 8 步：按方言编 content parts（openai-chat / openai-responses / anthropic-messages）。
// vendor `sdk` / `quirks` / 自定义 `protocol` 由 `bag.config` 携带；多模态按模型 `modalities.input` 编 part，
// 不支持该模态 → 降级为文本引用 + flags `modality_dropped`。二进制只传资产引用，不进字节。

import { fillTemplate, isRecord } from './text.ts'
import type { AssetRef, CanonicalMessage, CanonicalPart, Json, Policy } from './types.ts'

export type Dialect = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

const DIALECTS: Dialect[] = ['openai-chat', 'openai-responses', 'anthropic-messages']

export interface FormatContext {
  dialect: Dialect
  systemRole: string
  maxTokensField: string
  inputModalities: string[] | null
}

/** 解析方言 / system 角色 / max_tokens 字段 / 支持的输入模态。 */
export function resolveFormatContext(config: Record<string, unknown> | null): FormatContext {
  const quirks = isRecord(config?.['quirks']) ? (config?.['quirks'] as Record<string, unknown>) : {}
  const explicitProtocol = typeof config?.['protocol'] === 'string' ? (config?.['protocol'] as string) : null
  const quirkProtocol = typeof quirks['protocol'] === 'string' ? (quirks['protocol'] as string) : null
  const candidate = explicitProtocol ?? quirkProtocol
  const dialect = (DIALECTS as string[]).includes(candidate ?? '')
    ? (candidate as Dialect)
    : 'openai-chat'
  const systemRole = typeof quirks['system_role'] === 'string' ? (quirks['system_role'] as string) : 'system'
  const maxTokensField =
    typeof quirks['max_tokens_field'] === 'string' ? (quirks['max_tokens_field'] as string) : 'max_tokens'
  const modalities = isRecord(config?.['modalities']) ? (config?.['modalities'] as Record<string, unknown>) : null
  const input = modalities !== null && Array.isArray(modalities['input']) ? modalities['input'] : null
  const inputModalities =
    input === null ? null : input.filter((item): item is string => typeof item === 'string')
  return { dialect, systemRole, maxTokensField, inputModalities }
}

function modalitySupported(context: FormatContext, kind: string): boolean {
  if (context.inputModalities === null) return true
  return context.inputModalities.includes(kind)
}

function assetName(part: Extract<CanonicalPart, { asset: AssetRef }>): string {
  return part.name ?? part.asset.sha256.slice(0, 8)
}

/** 不支持该模态 → 文本引用 part；返回 null 表示支持。 */
function dropPart(
  part: Extract<CanonicalPart, { asset: AssetRef }>,
  context: FormatContext,
  policy: Policy,
): { type: 'text'; text: string } | null {
  if (modalitySupported(context, part.type)) return null
  return {
    type: 'text',
    text: fillTemplate(policy.modality_fallback.text_template, {
      kind: part.type,
      name: assetName(part),
      mime: part.asset.mime,
    }),
  }
}

interface FormattedMessage {
  role: string
  content: Json
  tool_call_id?: string
  tool_calls?: Json
}

function textOnly(parts: CanonicalPart[]): boolean {
  return parts.every((part) => part.type === 'text')
}

function joinedText(parts: CanonicalPart[]): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function openAiChatParts(parts: CanonicalPart[], context: FormatContext, policy: Policy): Json[] {
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
      continue
    }
    const dropped = dropPart(part, context, policy)
    if (dropped !== null) {
      result.push(dropped)
      continue
    }
    if (part.type === 'image') {
      result.push({ type: 'image_url', image_url: { url: `asset:${part.asset.sha256}` } })
    } else if (part.type === 'audio') {
      result.push({ type: 'input_audio', input_audio: { asset: { sha256: part.asset.sha256, mime: part.asset.mime } } })
    } else {
      result.push({
        type: 'file',
        file: { asset: { sha256: part.asset.sha256, mime: part.asset.mime }, name: assetName(part) },
      })
    }
  }
  return result
}

function openAiResponsesParts(parts: CanonicalPart[], role: string, context: FormatContext, policy: Policy): Json[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: textType, text: part.text })
      continue
    }
    const dropped = dropPart(part, context, policy)
    if (dropped !== null) {
      result.push({ type: textType, text: dropped.text })
      continue
    }
    if (part.type === 'image') {
      result.push({ type: 'input_image', image_url: `asset:${part.asset.sha256}` })
    } else if (part.type === 'audio') {
      result.push({ type: 'input_audio', input_audio: { asset: { sha256: part.asset.sha256, mime: part.asset.mime } } })
    } else {
      result.push({
        type: 'input_file',
        file: { asset: { sha256: part.asset.sha256, mime: part.asset.mime }, name: assetName(part) },
      })
    }
  }
  return result
}

function anthropicParts(parts: CanonicalPart[], context: FormatContext, policy: Policy): Json[] {
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
      continue
    }
    const dropped = dropPart(part, context, policy)
    if (dropped !== null) {
      result.push(dropped)
      continue
    }
    const source: Json = { type: 'asset', sha256: part.asset.sha256, mime: part.asset.mime }
    const type = part.type === 'image' ? 'image' : part.type === 'audio' ? 'audio' : 'document'
    result.push({ type, source })
  }
  return result
}

/**
 * 方言化消息列。`dropped` 记录被降级的模态（调用方据此加 `modality_dropped` flag）。
 */
export function formatMessages(
  messages: CanonicalMessage[],
  config: Record<string, unknown> | null,
  policy: Policy,
): { messages: Json[]; dropped: boolean } {
  const context = resolveFormatContext(config)
  let dropped = false
  const formatted: Json[] = []

  for (const message of messages) {
    const role = message.role === 'system' ? context.systemRole : message.role
    const containsAsset = message.parts.some((part) => part.type !== 'text')
    if (containsAsset) {
      for (const part of message.parts) {
        if (part.type !== 'text' && dropPart(part, context, policy) !== null) dropped = true
      }
    }
    let formattedMessage: FormattedMessage
    if (context.dialect === 'openai-chat') {
      const content: Json = textOnly(message.parts) ? joinedText(message.parts) : openAiChatParts(message.parts, context, policy)
      formattedMessage = { role, content }
    } else if (context.dialect === 'openai-responses') {
      formattedMessage = { role, content: openAiResponsesParts(message.parts, role, context, policy) }
    } else {
      const anthropicRole = message.role === 'tool' ? 'user' : role
      formattedMessage = { role: anthropicRole, content: anthropicParts(message.parts, context, policy) }
    }
    if (message.role === 'tool' && message.toolCallId !== null) {
      formattedMessage.tool_call_id = message.toolCallId
    }
    // assistant 的工具调用：中性形状原样上提，由协议层（model-protocol）按方言编成厂商字段。
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      formattedMessage.tool_calls = message.toolCalls
    }
    formatted.push(formattedMessage as unknown as Json)
  }

  return { messages: formatted, dropped }
}

/** 组装 params（max_output 等）。 */
export function buildParams(
  config: Record<string, unknown> | null,
  maxOutput: number,
): Record<string, Json> {
  const context = resolveFormatContext(config)
  const model = typeof config?.['model'] === 'string' ? (config['model'] as string) : 'unknown'
  return { model, max_output: maxOutput, max_tokens_field: context.maxTokensField }
}
