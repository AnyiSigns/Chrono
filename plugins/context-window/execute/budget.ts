// 流水线第 3 / 4 / 5 步：配额分配与预算降级阶梯（预算标量与配额由提供方 `budget` 建模）。
// 配额按优先级给各类，未用额度下滚给历史。
// 只有 P0（系统提示 + 工具 schema）本身超窗才硬错误，且指名是哪个元素过大；其余一律降级而非失败。

import { ageMessage } from './aging.ts'
import { canonicalize } from './normalize.ts'
import { lookupCount } from './tokens.ts'
import { isKnownSource } from './types.ts'
import { isRecord, applyScale, prefixSums, rangeSum } from './text.ts'
import type { BudgetModel, BudgetOrigin, CanonicalMessage, Policy, QuotaCaps } from './types.ts'

// `BudgetModel` / `QuotaCaps` 单源在 `chain-contract`（与提供方 `budget` 共用的线协议形状），
// 经本地 types.ts re-export；此处仅再导出以保留既有 import 面。
export type { BudgetModel, QuotaCaps } from './types.ts'

/** 由预算标量与 policy 比例在本地回落出配额上限（直调 allocate 时的兜底，与 `budget.model` 同口径）。
 * 分配器只消费 `skill` / `style`；本地兜底无法由 policy 推出 `l2` / `l1` / `recall`，故置 0（不被读取）。 */
function quotaCapsFromPolicy(budget: number, policy: Policy): QuotaCaps {
  return {
    l2: 0,
    l1: 0,
    skill: Math.floor(budget * policy.quota.skill),
    recall: 0,
    style: Math.floor(budget * policy.quota.style),
  }
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
  /** 按序应用的降级阶梯（`age_tool_results` / `drop_reasoning` / `drop_old_turns` / `truncate_input`）。 */
  degraded: string[]
  error: AllocationError | null
}

const ALL_SOURCES: string[] = [
  'prompt',
  'tools',
  'input',
  'skill',
  'history',
  'style',
  'tool',
]

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
    while (end < messages.length && (messages[end] as CanonicalMessage).atomicGroup === groupId)
      end += 1
    groups.push({ messages: messages.slice(index, end), tokens: rangeSum(sums, index, end) })
    index = end
  }
  return groups
}

function collectSources(
  kept: CanonicalMessage[],
): Record<string, { tokens: number; count: number }> {
  const sources = emptySources()
  for (const message of kept) {
    // 外部来源名不在预置表内：按需开桶（保持 manifest 逐字节稳定）。
    const bucket = sources[message.source] ?? { tokens: 0, count: 0 }
    bucket.tokens += message.tokens
    bucket.count += 1
    sources[message.source] = bucket
  }
  return sources
}

/** 强制保留的 P0：系统提示 + 工具 schema + 外部稳定来源（本轮输入可作最后手段截断）。 */
function isMandatory(message: CanonicalMessage): boolean {
  if (message.source === 'prompt' || message.source === 'tools') return true
  return !isKnownSource(message.source) && message.stability === 'stable'
}

function mandatoryOf(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.filter(isMandatory)
}

interface CoreResult {
  kept: CanonicalMessage[]
  usedWithoutInput: number
  inputTokens: number
  inputOverflow: boolean
  /** 因预算被整组裁掉的历史消息条数（不含本轮 / 非历史来源）。 */
  droppedHistory: number
}

/**
 * 配额分配（阶梯的应用点）：P0 强制保留；技能 / 风格按配额截断；
 * 历史（含工具）新 → 旧按 atomic 组整组进出；输入最后放入，放不下即标溢出。
 */
function allocateCore(
  messages: CanonicalMessage[],
  budget: number,
  quota: QuotaCaps,
  trimmed: { source: string; reason: string }[],
  reserve: number,
): CoreResult {
  const keep = new Set<CanonicalMessage>()
  let left = budget
  for (const message of mandatoryOf(messages)) {
    keep.add(message)
    left -= message.tokens
  }
  // 本轮记录（T0，`source:'tool'`）：优先保留（先于技能 / 历史配额），不参与历史裁剪。
  // 超预算时由顶层老化 / 丢推理先行收缩；配对完整性由 atomic 组保证。
  // 外部来源不在此列（按 stability 走 P0 或通用可裁路径）。
  for (const message of byPriority(messages, 4)) {
    if (message.source === 'history' || !isKnownSource(message.source)) continue
    keep.add(message)
    left -= message.tokens
  }
  // 预留本轮输入被截断后的标记位，避免历史吃掉全部额度后输入被整条丢弃。
  const spendable = (): number => Math.max(0, left - reserve)

  const takeByPriority = (priority: number, cap: number): void => {
    const limit = Math.min(cap, spendable())
    let used = 0
    let stopped = false
    for (const message of byPriority(messages, priority)) {
      if (!isKnownSource(message.source)) continue
      if (stopped || used + message.tokens > limit) {
        trimmed.push({ source: message.source, reason: 'quota' })
        stopped = true
        continue
      }
      keep.add(message)
      used += message.tokens
    }
    left -= used
  }

  takeByPriority(2, quota.skill)
  takeByPriority(5, quota.style)

  // 外部动态来源（可裁）：按 priority 升序（小 = 更优先）尽量保留，放不下即裁。
  // 外部稳定来源已在 P0 强制保留；内建来源各有专门路径。
  const external = messages
    .filter(
      (message) =>
        !isKnownSource(message.source) &&
        message.stability !== 'stable' &&
        !keep.has(message),
    )
    .sort((a, b) => a.priority - b.priority || a.orderHint - b.orderHint)
  for (const message of external) {
    if (message.tokens <= spendable()) {
      keep.add(message)
      left -= message.tokens
    } else {
      trimmed.push({ source: message.source, reason: 'budget' })
    }
  }

  // 历史：仅 `source==='history'`（P4）新 → 旧按 atomic 组整组进出；额度不够时停止（保新近连续）。
  // 本轮记录（`source:'tool'`）不在此列——它们是 T0，另有配额保留路径，不产生 `drop_old_turns`。
  const groups = groupHistory(
    byPriority(messages, 4).filter((message) => message.source === 'history'),
  )
  let droppedHistory = 0
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as Group
    if (group.tokens > spendable()) {
      for (const message of group.messages) {
        trimmed.push({ source: message.source, reason: 'budget' })
        droppedHistory += 1
      }
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
    droppedHistory,
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

/** 截断候选的字符网格粒度：在 [0, len] 上取固定档位，保证一轮即可批量取齐候选计数。 */
const TRUNCATE_GRID = 96

/**
 * 截断本轮输入首尾并插入显式标记。在固定字符网格上取「计数 ≤ 上限」的最大档（网格点计数单调不减，
 * 一旦越限即可停止）；候选计数经批量 `token-estimate.count` 在本轮取齐，确定且必不超限（按校正系数同口径）。
 */
function truncateText(text: string, marker: string, maxTokens: number, scale: number): string {
  const tokensOf = (value: string): number => applyScale(lookupCount(value) ?? 0, scale)
  const markerTokens = tokensOf(marker)
  if (maxTokens <= markerTokens) return marker
  if (tokensOf(text) <= maxTokens) return text
  const compose = (keepChars: number): string => {
    const head = Math.ceil(keepChars / 2)
    const tail = Math.floor(keepChars / 2)
    return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '')
  }
  let best = compose(0)
  for (let step = 1; step <= TRUNCATE_GRID; step += 1) {
    const keepChars = Math.floor((text.length * step) / TRUNCATE_GRID)
    if (keepChars <= 0) continue
    const candidate = compose(keepChars)
    if (tokensOf(candidate) > maxTokens) break
    best = candidate
  }
  return best
}

/**
 * 截断本轮输入：只改写「正文最长」的单条输入消息（首尾保留 + 显式标记），其余输入消息原样保留；
 * 被截断消息上的非文本 part（附件 / 图片）全部原样保留，不因截断丢失。
 * 可分配额度 = `remaining - 其它输入消息 token`，保证同批输入互不吞并。
 */
function truncateInput(
  messages: CanonicalMessage[],
  remaining: number,
  marker: string,
  trimmed: { source: string; reason: string }[],
  scale: number,
): CanonicalMessage[] {
  const inputMessages = messages.filter((message) => message.source === 'input')
  if (inputMessages.length === 0) return messages
  let target: CanonicalMessage | null = null
  let targetText = ''
  let targetLength = -1
  let targetIndex = -1
  messages.forEach((message, index) => {
    if (message.source !== 'input') return
    const text = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (text.length > targetLength) {
      targetLength = text.length
      target = message
      targetText = text
      targetIndex = index
    }
  })
  if (target === null || targetIndex < 0) return messages
  let otherTokens = 0
  for (const message of inputMessages) if (message !== target) otherTokens += message.tokens
  const preserved = target.parts.filter((part) => part.type !== 'text')
  // 保留的二进制 part 也各占 1 token 开销，须从可分配额度里扣除，否则截断后仍差一点点放不下。
  const preservedCost = applyScale(preserved.length, scale)
  const allowance = Math.max(1, remaining - otherTokens - preservedCost)
  const truncated = canonicalize(
    [
      {
        role: target.role,
        parts: [
          { type: 'text', text: truncateText(targetText, marker, allowance, scale) },
          ...preserved,
        ],
        source: 'input',
        priority: target.priority,
        at: target.at,
        atomic: false,
        atomicGroup: null,
        toolCallId: null,
        from: target.from,
        orderHint: target.orderHint,
      },
    ],
    { scale },
  )[0] as CanonicalMessage
  trimmed.push({ source: 'input', reason: 'truncated' })
  return messages.map((message, index) => (index === targetIndex ? truncated : message))
}

export interface AllocationOptions {
  /** 每模型 token 校正系数：改写 / 截断路径重算 token 时与之同口径。 */
  scale?: number
  /** 每来源配额上限（由 `budget.model` 给出）；缺省按预算与 policy 比例本地回落。 */
  quota?: QuotaCaps
}

/**
 * 配额分配 + 预算降级阶梯。
 * 阶梯按序：老化工具结果 → 丢推理 → 丢老回合（历史裁剪）→ 截断本轮输入。
 * 只有系统提示 + 工具 schema 本身超窗才 `budget_impossible`，并在消息里指名过大元素。
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
  const quota = options.quota ?? quotaCapsFromPolicy(budget, policy)
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
  if (sumTokens(working) > budget) {
    const aged = ageToolResults(working, scale)
    if (aged !== working) {
      working = aged
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
  const reserve = messages.some((message) => message.source === 'input')
    ? (lookupCount(policy.messages.input_truncated) ?? 0) + 1
    : 0
  let core = allocateCore(working, budget, quota, trimmed, reserve)
  // 只有历史组真的因预算被裁才登记 `drop_old_turns`（本轮 T0 记录不计）。
  if (core.droppedHistory > 0) degraded.push('drop_old_turns')
  if (core.inputOverflow) {
    const remaining = budget - core.usedWithoutInput
    working = truncateInput(working, remaining, policy.messages.input_truncated, trimmed, scale)
    degraded.push('truncate_input')
    core = allocateCore(working, budget, quota, trimmed, reserve)
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
