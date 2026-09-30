// 流水线分层保留阶段（按回合距离，不按消息条数）：T0 逐字 / T1 摘要 + 句柄 / T2 结果丢弃 + 句柄保留。
// 附替代去重：同一 (工具, 资源身份) 多次读取只留最后一份完整内容，早前塌成「已被第 N 步替代」，句柄保留。
// 核心是「可还原压缩」：被压掉的内容都留句柄，模型可用工具重取。全部确定，不取时间、不随机。

import {
  agedAttachmentText,
  ageMessage,
  dropResultText,
  oversizedUserText,
  parseResultContent,
  replacedResultText,
  rewriteResultText,
} from './aging.ts'
import { isMutableResult, resourceIdentity } from './digest.ts'
import { applyScale, computeContentKey, computeDedupKey, computeTokenKey, countParts, fillTemplate, partsText } from './text.ts'
import type { CanonicalMessage, CanonicalPart, Json, RetentionTier, ToolResultMeta } from './types.ts'

export interface RetentionOptions {
  /** 回合 id → 距最新回合的距离。 */
  distances: Map<string, number>
  /** 工具调用 id → 落账步号（替代标记引用真实步号）。 */
  callStep: Map<string, number>
  /** T1 近期回合数。 */
  recentTurns: number
  /** 大产物字节阈值：达到即无论层级都以「摘要 + 句柄」表示，不内联；0 = 关闭。 */
  largeArtifactBytes: number
  /** 用户消息超大粘贴阈值（码点）：达到即首尾 + 句柄替代；0 = 关闭。 */
  oversizedUserChars: number
  /** 每模型 token 校正系数：改写路径重算 token 时与之同口径。 */
  scale: number
  /** T1 系统错误一行形态模板（`{error}` 占位）。 */
  errorLine: string
}

export interface RetentionResult {
  messages: CanonicalMessage[]
  counts: Record<RetentionTier, number>
  /** 因替代去重被塌缩的工具结果条数。 */
  replaced: number
  degraded: string[]
}

function emptyCounts(): Record<RetentionTier, number> {
  return { T0: 0, T1: 0, T2: 0 }
}

/** 消息的保留等级。非历史来源（本轮输入 / 同回合 iter 产物 / 系统提示）恒为 T0。 */
export function tierOf(message: CanonicalMessage, options: RetentionOptions): RetentionTier {
  if (message.source !== 'history') return 'T0'
  const turnId = message.turnId ?? null
  if (turnId === null) return 'T1'
  const distance = options.distances.get(turnId)
  if (distance === undefined) return 'T1'
  if (distance <= 0) return 'T0'
  return distance < options.recentTurns ? 'T1' : 'T2'
}

/** 历史附件折叠：二进制 part 换成「文本描述 + 句柄」；文本 part 原样保留。 */
function ageAttachmentParts(message: CanonicalMessage, scale: number): CanonicalMessage {
  if (!message.parts.some((part) => part.type !== 'text')) return message
  const parts: CanonicalPart[] = message.parts.map((part) =>
    part.type === 'text' ? part : { type: 'text', text: agedAttachmentText(part.type, part.asset, part.name) },
  )
  const tokenKey = computeTokenKey(parts)
  return {
    ...message,
    parts,
    tokenKey,
    tokens: applyScale(countParts(parts, tokenKey), scale) + message.toolCallTokens + message.reasoningTokens,
    dedupKey: computeDedupKey(message.role, parts),
    contentKey: computeContentKey(parts),
  }
}

/** 大产物判定：结果串字节数达到阈值即不内联（摘要 + 句柄替代）。 */
function isLargeArtifact(message: CanonicalMessage, threshold: number): boolean {
  const meta = metaOf(message)
  if (meta === null) return false
  return Buffer.byteLength(meta.verbatim, 'utf8') >= threshold
}

function metaOf(message: CanonicalMessage): ToolResultMeta | null {
  return message.toolResult ?? null
}

/**
 * 替代去重：同一 (工具, 资源身份) 的多次读取只留最后一份完整内容，更早的塌成「已被第 N 步替代」。
 * 只作用于可还原的读类结果（变更类结果改写资源，塌缩会丢事实，跳过）。
 */
function replacementDedupe(
  messages: CanonicalMessage[],
  callStep: Map<string, number>,
  scale: number,
): { messages: CanonicalMessage[]; replaced: number } {
  // 确定序号：真实步号优先，否则按正向顺序的 1 基序号。
  const ordinal = new Map<CanonicalMessage, number>()
  let counter = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    counter += 1
    ordinal.set(message, counter)
  }

  const seen = new Map<string, { step: number; fields: Record<string, string> }>()
  let replaced = 0
  const processed = new Map<CanonicalMessage, CanonicalMessage>()
  // 新 → 旧：首次出现的（最新）保留完整，其后（更早）同身份者塌缩。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as CanonicalMessage
    if (message.role !== 'tool' || message.toolCallId === null) continue
    // 只优化跨回合历史：本轮 / 同回合工作集（T0，含 extra_messages 的调用内结果）绝不塌缩，
    // 否则模型在当次推理链里就丢掉刚读到的正文，于是反复重读。
    if (message.source !== 'history') continue
    const meta = metaOf(message)
    if (meta === null) continue
    const parsed = parseResultContent(meta.verbatim)
    if (parsed === null || isMutableResult(meta.tool, parsed.value, parsed.ok)) continue
    const identity = resourceIdentity(meta.tool, meta.args)
    if (identity === null) continue
    const existing = seen.get(identity.key)
    if (existing === undefined) {
      const step = message.step ?? callStep.get(message.toolCallId) ?? ordinal.get(message) ?? 0
      seen.set(identity.key, { step, fields: identity.fields })
      continue
    }
    replaced += 1
    processed.set(
      message,
      rewriteResultText(message, replacedResultText(meta.tool, meta.args, message.toolCallId, existing.step, existing.fields), scale),
    )
  }

  if (processed.size === 0) return { messages, replaced: 0 }
  return { messages: messages.map((message) => processed.get(message) ?? message), replaced }
}

/** 对工具消息按等级改写：T1 老化（摘要 + 句柄），T2 只留句柄。 */
function applyToolTier(message: CanonicalMessage, tier: 'T1' | 'T2', scale: number): CanonicalMessage {
  const meta = metaOf(message)
  if (meta === null) return message
  const parsed = parseResultContent(meta.verbatim)
  if (parsed === null) return message
  if (tier === 'T1') return ageMessage(message, scale)
  return rewriteResultText(message, dropResultText(meta.tool, meta.args, message.toolCallId ?? '', parsed.ok), scale)
}

/** 用新的文本 parts 重写一条消息（重算计数 / dedup / content 键）。 */
function rewriteParts(message: CanonicalMessage, parts: CanonicalPart[], scale: number): CanonicalMessage {
  const tokenKey = computeTokenKey(parts)
  return {
    ...message,
    parts,
    tokenKey,
    tokens: applyScale(countParts(parts, tokenKey), scale) + message.toolCallTokens + message.reasoningTokens,
    cacheKey: tokenKey,
    dedupKey: computeDedupKey(message.role, parts),
    contentKey: computeContentKey(parts),
  }
}

/**
 * 超大用户粘贴例外：全文由 session 保存，上下文投影只给首尾 + 句柄（显式标记）。
 * 逐层生效（含 T0 本轮输入）；非超大用户消息原样逐字。阈值 ≤ 0 或不超阈值时原样返回。
 */
function trimOversizedUser(message: CanonicalMessage, threshold: number, scale: number): CanonicalMessage {
  if (message.role !== 'user' || threshold <= 0) return message
  const text = partsText(message.parts)
  if (text.length <= threshold) return message
  const preserved = message.parts.filter((part) => part.type !== 'text')
  return rewriteParts(message, [{ type: 'text', text: oversizedUserText(text) }, ...preserved], scale)
}

/** 系统错误的一行蒸馏：取首行、限长并套 policy 模板；结果确定。 */
function distillErrorLine(error: string, template: string): string {
  const line = error.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  const clipped = line.length > 200 ? `${line.slice(0, 200)}…` : line
  return fillTemplate(template, { error: clipped })
}

/** 系统错误消息按等级改写：T1 / T2 一律一行。 */
function rewriteErrorLine(message: CanonicalMessage, line: string, scale: number): CanonicalMessage {
  return rewriteParts(message, [{ type: 'text', text: line }], scale)
}

/**
 * 分层保留主入口：先替代去重，再按等级改写 / 丢弃。
 * 两条内容例外逐层生效：超大用户粘贴（首尾 + 句柄）与系统错误（T0 逐字 / T1+ 一行）。
 */
export function applyRetention(messages: CanonicalMessage[], options: RetentionOptions): RetentionResult {
  const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1
  const oversizedUserChars = typeof options.oversizedUserChars === 'number' ? options.oversizedUserChars : 0
  const errorLine = typeof options.errorLine === 'string' ? options.errorLine : '{error}'
  const counts = emptyCounts()
  for (const message of messages) counts[tierOf(message, options)] += 1

  const dedupe = replacementDedupe(messages, options.callStep, scale)
  const kept: CanonicalMessage[] = []
  let attachmentsAged = false
  let largeArtifactsAged = false
  let oversizedUsers = 0
  let errorsLined = false
  for (const message of dedupe.messages) {
    const tier = tierOf(message, options)
    // 超大用户粘贴例外：逐层（含 T0）以「首尾 + 句柄」替代，全文仍由 session 保存。
    const trimmedUser = trimOversizedUser(message, oversizedUserChars, scale)
    if (trimmedUser !== message) {
      oversizedUsers += 1
      kept.push(trimmedUser)
      continue
    }
    // 系统错误分层：T0 逐字；T1 / T2 一行。
    if (typeof message.error === 'string' && message.error.length > 0) {
      if (tier === 'T0') {
        kept.push(message)
        continue
      }
      errorsLined = true
      kept.push(rewriteErrorLine(message, distillErrorLine(message.error, errorLine), scale))
      continue
    }
    // 超过阈值的大产物：无论层级都以「摘要 + 句柄」表示，不内联（模型可经句柄重取）。
    const large = options.largeArtifactBytes > 0 && isLargeArtifact(message, options.largeArtifactBytes)
    if (large) largeArtifactsAged = true
    if (message.role === 'tool' && message.toolResult !== null) {
      if (tier === 'T2') {
        kept.push(applyToolTier(message, 'T2', scale))
        continue
      }
      if (tier === 'T1' || large) {
        kept.push(applyToolTier(message, 'T1', scale))
        continue
      }
    }
    if (tier === 'T1' || tier === 'T2') {
      const aged = ageAttachmentParts(message, scale)
      if (aged !== message) attachmentsAged = true
      kept.push(aged)
      continue
    }
    kept.push(message)
  }

  const degraded: string[] = []
  if (dedupe.replaced > 0) degraded.push('replacement_dedupe')
  if (largeArtifactsAged) degraded.push('age_large_artifacts')
  if (attachmentsAged) degraded.push('age_attachments')
  if (oversizedUsers > 0) degraded.push('trim_oversized_user')
  if (errorsLined) degraded.push('error_line')
  return { messages: kept, counts, replaced: dedupe.replaced, degraded }
}

/** 供测试：解析一条工具消息的结果值（若有 meta）。 */
export function toolResultValue(message: CanonicalMessage): Json | null {
  const meta = metaOf(message)
  if (meta === null) return null
  const parsed = parseResultContent(meta.verbatim)
  return parsed === null ? null : parsed.value
}
