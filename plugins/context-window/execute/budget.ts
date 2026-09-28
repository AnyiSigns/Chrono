// 流水线第 3 / 4 / 5 步：预算建模、配额分配与预算降级阶梯。
// 总预算 = context_window - max_output - 余量（policy）；配额按优先级给各类，未用额度下滚给历史。
// 只有 P0（系统提示 + 工具 schema）本身超窗才硬错误，且指名是哪个元素过大；其余一律降级而非失败。

import { ageMessage } from './aging.ts'
import { countTokens } from './native.ts'
import { canonicalize } from './normalize.ts'
import { isRecord, applyScale, prefixSums, rangeSum } from './text.ts'
import type { BudgetOrigin, CanonicalMessage, Policy, Source } from './types.ts'

export interface BudgetInfo {
  budget: number
  context_window: number
  max_output: number
  margin: number
  origin: BudgetOrigin
  flags: string[]
}

export interface AllocationError {
  code: 'budget_impossible' | 'budget_exceeded'
  message: string
}

export interface AllocationResult {
  kept: CanonicalMessage[]
  used: number
  sources: Record<string, { tokens: number; count: number }>
  trimmed: { source: string; reason: string }[]
  /** 按序应用的降级阶梯（`age_tool_results` / `drop_reasoning` / `compress_unavailable` / `drop_old_turns` / `truncate_input`）。 */
  degraded: string[]
  error: AllocationError | null
}

const ALL_SOURCES: Source[] = [
  'prompt',
  'tools',
  'input',
  'l2',
  'l1',
  'skill',
  'recall',
  'history',
  'style',
  'tool',
]

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 预算建模：从 `bag.config` 取模型档案，缺档案回落保守默认并标 `profile_missing`。 */
export function computeBudget(config: Record<string, unknown> | null, policy: Policy): BudgetInfo {
  const flags: string[] = []
  const contextWindow = positiveNumber(config?.['context_window'])
  const maxOutput = positiveNumber(config?.['max_output'])
  const window = contextWindow ?? policy.budget.default_context_window
  const output = maxOutput ?? policy.budget.default_max_output
  if (contextWindow === null || maxOutput === null) flags.push('profile_missing')
  const margin = Math.floor(window * policy.budget.margin_ratio)
  // 输出预留不能吃掉整个上下文：部分档案的 `max_output` 接近甚至等于 `context_window`（models.dev 偶有
  // 此类条目），全额预留会让输入预算变负（界面显示「-13.1k」）。封顶到半个上下文，保证至少一半留给输入。
  const reserve = Math.min(output, Math.floor(window / 2))
  return {
    budget: window - reserve - margin,
    context_window: window,
    max_output: reserve,
    margin,
    origin: contextWindow === null || maxOutput === null ? 'default' : 'profile',
    flags,
  }
}

function emptySources(): Record<string, { tokens: number; count: number }> {
  const sources: Record<string, { tokens: number; count: number }> = {}
  for (const source of ALL_SOURCES) sources[source] = { tokens: 0, count: 0 }
  return sources
}

function sumTokens(messages: CanonicalMessage[]): number {
  let total = 0
  for (const message of messages) total += message.tokens
  return total
}

function byPriority(messages: CanonicalMessage[], priority: number): CanonicalMessage[] {
  return messages.filter((message) => message.priority === priority)
}

interface Group {
  messages: CanonicalMessage[]
  tokens: number
}

/** 按 atomic 组切分历史（组内同生共死）；非 atomic 消息各自成组；组 token 用前缀和区间求和。 */
export function groupHistory(messages: CanonicalMessage[]): Group[] {
  const sums = prefixSums(messages.map((message) => message.tokens))
  const groups: Group[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index] as CanonicalMessage
    if (message.atomicGroup === null) {
      groups.push({ messages: [message], tokens: rangeSum(sums, index, index + 1) })
      index += 1
      continue
    }
    const groupId = message.atomicGroup
    let end = index + 1
    while (end < messages.length && (messages[end] as CanonicalMessage).atomicGroup === groupId) end += 1
    groups.push({ messages: messages.slice(index, end), tokens: rangeSum(sums, index, end) })
    index = end
  }
  return groups
}

function collectSources(kept: CanonicalMessage[]): Record<string, { tokens: number; count: number }> {
  const sources = emptySources()
  for (const message of kept) {
    const bucket = sources[message.source] as { tokens: number; count: number }
    bucket.tokens += message.tokens
    bucket.count += 1
  }
  return sources
}

/** 强制保留的 P0：系统提示 + 工具 schema（本轮输入可作最后手段截断）。 */
function mandatoryOf(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.filter((message) => message.source === 'prompt' || message.source === 'tools')
}

interface CoreResult {
  kept: CanonicalMessage[]
  usedWithoutInput: number
  inputTokens: number
  inputOverflow: boolean
}

/**
 * 配额分配（阶梯的应用点）：P0 强制保留；记忆按 `quota.l2` / `quota.l1` 截断；
 * 技能 / 召回 / 风格按配额截断；历史（含工具）新 → 旧按 atomic 组整组进出；输入最后放入，放不下即标溢出。
 */
function allocateCore(
  messages: CanonicalMessage[],
  budget: number,
  policy: Policy,
  trimmed: { source: string; reason: string }[],
  reserve: number,
): CoreResult {
  const keep = new Set<CanonicalMessage>()
  let left = budget
  for (const message of mandatoryOf(messages)) {
    keep.add(message)
    left -= message.tokens
  }
  // 预留本轮输入被截断后的标记位，避免历史吃掉全部额度后输入被整条丢弃。
  const spendable = (): number => Math.max(0, left - reserve)

  const takeBySource = (source: Source, cap: number): void => {
    const limit = Math.min(cap, spendable())
    let used = 0
    for (const message of messages) {
      if (message.source !== source) continue
      if (used + message.tokens > limit) {
        trimmed.push({ source, reason: 'quota' })
        continue
      }
      keep.add(message)
      used += message.tokens
    }
    left -= used
  }

  const takeByPriority = (priority: number, quota: number): void => {
    const cap = Math.min(Math.floor(budget * quota), spendable())
    let used = 0
    let stopped = false
    for (const message of byPriority(messages, priority)) {
      if (stopped || used + message.tokens > cap) {
        trimmed.push({ source: message.source, reason: 'quota' })
        stopped = true
        continue
      }
      keep.add(message)
      used += message.tokens
    }
    left -= used
  }

  takeBySource('l2', Math.floor(budget * policy.quota.l2))
  takeBySource('l1', Math.floor(budget * policy.quota.l1))
  takeByPriority(2, policy.quota.skill)
  takeByPriority(3, policy.quota.recall)
  takeByPriority(5, policy.quota.style)

  // 历史（含同回合工具）：新 → 旧，atomic 组整组进 / 整组出；额度不够时停止（保新近连续）。
  const groups = groupHistory(byPriority(messages, 4))
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as Group
    if (group.tokens > spendable()) {
      for (const message of group.messages) trimmed.push({ source: message.source, reason: 'budget' })
      continue
    }
    for (const message of group.messages) keep.add(message)
    left -= group.tokens
  }

  // 输入最后放入：放不下即标溢出，由顶层按阶梯截断。
  const inputMessages = messages.filter((message) => message.source === 'input')
  const inputTokens = sumTokens(inputMessages)
  const usedWithoutInput = sumTokens([...keep])
  if (inputTokens > 0 && inputTokens <= left) {
    for (const message of inputMessages) keep.add(message)
  }
  const kept = messages.filter((message) => keep.has(message))
  return {
    kept,
    usedWithoutInput,
    inputTokens,
    inputOverflow: inputTokens > 0 && inputTokens > left,
  }
}

/** 老化同回合工具结果（T1→T2）：只改有 `toolResult` 元数据的消息。 */
function ageToolResults(messages: CanonicalMessage[], scale: number): CanonicalMessage[] {
  let changed = false
  const out = messages.map((message) => {
    const next = ageMessage(message, scale)
    if (next !== message) changed = true
    return next
  })
  return changed ? out : messages
}

/** 丢推理块：去掉中立块并扣掉其 token。 */
function dropReasoning(messages: CanonicalMessage[]): CanonicalMessage[] {
  let changed = false
  const out = messages.map((message) => {
    if (message.reasoning === null || message.reasoning === undefined) return message
    changed = true
    return {
      ...message,
      reasoning: null,
      reasoningTokens: 0,
      tokens: Math.max(0, message.tokens - message.reasoningTokens),
    }
  })
  return changed ? out : messages
}

/** 截断本轮输入首尾并插入显式标记；二分确定可容纳的字符预算，确定且必不超限（按校正系数同口径）。 */
function truncateText(text: string, marker: string, maxTokens: number, scale: number): string {
  const tokensOf = (value: string): number => applyScale(countTokens(value), scale)
  const markerTokens = tokensOf(marker)
  if (maxTokens <= markerTokens) return marker
  if (tokensOf(text) <= maxTokens) return text
  const compose = (keepChars: number): string => {
    const head = Math.ceil(keepChars / 2)
    const tail = Math.floor(keepChars / 2)
    return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '')
  }
  let low = 0
  let high = text.length
  let best = compose(0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = compose(mid)
    if (tokensOf(candidate) <= maxTokens) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function truncateInput(
  messages: CanonicalMessage[],
  remaining: number,
  marker: string,
  trimmed: { source: string; reason: string }[],
  scale: number,
): CanonicalMessage[] {
  const inputMessages = messages.filter((message) => message.source === 'input')
  if (inputMessages.length === 0) return messages
  const text = inputMessages
    .flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text))
    .join('\n')
  const template = inputMessages[0] as CanonicalMessage
  const truncated = canonicalize([
    {
      role: 'user',
      parts: [{ type: 'text', text: truncateText(text, marker, Math.max(1, remaining), scale) }],
      source: 'input',
      priority: template.priority,
      at: template.at,
      atomic: false,
      atomicGroup: null,
      toolCallId: null,
      from: template.from,
      orderHint: template.orderHint,
    },
  ], { scale })[0] as CanonicalMessage
  for (const message of inputMessages) trimmed.push({ source: 'input', reason: 'truncated' })
  const out: CanonicalMessage[] = []
  let inserted = false
  for (const message of messages) {
    if (message.source !== 'input') {
      out.push(message)
      continue
    }
    if (!inserted) {
      out.push(truncated)
      inserted = true
    }
  }
  return out
}

export interface AllocationOptions {
  /** 本次装配是否已消费结构化检查点（检查点 = 压缩产物）。 */
  checkpoint?: boolean
  /** 每模型 token 校正系数：改写 / 截断路径重算 token 时与之同口径。 */
  scale?: number
}

/**
 * 配额分配 + 预算降级阶梯。
 * 阶梯按序：老化工具结果 → 丢推理 → 压缩（已消费检查点则记为 `compress`，否则 `compress_unavailable` 回落机械老化）
 * → 丢检查点之外的老回合（历史裁剪）→ 截断本轮输入。只有系统提示 + 工具 schema 本身超窗才 `budget_impossible`，
 * 并在消息里指名过大元素。
 */
export function allocate(
  messages: CanonicalMessage[],
  budget: number,
  policy: Policy,
  options: AllocationOptions = {},
): AllocationResult {
  const trimmed: { source: string; reason: string }[] = []
  const degraded: string[] = []
  const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1
  if (budget <= 0) {
    return {
      kept: [],
      used: 0,
      sources: emptySources(),
      trimmed,
      degraded,
      error: { code: 'budget_exceeded', message: `budget ${budget} <= 0` },
    }
  }

  const mandatory = mandatoryOf(messages)
  const mandatoryTokens = sumTokens(mandatory)
  if (mandatoryTokens > budget) {
    const offender = mandatory.reduce(
      (worst, message) => (message.tokens > worst.tokens ? message : worst),
      mandatory[0] as CanonicalMessage,
    )
    return {
      kept: [],
      used: mandatoryTokens,
      sources: emptySources(),
      trimmed,
      degraded,
      error: {
        code: 'budget_impossible',
        message: `${offender.source} (${offender.tokens}) alone exceeds budget (${budget})`,
      },
    }
  }

  let working = messages
  let agedResults = false
  if (sumTokens(working) > budget) {
    const aged = ageToolResults(working, scale)
    if (aged !== working) {
      working = aged
      agedResults = true
      degraded.push('age_tool_results')
    }
  }
  if (sumTokens(working) > budget) {
    const dropped = dropReasoning(working)
    if (dropped !== working) {
      working = dropped
      degraded.push('drop_reasoning')
    }
  }
  // 压缩梯级：预算仍超，或本轮已用机械老化兜底（压缩不可用的回落路径）。
  // 有检查点 = 压缩产物已消费 → `compress`；否则 `compress_unavailable`——机械老化已顶上，回合不硬死。
  if (agedResults || sumTokens(working) > budget) {
    degraded.push(options.checkpoint === true ? 'compress' : 'compress_unavailable')
  }

  const reserve = messages.some((message) => message.source === 'input')
    ? countTokens(policy.messages.input_truncated) + 1
    : 0
  let core = allocateCore(working, budget, policy, trimmed, reserve)
  if (trimmed.some((entry) => entry.reason === 'budget')) degraded.push('drop_old_turns')
  if (core.inputOverflow) {
    const remaining = budget - core.usedWithoutInput
    working = truncateInput(working, remaining, policy.messages.input_truncated, trimmed, scale)
    degraded.push('truncate_input')
    core = allocateCore(working, budget, policy, trimmed, reserve)
  }

  const kept = core.kept
  const used = sumTokens(kept)
  if (used > budget) {
    return {
      kept,
      used,
      sources: collectSources(kept),
      trimmed,
      degraded,
      error: { code: 'budget_exceeded', message: `assembled ${used} exceeds budget ${budget}` },
    }
  }
  return { kept, used, sources: collectSources(kept), trimmed, degraded, error: null }
}

/** 读取 `bag.config`（缺省 null）。 */
export function readConfig(bag: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(bag['config']) ? bag['config'] : null
}
