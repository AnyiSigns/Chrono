// 流水线第 3 / 4 / 5 步：预算建模、配额分配、裁剪与来源调度。
// 总预算 = context_window - max_output - 余量（policy）；配额按优先级给各类，未用额度下滚给历史。
// P0（系统提示 + 工具 schema + 本轮用户消息）不裁；P0 + P1 超预算即 `budget_impossible`。

import { isRecord, prefixSums, rangeSum } from './text.ts'
import type { CanonicalMessage, Policy, Source } from './types.ts'

export interface BudgetInfo {
  budget: number
  context_window: number
  max_output: number
  margin: number
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
]

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 预算建模：从 `bag.config` 取模型档案，缺档案回落保守默认并标 `profile_missing`。 */
export function computeBudget(config: Record<string, unknown> | null, policy: Policy): BudgetInfo {
  const flags: string[] = []
  const contextWindow =
    positiveNumber(config?.['context_window']) ?? policy.budget.default_context_window
  const maxOutput = positiveNumber(config?.['max_output']) ?? policy.budget.default_max_output
  if (positiveNumber(config?.['context_window']) === null || positiveNumber(config?.['max_output']) === null) {
    flags.push('profile_missing')
  }
  const margin = Math.floor(contextWindow * policy.budget.margin_ratio)
  return {
    budget: contextWindow - maxOutput - margin,
    context_window: contextWindow,
    max_output: maxOutput,
    margin,
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

/**
 * 配额分配与裁剪。
 * P0 不裁；P0+P1 > budget ⇒ `budget_impossible`；budget ≤ 0 ⇒ `budget_exceeded`。
 * P2 技能 / P3 召回 / P5 风格按配额截断；未用额度下滚给历史（P4，新 → 旧保 atomic 组）。
 */
export function allocate(messages: CanonicalMessage[], budget: number, policy: Policy): AllocationResult {
  const trimmed: { source: string; reason: string }[] = []
  if (budget <= 0) {
    return {
      kept: [],
      used: 0,
      sources: emptySources(),
      trimmed,
      error: { code: 'budget_exceeded', message: `budget ${budget} <= 0` },
    }
  }

  const p0 = byPriority(messages, 0)
  const p1 = byPriority(messages, 1)
  const p0Tokens = sumTokens(p0)
  const p1Tokens = sumTokens(p1)
  if (p0Tokens + p1Tokens > budget) {
    return {
      kept: [],
      used: p0Tokens + p1Tokens,
      sources: emptySources(),
      trimmed,
      error: {
        code: 'budget_impossible',
        message: `P0+P1 (${p0Tokens + p1Tokens}) exceeds budget (${budget})`,
      },
    }
  }

  const remaining = budget - p0Tokens - p1Tokens
  const keep = new Set<CanonicalMessage>()
  for (const message of p0) keep.add(message)
  for (const message of p1) keep.add(message)

  let usedByOptional = 0

  const takeByQuota = (priority: number, quota: number): void => {
    const pool = byPriority(messages, priority)
    const cap = Math.min(quota, remaining - usedByOptional)
    let used = 0
    let stopped = false
    for (const message of pool) {
      if (stopped || used + message.tokens > cap) {
        trimmed.push({ source: message.source, reason: 'quota' })
        stopped = true
        continue
      }
      keep.add(message)
      used += message.tokens
    }
    usedByOptional += used
  }

  takeByQuota(2, Math.floor(budget * policy.quota.skill))
  takeByQuota(3, Math.floor(budget * policy.quota.recall))
  takeByQuota(5, Math.floor(budget * policy.quota.style))

  // 历史：新 → 旧，atomic 组整组进 / 整组出；额度不够时停止（保新近连续）。
  const historyPool = budget - p0Tokens - p1Tokens - usedByOptional
  const history = byPriority(messages, 4)
  const groups = groupHistory(history)
  let historyRemaining = historyPool
  let historyStopped = false
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as Group
    if (historyStopped || group.tokens > historyRemaining) {
      for (const message of group.messages) trimmed.push({ source: message.source, reason: 'budget' })
      historyStopped = true
      continue
    }
    for (const message of group.messages) keep.add(message)
    historyRemaining -= group.tokens
  }

  const kept = messages.filter((message) => keep.has(message))
  const used = sumTokens(kept)
  if (used > budget) {
    return {
      kept,
      used,
      sources: collectSources(kept),
      trimmed,
      error: { code: 'budget_exceeded', message: `assembled ${used} exceeds budget ${budget}` },
    }
  }
  return { kept, used, sources: collectSources(kept), trimmed, error: null }
}

/** 读取 `bag.config`（缺省 null）。 */
export function readConfig(bag: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(bag['config']) ? bag['config'] : null
}
