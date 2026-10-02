// 方言 wire 编形的纯原语：解析方言（protocol / system 角色 / 输入模态）后，把厂商中立 content part
// 编成 openai-chat / openai-responses / anthropic-messages 的线格式。
// 该分支属协议语义；两端（上下文装配的中立 part 编形与协议层消费）共用同一实现，避免各自分支漂移。
// 零内核零宿主依赖；模态降级文案由调用方按 policy 注入（本模块只决定“是否支持 / 编成什么形状”）。

import { isRecord } from './json.ts'
import type { Json } from './json.ts'

/** 支持的模型方言。 */
export type Dialect = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export const DIALECTS: readonly Dialect[] = [
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
]

/** 二进制资产引用（只传引用，不进组装字节）。 */
export interface NeutralAssetRef {
  sha256: string
  mime: string
  size?: number
}

/** 中立 content part：文本，或带资产引用的多模态 part。 */
export type NeutralPart =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio' | 'file'; asset: NeutralAssetRef; name: string | null }

/** 由调用方 config 解析出的方言上下文。 */
export interface DialectFormat {
  dialect: Dialect
  systemRole: string
  maxTokensField: string
  inputModalities: string[] | null
}

/** 解析方言 / system 角色 / max_tokens 字段 / 支持的输入模态；缺省回落 openai-chat 与保守默认。 */
export function resolveDialectFormat(config: Record<string, unknown> | null): DialectFormat {
  const quirks = isRecord(config?.['quirks']) ? (config?.['quirks'] as Record<string, unknown>) : {}
  const explicitProtocol =
    typeof config?.['protocol'] === 'string' ? (config?.['protocol'] as string) : null
  const quirkProtocol = typeof quirks['protocol'] === 'string' ? (quirks['protocol'] as string) : null
  const candidate = explicitProtocol ?? quirkProtocol
  const dialect = (DIALECTS as readonly string[]).includes(candidate ?? '')
    ? (candidate as Dialect)
    : 'openai-chat'
  const systemRole =
    typeof quirks['system_role'] === 'string' ? (quirks['system_role'] as string) : 'system'
  const maxTokensField =
    typeof quirks['max_tokens_field'] === 'string'
      ? (quirks['max_tokens_field'] as string)
      : 'max_tokens'
  const modalities = isRecord(config?.['modalities'])
    ? (config?.['modalities'] as Record<string, unknown>)
    : null
  const input = modalities !== null && Array.isArray(modalities['input']) ? modalities['input'] : null
  const inputModalities =
    input === null ? null : input.filter((item): item is string => typeof item === 'string')
  return { dialect, systemRole, maxTokensField, inputModalities }
}

/** 该模态是否被模型支持（未声明输入模态时视为全支持）。 */
export function partSupported(format: DialectFormat, kind: string): boolean {
  if (format.inputModalities === null) return true
  return format.inputModalities.includes(kind)
}

function assetName(part: Extract<NeutralPart, { asset: NeutralAssetRef }>): string {
  return part.name ?? part.asset.sha256.slice(0, 8)
}

/** 不支持该模态时由调用方给出的降级文本。 */
export type PartFallback = (part: Extract<NeutralPart, { asset: NeutralAssetRef }>) => string

function openAiChatParts(
  parts: NeutralPart[],
  format: DialectFormat,
  fallback: PartFallback,
): Json[] {
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
      continue
    }
    if (!partSupported(format, part.type)) {
      result.push({ type: 'text', text: fallback(part) })
      continue
    }
    if (part.type === 'image') {
      result.push({ type: 'image_url', image_url: { url: `asset:${part.asset.sha256}` } })
    } else if (part.type === 'audio') {
      result.push({
        type: 'input_audio',
        input_audio: { asset: { sha256: part.asset.sha256, mime: part.asset.mime } },
      })
    } else {
      result.push({
        type: 'file',
        file: {
          asset: { sha256: part.asset.sha256, mime: part.asset.mime },
          name: assetName(part),
        },
      })
    }
  }
  return result
}

function openAiResponsesParts(
  parts: NeutralPart[],
  role: string,
  format: DialectFormat,
  fallback: PartFallback,
): Json[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: textType, text: part.text })
      continue
    }
    if (!partSupported(format, part.type)) {
      result.push({ type: textType, text: fallback(part) })
      continue
    }
    if (part.type === 'image') {
      result.push({ type: 'input_image', image_url: `asset:${part.asset.sha256}` })
    } else if (part.type === 'audio') {
      result.push({
        type: 'input_audio',
        input_audio: { asset: { sha256: part.asset.sha256, mime: part.asset.mime } },
      })
    } else {
      result.push({
        type: 'input_file',
        file: {
          asset: { sha256: part.asset.sha256, mime: part.asset.mime },
          name: assetName(part),
        },
      })
    }
  }
  return result
}

function anthropicParts(
  parts: NeutralPart[],
  format: DialectFormat,
  fallback: PartFallback,
): Json[] {
  const result: Json[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
      continue
    }
    if (!partSupported(format, part.type)) {
      result.push({ type: 'text', text: fallback(part) })
      continue
    }
    const source: Json = { type: 'asset', sha256: part.asset.sha256, mime: part.asset.mime }
    const type = part.type === 'image' ? 'image' : part.type === 'audio' ? 'audio' : 'document'
    result.push({ type, source })
  }
  return result
}

/** 按方言把中立 part 编成线格式 content（不支持该模态的部分由 `fallback` 给降级文本）。 */
export function formatDialectParts(
  parts: NeutralPart[],
  role: string,
  format: DialectFormat,
  fallback: PartFallback,
): Json[] {
  if (format.dialect === 'openai-chat') return openAiChatParts(parts, format, fallback)
  if (format.dialect === 'openai-responses')
    return openAiResponsesParts(parts, role, format, fallback)
  return anthropicParts(parts, format, fallback)
}

/** 组装模型参数（供调用方对齐请求输出上限）：模型名 / 输出上限 / 输出字段名。 */
export function buildModelParams(
  config: Record<string, unknown> | null,
  maxOutput: number,
): Record<string, Json> {
  const format = resolveDialectFormat(config)
  const model = typeof config?.['model'] === 'string' ? (config['model'] as string) : 'unknown'
  return { model, max_output: maxOutput, max_tokens_field: format.maxTokensField }
}
