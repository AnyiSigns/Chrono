// 流水线分层保留阶段（按回合距离，不按消息条数）：T0 逐字 / T1 摘要 + 句柄 / T2 压缩 + 结果丢弃 / T3 检查点替代。
// 附替代去重：同一 (工具, 资源身份) 多次读取只留最后一份完整内容，早前塌成「已被第 N 步替代」，句柄保留。
// 核心是「可还原压缩」：被压掉的内容都留句柄，模型可用工具重取。全部确定，不取时间、不随机。

import {
  agedAttachmentText,
  ageMessage,
  dropResultText,
  isAgedAttachmentText,
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
  /** 被检查点覆盖、由检查点替代的回合 id。 */
  coveredTurnIds: Set<string>
  /** 工具调用 id → 落账步号（替代标记引用真实步号）。 */
  callStep: Map<string, number>
  /** T1 近期回合数。 */
  recentTurns: number
  /** T2 正文压缩上限（码点）。 */
  t2TextChars: number
  /** 大产物字节阈值：达到即无论层级都以「摘要 + 句柄」表示，不内联；0 = 关闭。 */
  largeArtifactBytes: number
  /** 用户消息超大粘贴阈值（码点）：达到即首尾 + 句柄替代；0 = 关闭。 */
  oversizedUserChars: number
  /** 每模型 token 校正系数：改写路径重算 token 时与之同口径。 */
  scale: number
  /** T1 系统错误一行形态模板（`{error}` 占位）。 */
  errorLine: string
  /** 蒸馏进检查点的错误列表标题。 */
  errorAvoidHeader: string
}

export interface RetentionResult {
  messages: CanonicalMessage[]
  counts: Record<RetentionTier, number>
  /** 因替代去重被塌缩的工具结果条数。 */
  replaced: number
  /** 因 T3（检查点覆盖）被整条丢弃的消息条数。 */
  dropped: number
  degraded: string[]
}

function emptyCounts(): Record<RetentionTier, number> {
  return { T0: 0, T1: 0, T2: 0, T3: 0 }
}

/** 消息的保留等级。非历史来源（本轮输入 / 同回合 iter 产物 / 系统提示 / 记忆）恒为 T0。 */
export function tierOf(message: CanonicalMessage, options: RetentionOptions): RetentionTier {
  // 非历史先判 T0：同回合记录即使被投影层标了 `covered`（检查点边界落在自身回合内）也不得被 T3 裁掉。
  if (message.source !== 'history') return 'T0'
  // 投影层已判定被检查点边界覆盖（含边界同回合、独立 tool 结果）→ 直接 T3。
  if (message.covered === true) return 'T3'
  const turnId = message.turnId ?? null
  if (turnId !== null && options.coveredTurnIds.has(turnId)) return 'T3'
  if (turnId === null) return 'T1'
  const distance = options.distances.get(turnId)
  if (distance === undefined) return 'T1'
  if (distance <= 0) return 'T0'
  return distance < options.recentTurns ? 'T1' : 'T2'
}

/** 压缩助手正文：取首行、按码点截断并加省略标记；结果确定。 */
export function compressText(text: string, maxChars: number): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  if (line.length <= maxChars) return line
  return `${line.slice(0, Math.max(0, maxChars))}…`
}

/** 去掉推理块并扣掉其 token。 */
function stripReasoning(message: CanonicalMessage): CanonicalMessage {
  if (message.reasoning === null || message.reasoning === undefined) return message
  return {
    ...message,
    reasoning: null,
    reasoningTokens: 0,
    tokens: Math.max(0, message.tokens - message.reasoningTokens),
  }
}

/**
 * 压缩助手正文（保留工具调用与附件折叠记录，保住配对与可还原）。
 * 附件折叠文本不并入散文截断，原样保留。
 */
function compressAssistant(message: CanonicalMessage, maxChars: number, scale: number): CanonicalMessage {
  const prose = message.parts.filter(
    (part): part is { type: 'text'; text: string } => part.type === 'text' && !isAgedAttachmentText(part.text),
  )
  const preserved = message.parts.filter((part) => part.type !== 'text' || isAgedAttachmentText(part.text))
  const text = prose.map((part) => part.text).join('\n')
  const stripped = stripReasoning(message)
  const parts: CanonicalPart[] = []
  if (text.trim().length > 0) parts.push({ type: 'text', text: compressText(text, maxChars) })
  parts.push(...preserved)
  if (parts.length === 0) return stripped
  const tokenKey = computeTokenKey(parts)
  return {
    ...stripped,
    parts,
    tokenKey,
    tokens: applyScale(countParts(parts, tokenKey), scale) + stripped.toolCallTokens,
    dedupKey: computeDedupKey(message.role, parts),
    contentKey: computeContentKey(parts),
  }
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

/** 系统错误消息按等级改写：T1 一行；T2 由调用方决定（进检查点或一行）。 */
function rewriteErrorLine(message: CanonicalMessage, line: string, scale: number): CanonicalMessage {
  return rewriteParts(message, [{ type: 'text', text: line }], scale)
}

/**
 * 分层保留主入口：先替代去重，再按等级改写 / 丢弃。T3 整条丢弃（由检查点替代），
 * 其工具调用与结果同属该回合，一并丢弃，不产生孤儿调用。
 * 两条内容例外逐层生效：超大用户粘贴（首尾 + 句柄）与系统错误（T0 逐字 / T1 一行 / T2+ 进检查点）。
 */
export function applyRetention(messages: CanonicalMessage[], options: RetentionOptions): RetentionResult {
  const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1
  const oversizedUserChars = typeof options.oversizedUserChars === 'number' ? options.oversizedUserChars : 0
  const errorLine = typeof options.errorLine === 'string' ? options.errorLine : '{error}'
  const errorAvoidHeader = typeof options.errorAvoidHeader === 'string' ? options.errorAvoidHeader : '应避免的错误'
  const counts = emptyCounts()
  for (const message of messages) counts[tierOf(message, options)] += 1

  const dedupe = replacementDedupe(messages, options.callStep, scale)
  const checkpointMessage = dedupe.messages.find((message) => message.checkpoint === true) ?? null
  const kept: CanonicalMessage[] = []
  let dropped = 0
  let tier2Compress = false
  let attachmentsAged = false
  let largeArtifactsAged = false
  let oversizedUsers = 0
  let errorsLined = false
  const errorsToAvoid: string[] = []
  for (const message of dedupe.messages) {
    const tier = tierOf(message, options)
    if (tier === 'T3') {
      dropped += 1
      continue
    }
    // 超大用户粘贴例外：逐层（含 T0）以「首尾 + 句柄」替代，全文仍由 session 保存。
    const trimmedUser = trimOversizedUser(message, oversizedUserChars, scale)
    if (trimmedUser !== message) {
      oversizedUsers += 1
      kept.push(trimmedUser)
      continue
    }
    // 系统错误分层：T0 逐字；T1 一行；T2 进检查点 errors_to_avoid（无检查点时回落一行）。
    if (typeof message.error === 'string' && message.error.length > 0) {
      if (tier === 'T0') {
        kept.push(message)
        continue
      }
      if (tier === 'T2' && checkpointMessage !== null) {
        errorsToAvoid.push(distillErrorLine(message.error, '{error}'))
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
    if (tier === 'T2' && message.role === 'assistant') {
      tier2Compress = true
      const aged = ageAttachmentParts(message, scale)
      if (aged !== message) attachmentsAged = true
      kept.push(compressAssistant(aged, options.t2TextChars, scale))
      continue
    }
    if (tier === 'T1' || tier === 'T2') {
      const aged = ageAttachmentParts(message, scale)
      if (aged !== message) attachmentsAged = true
      kept.push(aged)
      continue
    }
    kept.push(message)
  }

  // 陈旧系统错误蒸馏进检查点的 `errors_to_avoid`（检查点本身已在上下文里，改写其渲染文本）。
  const foldedErrors = [...new Set(errorsToAvoid)]
  if (foldedErrors.length > 0 && checkpointMessage !== null) {
    const index = kept.indexOf(checkpointMessage)
    if (index >= 0) {
      const base = partsText(checkpointMessage.parts)
      const items = foldedErrors.map((line) => `- ${line}`).join('\n')
      const section = base.includes(errorAvoidHeader)
        ? `\n${items}`
        : `\n${errorAvoidHeader}：\n${items}`
      kept[index] = rewriteParts(checkpointMessage, [{ type: 'text', text: `${base}${section}` }], scale)
    }
  }

  const degraded: string[] = []
  if (dedupe.replaced > 0) degraded.push('replacement_dedupe')
  if (largeArtifactsAged) degraded.push('age_large_artifacts')
  if (attachmentsAged) degraded.push('age_attachments')
  if (oversizedUsers > 0) degraded.push('trim_oversized_user')
  if (errorsLined) degraded.push('error_line')
  if (foldedErrors.length > 0) degraded.push('error_to_checkpoint')
  if (tier2Compress) degraded.push('tier2_compress')
  if (dropped > 0) degraded.push('checkpoint_covered_turns')
  return { messages: kept, counts, replaced: dedupe.replaced, dropped, degraded }
}

/** 供测试：解析一条工具消息的结果值（若有 meta）。 */
export function toolResultValue(message: CanonicalMessage): Json | null {
  const meta = metaOf(message)
  if (meta === null) return null
  const parsed = parseResultContent(meta.verbatim)
  return parsed === null ? null : parsed.value
}
