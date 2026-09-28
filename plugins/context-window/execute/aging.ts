// 工具结果的机械老化：由结果形状确定性地产出「摘要 + 句柄」，不依赖任何工具语义。
// 摘要优先提供方随结果自带的 `digest`，否则由 `digest.ts` 按形状派生；句柄供后续展开工具重取完整结果。
// 同输入同输出；不取时间、不随机。

import { createHash } from 'node:crypto'
import { digestOf, resourceIdentity } from './digest.ts'
import { applyScale, computeContentKey, computeDedupKey, computeTokenKey, countParts, isRecord } from './text.ts'
import type { AssetRef, CanonicalMessage, CanonicalPart, Json, ToolResultMeta } from './types.ts'

/** 老化摘要保留的结果尾部字符数。 */
export const AGED_TAIL_CHARS = 160

/** 超大用户粘贴替代文本保留的首 / 尾字符数（首大于尾：开头通常给出意图，结尾给出问题）。 */
export const PASTE_HEAD_CHARS = 2000
export const PASTE_TAIL_CHARS = 1000

/** 确定性句柄：同 (工具, 调用, 资源身份) 恒得同一句柄，供后续展开还原。 */
export function toolHandle(tool: string, callId: string, identity: string): string {
  const digest = createHash('sha256').update(`${tool}\u0001${callId}\u0001${identity}`).digest('hex')
  return `h-${digest.slice(0, 16)}`
}

/** 历史附件折叠句柄：同 (类型, sha256, mime, 名) 恒得同一句柄，供后续展开重取。 */
export function attachmentHandle(kind: 'image' | 'audio' | 'file', asset: AssetRef, name: string | null): string {
  const digest = createHash('sha256')
    .update(`${kind}\u0001${asset.sha256}\u0001${asset.mime}\u0001${name ?? ''}`)
    .digest('hex')
  return `h-${digest.slice(0, 16)}`
}

/** 超大用户粘贴句柄：同 (全文) 恒得同一句柄，供展开工具按内容寻回完整文本。 */
export function userPasteHandle(text: string): string {
  const digest = createHash('sha256').update(`user-paste\u0001${text}`).digest('hex')
  return `h-${digest.slice(0, 16)}`
}

/**
 * 超大用户粘贴的替代文本（JSON 信封）：显式标记 + 首尾 + 可还原句柄 + 省略码点数。
 * 只裁剪上下文投影，全文仍由 session 保存；同输入同输出，不取时间、不随机。
 */
export function oversizedUserText(text: string): string {
  const headChars = Math.min(PASTE_HEAD_CHARS, Math.floor(text.length / 2))
  const tailChars = Math.min(PASTE_TAIL_CHARS, Math.max(0, text.length - headChars - 1))
  const omitted = text.length - headChars - tailChars
  const envelope: Record<string, Json> = {
    aged: true,
    kind: 'user_paste',
    handle: userPasteHandle(text),
    omitted_chars: omitted,
    head: text.slice(0, headChars),
    tail: tailChars > 0 ? text.slice(text.length - tailChars) : '',
  }
  return JSON.stringify(envelope)
}

/**
 * 历史附件的老化文本：文本描述 + 句柄 + 摘要（类型 / mime / sha256 / 大小），不内联资产本身。
 * 同输入同输出；模型据此判断是否需要重取，且避免同一附件每回合重复计费。
 */
export function agedAttachmentText(kind: 'image' | 'audio' | 'file', asset: AssetRef, name: string | null): string {
  const envelope: Record<string, Json> = {
    ok: true,
    aged: true,
    attachment: kind,
    mime: asset.mime,
    sha256: asset.sha256,
    handle: attachmentHandle(kind, asset, name),
  }
  if (name !== null) envelope['name'] = name
  if (typeof asset.size === 'number' && Number.isFinite(asset.size)) envelope['bytes'] = asset.size
  return JSON.stringify(envelope)
}

/** 该文本是否为附件老化产物（压缩助手正文时保持原样，不并入散文截断）。 */
export function isAgedAttachmentText(text: string): boolean {
  if (text.length === 0 || text[0] !== '{') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  return isRecord(parsed) && parsed['aged'] === true && typeof parsed['attachment'] === 'string'
}

function tailOf(text: string): string {
  return text.length > AGED_TAIL_CHARS ? text.slice(text.length - AGED_TAIL_CHARS) : text
}

/** 句柄与资源展示字段：由工具名 + 参数推导（不依赖工具语义）。 */
export function identityEnvelope(tool: string, args: Json, callId: string): { handle: string; fields: Record<string, string> } {
  const identity = resourceIdentity(tool, args)
  return {
    handle: toolHandle(tool, callId, identity === null ? '' : identity.key),
    fields: identity === null ? {} : identity.fields,
  }
}

/** 从结果值提取错误码（保留错误码，不保留原始栈）。 */
function errorCodeOf(result: Json): string {
  if (isRecord(result)) {
    const code = result['code'] ?? result['error']
    if (typeof code === 'string' && code.length > 0) return code
    return 'error'
  }
  return typeof result === 'string' && result.length > 0 ? result : 'error'
}

/**
 * 由结果值产出老化摘要文本（JSON 字符串）：保留资源身份、规模、句柄与截断尾部；
 * 提供方 digest 原样带出，模型据此判断是否需要展开重取。`ok=false` 时保留错误码，不保留原始栈。
 */
export function ageResultText(tool: string, args: Json, callId: string, result: Json, ok: boolean): string {
  const { handle, fields } = identityEnvelope(tool, args, callId)
  const envelope: Record<string, Json> = { ok, aged: true, tool, ...fields, handle }
  const digest = digestOf(result, ok)
  if (digest.count !== null) envelope['count'] = digest.count
  envelope['bytes'] = digest.bytes
  envelope['summary'] = digest.summary
  if (digest.provider !== null) envelope['digest'] = digest.provider
  if (!ok) envelope['error'] = errorCodeOf(result)
  if (digest.text !== null && digest.text.length > 0) envelope['tail'] = tailOf(digest.text)
  return JSON.stringify(envelope)
}

/**
 * T2 结果：只留句柄与资源身份（结果丢弃、句柄保留），保住「可还原压缩」与调用配对。
 */
export function dropResultText(tool: string, args: Json, callId: string, ok: boolean): string {
  const { handle, fields } = identityEnvelope(tool, args, callId)
  const envelope: Record<string, Json> = { ok, aged: true, dropped: true, tool, ...fields, handle }
  return JSON.stringify(envelope)
}

/** 被同一资源的更晚读取替代：早前的完整内容塌成「已被第 N 步替代」，句柄保留。 */
export function replacedResultText(
  tool: string,
  args: Json,
  callId: string,
  step: number,
  identityFields: Record<string, string>,
): string {
  const { handle } = identityEnvelope(tool, args, callId)
  const envelope: Record<string, Json> = { ok: true, replaced: true, tool, ...identityFields, handle, replaced_by_step: step }
  return JSON.stringify(envelope)
}

/** 中断 / 无结果调用配对的占位结果（保住 tool_call ↔ result 配对不变量）。 */
export function interruptedResult(): string {
  return JSON.stringify({ ok: false, error: 'interrupted' })
}

/** 从「原始工具结果消息体」（JSON 字符串）解析出 `{ok, value}`；非该形状返回 null。 */
export function parseResultContent(content: string): { ok: boolean; value: Json } | null {
  if (content.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const ok = parsed['ok'] !== false
  const value = parsed['ok'] === true ? parsed['result'] : (parsed['error'] ?? parsed['result'])
  return { ok, value: (value ?? null) as Json }
}

/** 从「原始工具结果消息体」（JSON 字符串）产出老化文本；非该形状返回 null。 */
export function ageResultContent(content: string, tool: string, args: Json, callId: string): string | null {
  const parsed = parseResultContent(content)
  if (parsed === null) return null
  return ageResultText(tool, args, callId, parsed.value, parsed.ok)
}

/** 按老化文本重写一条工具结果消息（保留角色 / 来源 / 分组，按校正系数重算计数）。 */
export function ageMessage(message: CanonicalMessage, scale = 1): CanonicalMessage {
  const meta: ToolResultMeta | null | undefined = message.toolResult
  if (meta === null || meta === undefined) return message
  const aged = ageResultContent(meta.verbatim, meta.tool, meta.args, message.toolCallId ?? '')
  if (aged === null) return message
  return rewriteResultText(message, aged, scale)
}

/** 用一段新结果文本重写工具消息（按校正系数重算 token，重算 dedup / content 键，摘除 meta）。 */
export function rewriteResultText(message: CanonicalMessage, text: string, scale = 1): CanonicalMessage {
  const parts: CanonicalPart[] = [{ type: 'text', text }]
  const tokenKey = computeTokenKey(parts)
  const tokens = applyScale(countParts(parts, tokenKey), scale)
  return {
    ...message,
    parts,
    tokenKey,
    tokens,
    toolCallTokens: 0,
    reasoningTokens: 0,
    cacheKey: tokenKey,
    dedupKey: computeDedupKey(message.role, parts),
    contentKey: computeContentKey(parts),
    toolResult: null,
  }
}
