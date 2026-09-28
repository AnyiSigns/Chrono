// 厂商中立推理：不透明块（产出侧捕获，回传侧按能力表编回）与推理能力表。
// 能力表按「协议默认 + 厂商覆盖」解析；档案（profile）把解析结果写进 config 模型条目。
// 规则以本仓代码 / 厂商模板 / 设计清单为据；无依据者取保守值（不回传、不发思考参数）。
// 未能独立核实的条目显式标注 verified=false，供调用方与后续核实。
// 中立块形状固定：{provider, model, form, payload, signature, encrypted, tokens}——字段不得增减。

import { isRecord } from './plan.ts'
import type { Json, Rec } from 'plugin-sdk'

export type ReasoningRetention = 'none' | 'turn' | 'session'
export type ReasoningForm = 'text' | 'blocks'
/** 回传线格式：Anthropic 内容块 / OpenAI 兼容 reasoning_content / Gemini parts / Responses 推理项。null = 不回传。 */
export type ReasoningReplayForm = 'thinking_block' | 'reasoning_content' | 'parts' | 'reasoning_item' | null

export interface ReasoningCapability {
  /** 保留范围：none 不回传也不发思考参数；turn 仅回合内；session 可跨回合。 */
  retention: ReasoningRetention
  /** 工具循环内必须原样回传（违反即 400）。 */
  requires_replay_in_tool_loop: boolean
  /** 签名在回包里的字段名；null = 无签名。 */
  signature_field: string | null
  /** 回传线格式；null = 不回传。 */
  replay_form: ReasoningReplayForm
  /** 使已捕获签名失效的变更。 */
  invalidated_by: string[]
  /** 规则是否可由本仓代码 / 厂商模板核实；false 即保守默认。 */
  verified: boolean
  note?: string
}

export interface ReasoningBlock {
  provider: string
  model: string
  form: ReasoningForm
  payload: string
  signature: string
  encrypted: string
  tokens: number
}

const INVALIDATED_BY_DEFAULT = ['model_change', 'prefix_change', 'thinking_param_change']

/** 未知厂商 / 协议的兜底：不回传、不发思考参数。 */
const CONSERVATIVE: ReasoningCapability = {
  retention: 'none',
  requires_replay_in_tool_loop: false,
  signature_field: null,
  replay_form: null,
  invalidated_by: [...INVALIDATED_BY_DEFAULT],
  verified: false,
  note: '厂商规则不可核实：保守默认，不回传、不发思考参数',
}

const OPENAI_CHAT: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: false,
  signature_field: null,
  replay_form: null,
  invalidated_by: [...INVALIDATED_BY_DEFAULT],
  verified: false,
  note: '推理文本按厂商字段可观测；回传规则不可核实，故不回传',
}

const OPENAI_RESPONSES: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: false,
  signature_field: 'encrypted_content',
  replay_form: 'reasoning_item',
  invalidated_by: [...INVALIDATED_BY_DEFAULT],
  verified: false,
  note: '推理摘要与回包对称解析；仅当捕获到加密内容时按推理项回传，无加密则丢弃',
}

const ANTHROPIC_MESSAGES: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: true,
  signature_field: 'signature',
  replay_form: 'thinking_block',
  invalidated_by: ['model_change', 'thinking_param_change', 'prefix_change'],
  verified: true,
  note: '带签名的 thinking 块（含 redacted_thinking）在工具循环内必须原样回传',
}

const GOOGLE_SDK: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: true,
  signature_field: 'thoughtSignature',
  replay_form: 'parts',
  invalidated_by: ['model_change', 'prefix_change'],
  verified: true,
  note: 'thought signature 随当前步首个 functionCall part 回传',
}

const DEEPSEEK: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: true,
  signature_field: null,
  replay_form: 'reasoning_content',
  invalidated_by: [...INVALIDATED_BY_DEFAULT],
  verified: true,
  note: '思考模式带 tools 时 reasoning_content 必须回传',
}

const KIMI: ReasoningCapability = {
  retention: 'turn',
  requires_replay_in_tool_loop: true,
  signature_field: null,
  replay_form: 'reasoning_content',
  invalidated_by: [...INVALIDATED_BY_DEFAULT],
  verified: false,
  note: '保留思考经 reasoning_content 回传；厂商模板未声明回传字段，规则按设计取，未经本仓核实',
}

const PROTOCOL_CAPABILITY: Record<string, ReasoningCapability> = {
  'openai-chat': OPENAI_CHAT,
  'openai-responses': OPENAI_RESPONSES,
  'anthropic-messages': ANTHROPIC_MESSAGES,
}

const PROVIDER_CAPABILITY: Record<string, ReasoningCapability> = {
  deepseek: DEEPSEEK,
  anthropic: ANTHROPIC_MESSAGES,
  google: GOOGLE_SDK,
  'google-genai': GOOGLE_SDK,
  kimi: KIMI,
  moonshot: KIMI,
}

export interface CapabilityInput {
  /** config.vendor（或模型名）；用于厂商覆盖。 */
  provider?: string | null
  protocol?: string | null
  impl?: string | null
  /** 档案里已有的能力表（调用方显式提供时优先）。 */
  profile?: Json
}

function isCapability(value: Json | undefined): value is Rec {
  if (!isRecord(value)) return false
  const retention = value['retention']
  return retention === 'none' || retention === 'turn' || retention === 'session'
}

function asReplayForm(value: Json): ReasoningReplayForm {
  if (value === 'thinking_block' || value === 'reasoning_content' || value === 'parts' || value === 'reasoning_item') {
    return value
  }
  return null
}

function fromProfile(value: Rec): ReasoningCapability {
  const retention = value['retention']
  const invalidated = Array.isArray(value['invalidated_by'])
    ? (value['invalidated_by'] as Json[]).filter((item): item is string => typeof item === 'string')
    : [...INVALIDATED_BY_DEFAULT]
  return {
    retention: (retention === 'none' || retention === 'session' ? retention : 'turn') as ReasoningRetention,
    requires_replay_in_tool_loop: value['requires_replay_in_tool_loop'] === true,
    signature_field: typeof value['signature_field'] === 'string' ? (value['signature_field'] as string) : null,
    replay_form: asReplayForm(value['replay_form']),
    invalidated_by: invalidated,
    verified: value['verified'] === true,
    ...(typeof value['note'] === 'string' ? { note: value['note'] as string } : {}),
  }
}

function providerKey(provider: string | null | undefined): string | null {
  if (typeof provider !== 'string' || provider.length === 0) return null
  const stripped = provider.replace(/^vendor-/, '')
  return stripped.length === 0 ? null : stripped.toLowerCase()
}

/** 解析本次调用适用的推理能力表：显式档案 > 厂商覆盖 > SDK 默认 > 协议默认 > 保守默认。 */
export function resolveReasoningCapability(input: CapabilityInput): ReasoningCapability {
  if (isCapability(input.profile)) return fromProfile(input.profile as Rec)
  const key = providerKey(input.provider)
  if (key !== null) {
    const override = PROVIDER_CAPABILITY[key]
    if (override !== undefined) return override
  }
  if (input.impl === 'sdk') return GOOGLE_SDK
  const protocol = typeof input.protocol === 'string' ? input.protocol : ''
  const byProtocol = PROTOCOL_CAPABILITY[protocol]
  if (byProtocol !== undefined) return byProtocol
  return CONSERVATIVE
}

/** 本次调用是否应发送思考 / 推理请求参数（retention=none 一律不发）。 */
export function sendsReasoningParam(capability: ReasoningCapability): boolean {
  return capability.retention !== 'none'
}

/** 构造中立块（全字段就位）。 */
export function reasoningBlock(
  provider: string,
  model: string,
  form: ReasoningForm,
  payload: string,
  signature = '',
  encrypted = '',
  tokens = 0,
): ReasoningBlock {
  return { provider, model, form, payload, signature, encrypted, tokens }
}

function isReasoningBlock(value: Json | undefined): value is Rec {
  if (!isRecord(value)) return false
  const form = value['form']
  if (form !== 'text' && form !== 'blocks') return false
  return typeof value['payload'] === 'string'
}

function normalizeBlock(value: Json): ReasoningBlock | null {
  if (!isReasoningBlock(value)) return null
  const record = value as Rec
  return {
    provider: typeof record['provider'] === 'string' ? (record['provider'] as string) : '',
    model: typeof record['model'] === 'string' ? (record['model'] as string) : '',
    form: record['form'] as ReasoningForm,
    payload: record['payload'] as string,
    signature: typeof record['signature'] === 'string' ? (record['signature'] as string) : '',
    encrypted: typeof record['encrypted'] === 'string' ? (record['encrypted'] as string) : '',
    tokens: typeof record['tokens'] === 'number' ? (record['tokens'] as number) : 0,
  }
}

/** 从消息字段读中立块：接受 `reasoning_blocks` 数组 / 单块，或 `reasoning` 上的中立块。 */
export function readReasoningBlocks(message: Rec): ReasoningBlock[] {
  const candidates: Json[] = []
  const explicit = message['reasoning_blocks']
  if (Array.isArray(explicit)) candidates.push(...(explicit as Json[]))
  else if (explicit !== undefined) candidates.push(explicit)
  const legacy = message['reasoning']
  if (isRecord(legacy)) candidates.push(legacy)
  else if (Array.isArray(legacy)) candidates.push(...(legacy as Json[]))
  const blocks: ReasoningBlock[] = []
  for (const candidate of candidates) {
    const block = normalizeBlock(candidate)
    if (block !== null) blocks.push(block)
  }
  return blocks
}

/** 签名绑定产出模型：模型或厂商不同即视为跨族，签名作废。 */
export function sameModelFamily(block: ReasoningBlock, provider: string, model: string): boolean {
  if (block.model !== model) return false
  if (block.provider.length > 0 && provider.length > 0 && block.provider !== provider) return false
  return true
}

/** 过滤出可回传的块：跨模型 / 缺签名（厂商要求签名时）一律丢弃。 */
export function replayableBlocks(
  blocks: ReasoningBlock[],
  capability: ReasoningCapability,
  provider: string,
  model: string,
): ReasoningBlock[] {
  if (capability.replay_form === null || capability.retention === 'none') return []
  return blocks.filter((block) => {
    if (!sameModelFamily(block, provider, model)) return false
    if (capability.signature_field !== null && block.signature.length === 0 && block.encrypted.length === 0) return false
    return true
  })
}

/** 归一能力表为可写进档案的 JSON。 */
export function capabilityToJson(capability: ReasoningCapability): Rec {
  const out: Rec = {
    retention: capability.retention,
    requires_replay_in_tool_loop: capability.requires_replay_in_tool_loop,
    signature_field: capability.signature_field,
    replay_form: capability.replay_form,
    invalidated_by: capability.invalidated_by,
    verified: capability.verified,
  }
  if (capability.note !== undefined) out['note'] = capability.note
  return out
}
