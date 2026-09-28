// 组装流水线编排（第 0–11 步）：汇集 → 结构化 → 去重 → 配对修复 → 预算 / 配额（含降级阶梯）→
// 前缀排序 → 配对自检 → 方言格式化 → 分节明细 / 组装清单 → 75% 压缩提示 → 交错引导。
// 全程确定、不取时间（TTL 用 env.now）；每模型 token 校正系数缩放快路径计数。

import { createHash } from 'node:crypto'
import { allocate, computeBudget, readConfig } from './budget.ts'
import { correctionFactor, observeUsage, parseUsage } from './calibration.ts'
import { gatherCandidates } from './candidates.ts'
import { buildParams, formatMessages } from './format.ts'
import { canonicalize } from './normalize.ts'
import { missingResults, repairPairing } from './pairing.ts'
import { applyRetention } from './retention.ts'
import { computeSections } from './sections.ts'
import { dedupe } from './stages.ts'
import { isRecord, stableStringify } from './text.ts'
import type {
  AssemblyManifest,
  CacheHint,
  CallEnv,
  CanonicalMessage,
  Json,
  Policy,
  RetentionTier,
  SectionTokens,
  Source,
  UsageManifest,
} from './types.ts'

/** 组装清单事件主题。 */
export const ASSEMBLED_TOPIC = 'context.assembled'

export interface PipelineResult {
  value: Json
  manifest: AssemblyManifest
  events: { topic: string; payload: Json }[]
}

/** 前缀缓存排序：稳定前缀（系统提示 → 工具 → L2）置前，其后历史 → L1 → 技能 → 召回 → 风格，输入最后。 */
function sourceRanks(policy: Policy): Record<string, number> {
  const order: Source[] = [...policy.prefix.stable, ...policy.prefix.order, 'input']
  const ranks: Record<string, number> = {}
  order.forEach((source, index) => {
    if (ranks[source] === undefined) ranks[source] = index
  })
  return ranks
}

function orderMessages(messages: CanonicalMessage[], policy: Policy): CanonicalMessage[] {
  const ranks = sourceRanks(policy)
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftRank = ranks[left.message.source] ?? 999
      const rightRank = ranks[right.message.source] ?? 999
      if (leftRank !== rightRank) return leftRank - rightRank
      if (left.message.orderHint !== right.message.orderHint) {
        return left.message.orderHint - right.message.orderHint
      }
      return left.index - right.index
    })
    .map((entry) => entry.message)
}

/** 尾部提示语（压缩提示 / 交错引导）：单条 system 消息，单独计入 `hints` 分节。 */
function noteMessage(text: string): CanonicalMessage {
  return canonicalize([
    {
      role: 'system',
      parts: [{ type: 'text', text }],
      source: 'prompt',
      priority: 0,
      at: 0,
      atomic: false,
      atomicGroup: null,
      toolCallId: null,
      from: null,
      orderHint: 0,
      hint: true,
    },
  ])[0] as CanonicalMessage
}

function containsToolResult(messages: CanonicalMessage[]): boolean {
  return messages.some((message) => message.role === 'tool' || message.toolCallId !== null)
}

/** flags 去重（保持首次出现顺序）。 */
function uniqueFlags(flags: string[]): string[] {
  return [...new Set(flags)]
}

/**
 * 阈值覆盖：调用方随 `bag.thresholds` 下传时优先（单一真源方向），否则用本包 policy 默认。
 * `positiveOnly` 为真时非正数视为不可用回落默认；否则允许 0（表示关闭该例外）。
 */
function thresholdOverride(bag: Record<string, unknown>, key: string, fallback: number, positiveOnly: boolean): number {
  const thresholds = isRecord(bag['thresholds']) ? (bag['thresholds'] as Record<string, unknown>) : null
  const value = thresholds === null ? undefined : thresholds[key]
  if (typeof value === 'number' && Number.isFinite(value) && (positiveOnly ? value > 0 : value >= 0)) return value
  return fallback
}

/** 大产物字节阈值（策略默认 / bag 覆盖）。 */
function largeArtifactBytes(bag: Record<string, unknown>, policy: Policy): number {
  return thresholdOverride(bag, 'large_artifact_bytes', policy.retention.large_artifact_bytes, true)
}

/** 超大用户粘贴阈值（策略默认 / bag 覆盖；0 = 关闭）。 */
function oversizedUserChars(bag: Record<string, unknown>, policy: Policy): number {
  return thresholdOverride(bag, 'oversized_user_chars', policy.retention.oversized_user_chars, false)
}

/** 稳定前缀的稳定哈希：仅由系统提示 → 工具 → L2 的静态内容决定，前缀不变则键不变。 */
function prefixKey(run: CanonicalMessage[]): string {
  const serialized = stableStringify(run.map((message) => ({ role: message.role, parts: message.parts })) as unknown as Json)
  return `ctx-${createHash('sha256').update(serialized).digest('hex').slice(0, 32)}`
}

/**
 * 厂商中立的缓存提示：标记稳定前缀（系统提示 → 工具 → L2，即 policy.prefix.stable 的连续前导段）的末尾。
 * 前缀为空（无可缓存内容）时返回 null，调用方不产出 `cache`。`system` 仅在全部 system 角色消息都落在
 * 前缀内时置真（否则 system 串会含易变切片，标记反而使缓存失效）；`breakpoints` 只标非 system 的前缀消息下标。
 */
function cacheHintOf(messages: CanonicalMessage[], policy: Policy): CacheHint | null {
  const stable = new Set<Source>(policy.prefix.stable)
  let end = 0
  while (end < messages.length) {
    const message = messages[end] as CanonicalMessage
    if (message.hint === true || !stable.has(message.source)) break
    end += 1
  }
  if (end === 0) return null
  const run = messages.slice(0, end)
  const hint: CacheHint = { key: prefixKey(run) }
  if (run.some((message) => message.source === 'prompt') && messages.slice(end).every((message) => message.role !== 'system')) {
    hint.system = true
  }
  if (run.some((message) => message.source === 'tools')) hint.tools = true
  const breakpoints = run
    .map((message, index) => (message.role === 'system' ? -1 : index))
    .filter((index) => index >= 0)
  if (breakpoints.length > 0) hint.breakpoints = breakpoints
  return hint
}

function recallKept(kept: CanonicalMessage[], recall: { entry: string; score: number }[]): { entry: string; score: number }[] {
  const count = kept.filter((message) => message.source === 'recall').length
  return recall.slice(0, count)
}

interface ManifestInput {
  env: CallEnv
  model: string
  budget: number
  budgetOrigin: AssemblyManifest['budget_origin']
  used: number
  sections: SectionTokens
  sources: AssemblyManifest['sources']
  deduped: number
  retention: Record<RetentionTier, number>
  trimmed: AssemblyManifest['trimmed']
  degraded: string[]
  recall: { entry: string; score: number }[]
  flags: string[]
  usage: UsageManifest | null
}

function makeManifest(input: ManifestInput): AssemblyManifest {
  return {
    run: input.env.run,
    thread: input.env.thread,
    model: input.model,
    budget: input.budget,
    used: input.used,
    sections: input.sections,
    sources: input.sources,
    deduped: input.deduped,
    retention: input.retention,
    trimmed: input.trimmed,
    degraded: input.degraded,
    recall: input.recall,
    flags: uniqueFlags(input.flags),
    budget_origin: input.budgetOrigin,
    usage: input.usage,
  }
}

/**
 * 执行一次组装。`bag` 是调用方入口 term 装配的输入（服务不读投影），`env` 是帧 env。
 */
export function buildAssembly(
  bag: Record<string, unknown>,
  env: CallEnv,
  policy: Policy,
): PipelineResult {
  const config = readConfig(bag)
  const model = typeof config?.['model'] === 'string' ? (config['model'] as string) : 'unknown'
  const usage = parseUsage(bag['usage'])
  const factor = correctionFactor(model)
  const gathered = gatherCandidates(bag, env, policy)
  const canonical = canonicalize(gathered.raws, { scale: factor })
  const deduped = dedupe(canonical)
  const retained = applyRetention(deduped.messages, {
    distances: gathered.turns.distances,
    coveredTurnIds: gathered.turns.coveredTurnIds,
    callStep: gathered.turns.callStep,
    recentTurns: policy.retention.recent_turns,
    t2TextChars: policy.retention.t2_text_chars,
    largeArtifactBytes: largeArtifactBytes(bag, policy),
    oversizedUserChars: oversizedUserChars(bag, policy),
    scale: factor,
    errorLine: policy.messages.error_line,
    errorAvoidHeader: policy.messages.error_avoid_header,
  })
  const repaired = repairPairing(retained.messages, factor)
  const budgetInfo = computeBudget(config, policy)
  const allocation = allocate(repaired, budgetInfo.budget, policy, {
    checkpoint: gathered.checkpoint !== null,
    scale: factor,
  })
  const retention = retained.counts
  const retentionDegraded = retained.degraded
  const recall = recallKept(allocation.kept, gathered.recallEntries)
  const baseFlags = [...gathered.flags, ...budgetInfo.flags]
  const manifestUsage: UsageManifest | null =
    usage === null ? null : { ...usage, correction_factor: factor }

  if (allocation.error !== null) {
    const manifest = makeManifest({
      env,
      model,
      budget: budgetInfo.budget,
      budgetOrigin: budgetInfo.origin,
      used: allocation.used,
      sections: computeSections(allocation.kept),
      sources: allocation.sources,
      deduped: deduped.deduped,
      retention,
      trimmed: allocation.trimmed,
      degraded: [...retentionDegraded, ...allocation.degraded],
      recall,
      flags: [...baseFlags, allocation.error.code],
      usage: manifestUsage,
    })
    observeUsage(model, allocation.used, usage)
    return {
      value: {
        ok: false,
        code: allocation.error.code,
        message: allocation.error.message,
        budget: budgetInfo.budget,
        used: allocation.used,
        manifest: manifest as unknown as Json,
      },
      manifest,
      events: [{ topic: ASSEMBLED_TOPIC, payload: manifest as unknown as Json }],
    }
  }

  const ordered = orderMessages(allocation.kept, policy)
  const missing = missingResults(ordered)
  if (missing.length > 0) {
    const manifest = makeManifest({
      env,
      model,
      budget: budgetInfo.budget,
      budgetOrigin: budgetInfo.origin,
      used: allocation.used,
      sections: computeSections(ordered),
      sources: allocation.sources,
      deduped: deduped.deduped,
      retention,
      trimmed: allocation.trimmed,
      degraded: [...retentionDegraded, ...allocation.degraded],
      recall,
      flags: [...baseFlags, 'pairing_violation'],
      usage: manifestUsage,
    })
    observeUsage(model, allocation.used, usage)
    return {
      value: {
        ok: false,
        code: 'pairing_violation',
        message: `tool_calls without result: ${missing.join(', ')}`,
        budget: budgetInfo.budget,
        used: allocation.used,
        manifest: manifest as unknown as Json,
      },
      manifest,
      events: [{ topic: ASSEMBLED_TOPIC, payload: manifest as unknown as Json }],
    }
  }

  const notes: CanonicalMessage[] = []
  // 75% 触发：追加一条压缩提示（只一条）。
  if (budgetInfo.budget > 0 && allocation.used >= budgetInfo.budget * policy.thresholds.compress_hint_ratio) {
    notes.push(noteMessage(policy.messages.compress_hint))
  }
  // 交错引导：本轮含工具结果 ⇒ 尾部追加一条「说意图、禁标识符」system 引导（幂等一条）。
  if (containsToolResult(ordered)) notes.push(noteMessage(policy.messages.interleave_guidance))

  const formatted = formatMessages([...ordered, ...notes], config, policy)
  const flags = [...baseFlags]
  if (formatted.dropped) flags.push('modality_dropped')

  const cacheHint = cacheHintOf(ordered, policy)

  const manifest = makeManifest({
    env,
    model,
    budget: budgetInfo.budget,
    budgetOrigin: budgetInfo.origin,
    used: allocation.used,
    sections: computeSections([...ordered, ...notes]),
    sources: allocation.sources,
    deduped: deduped.deduped,
    retention,
    trimmed: allocation.trimmed,
    degraded: [...retentionDegraded, ...allocation.degraded],
    recall,
    flags,
    usage: manifestUsage,
  })
  observeUsage(model, allocation.used, usage)

  const value: Json = {
    ok: true,
    messages: formatted.messages,
    params: buildParams(config, budgetInfo.max_output) as unknown as Json,
    ...(cacheHint === null ? {} : { cache: cacheHint as unknown as Json }),
    manifest: manifest as unknown as Json,
  }
  return { value, manifest, events: [{ topic: ASSEMBLED_TOPIC, payload: manifest as unknown as Json }] }
}
