// 组装流水线编排（第 0–11 步）：汇集 → 结构化 → 去重 → 预算 / 配额 → 冲突消解 →
// 前缀排序 → 方言格式化 → 组装清单 → 75% 压缩提示 → 交错引导。全程确定、不取时间（TTL 用 env.now）。

import { allocate, computeBudget, readConfig } from './budget.ts'
import { gatherCandidates } from './candidates.ts'
import { buildParams, formatMessages } from './format.ts'
import { canonicalize } from './normalize.ts'
import { dedupe, resolveConflicts } from './stages.ts'
import { normalizeText } from './text.ts'
import type {
  AssemblyManifest,
  CallEnv,
  CanonicalMessage,
  Json,
  Policy,
  Source,
} from './types.ts'

/** 组装清单事件主题。 */
export const ASSEMBLED_TOPIC = 'context.assembled'

export interface PipelineResult {
  value: Json
  manifest: AssemblyManifest
  events: { topic: string; payload: Json }[]
}

/** 前缀缓存排序：稳定前缀（系统提示 → 工具 schema）置前，其后 L2 → L1 → 技能 → 召回 → 历史 → 风格，输入最后。 */
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

function noteMessage(text: string): CanonicalMessage {
  return {
    role: 'system',
    parts: [{ type: 'text', text }],
    source: 'prompt',
    priority: 0,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    subject: null,
    orderHint: 0,
    tokens: 0,
    dedupKey: normalizeText(text),
    conflictKey: normalizeText(text),
    cacheKey: normalizeText(text),
    contentKey: normalizeText(text),
  }
}

function containsToolResult(messages: CanonicalMessage[]): boolean {
  return messages.some((message) => message.role === 'tool' || message.toolCallId !== null)
}

/** flags 去重（保持首次出现顺序）。 */
function uniqueFlags(flags: string[]): string[] {
  return [...new Set(flags)]
}

function recallKept(kept: CanonicalMessage[], recall: { entry: string; score: number }[]): { entry: string; score: number }[] {
  const count = kept.filter((message) => message.source === 'recall').length
  return recall.slice(0, count)
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
  const gathered = gatherCandidates(bag, env)
  const canonical = canonicalize(gathered.raws)
  const deduped = dedupe(canonical)
  const conflicted = resolveConflicts(deduped.messages)
  const budgetInfo = computeBudget(config, policy)
  const allocation = allocate(conflicted.messages, budgetInfo.budget, policy)
  const model = typeof config?.['model'] === 'string' ? (config['model'] as string) : 'unknown'
  const flags = uniqueFlags([...gathered.flags, ...budgetInfo.flags])
  const trimmed = [...allocation.trimmed, ...conflicted.conflicts]

  if (allocation.error !== null) {
    flags.push(allocation.error.code)
    const manifest: AssemblyManifest = {
      run: env.run,
      thread: env.thread,
      model,
      budget: budgetInfo.budget,
      used: allocation.used,
      sources: allocation.sources,
      deduped: deduped.deduped,
      trimmed,
      recall: recallKept(allocation.kept, gathered.recallEntries),
      flags: uniqueFlags(flags),
    }
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
  const formatted = formatMessages(ordered, config, policy)
  if (formatted.dropped) flags.push('modality_dropped')

  const manifest: AssemblyManifest = {
    run: env.run,
    thread: env.thread,
    model,
    budget: budgetInfo.budget,
    used: allocation.used,
    sources: allocation.sources,
    deduped: deduped.deduped,
    trimmed,
    recall: recallKept(allocation.kept, gathered.recallEntries),
    flags: uniqueFlags(flags),
  }

  const messages = formatted.messages.slice()
  // 75% 触发：追加一条压缩提示（只一条）。
  if (budgetInfo.budget > 0 && allocation.used >= budgetInfo.budget * policy.thresholds.compress_hint_ratio) {
    messages.push(...formatMessages([noteMessage(policy.messages.compress_hint)], config, policy).messages)
  }
  // 交错引导：本轮含工具结果 ⇒ 尾部追加一条「说意图、禁标识符」system 引导（幂等一条）。
  if (containsToolResult(ordered)) {
    messages.push(...formatMessages([noteMessage(policy.messages.interleave_guidance)], config, policy).messages)
  }

  const value: Json = {
    ok: true,
    messages,
    params: buildParams(config, budgetInfo.max_output) as unknown as Json,
    manifest: manifest as unknown as Json,
  }
  return { value, manifest, events: [{ topic: ASSEMBLED_TOPIC, payload: manifest as unknown as Json }] }
}
