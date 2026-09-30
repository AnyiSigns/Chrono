// 段间状态重建：分段执行把整回合拆成多次 `interpret` 调用，游标只带 `turn_id`，
// 解释器据会话步记录（`session.read` 回值里的 `turns[].steps`）重建 `RunState` 与 `IterState`。
// 服务不 import 宿主与内核，步记录是唯一真源（服务不自己存状态）。

import { asString, isRecord, numberField } from './plan.ts'
import { mergeParts } from './commit-parts.ts'
import { freshState, type IterState } from './iter-ctx.ts'
import type { Json, Rec, RunState } from './types.ts'

/** 取某回合的步记录（来自 `bag.session.turns`，即 `session.read` 的切片）。 */
export function turnSteps(bag: Rec, turnId: string | null): Json[] {
  if (turnId === null) return []
  const session = isRecord(bag['session']) ? (bag['session'] as Rec) : null
  const turns = session !== null && Array.isArray(session['turns']) ? (session['turns'] as Json[]) : []
  for (const turn of turns) {
    if (isRecord(turn) && turn['turn_id'] === turnId && Array.isArray(turn['steps'])) {
      return turn['steps'] as Json[]
    }
  }
  return []
}

/** 步记录里的模型中立 tool_call（`{id,name,arguments}`）归一。 */
function callOf(raw: Rec, index: number): Rec {
  return {
    id: asString(raw['id']) ?? asString(raw['call_id']) ?? `call-${index}`,
    name: asString(raw['name']) ?? asString(raw['tool']) ?? '',
    arguments: isRecord(raw['arguments']) ? (raw['arguments'] as Rec) : isRecord(raw['args']) ? (raw['args'] as Rec) : {},
  }
}

/** 工具结果步里的调用 id（`results[].call_id`；缺失回落下标）。 */
function resultCallId(result: Json, index: number): string {
  return (isRecord(result) && asString(result['call_id'])) ?? `call-${index}`
}

/**
 * 从步记录重建解释器状态与全新 iter（每段是一个新 iter）。
 * `extra_messages` 按步逐迭代重建：每次工具派发得一条 assistant 承接帧（tool_calls 取该步
 * `step.intent`，无则据展示工具卡筛本步结果）+ 其工具结果，与同步环 `appendToolMessages` 回灌同形，
 * 且不把累积展示段重复计入（避免同一调用在下一段上下文里出现两次）。推理块按累积段的增量取回。
 * `steps` 续写自最大 `seq`；`iter` 取最近段标记（无则用已落派发意图数 + 1 兜底）。
 */
export function restoreFromSteps(steps: Json[]): { rs: RunState; iter: IterState } {
  const rs = freshState()
  // dispatchedTools / verifyFailed / questionPending 是「本段」语义：freshState 起 false，仅本段动作置真。
  // 无进展熔断（interpreter 的 no_progress）依赖此语义，勿在此从历史步恢复。
  const extra: Json[] = []
  let maxSeq = 0
  let dispatchIntents = 0
  let segmentIter: number | null = null
  const callsBySeq = new Map<number, Rec[]>()
  for (const item of steps) {
    if (!isRecord(item)) continue
    const seq = numberField(item['seq'])
    if (seq !== null) maxSeq = Math.max(maxSeq, seq)
    if (item['type'] !== 'step.intent') continue
    if (item['kind'] === 'tool.dispatch') dispatchIntents += 1
    const calls = Array.isArray(item['tool_calls']) ? (item['tool_calls'] as Json[]) : []
    if (seq !== null && calls.length > 0) callsBySeq.set(seq, calls.filter(isRecord).map(callOf))
  }

  /** 最近一条带用量的 `step.result`：跨段重建后供下一次上下文组装校准估算。 */
  let lastUsage: Rec | null = null
  /** 已回灌工具结果的 call_id → extra 下标：后续步重复出现同一 call（如 question 作答步）时原位覆盖，不重发承接帧。 */
  const emittedCalls = new Map<string, number>()
  /** 已落盘展示段的累计基线（工具卡按 call_id 合并）：续段写增量时据此判新 / 变。 */
  let committed: Json[] = []
  /** 无结果承接步（工具调用意图）暂存的推理，随其结果的步一并回灌，不因步拆分而丢。 */
  let pendingReasoning: string[] = []
  for (const item of steps) {
    if (!isRecord(item)) continue
    const type = item['type']
    if (type === 'checkpoint') {
      const summary = isRecord(item['summary']) ? (item['summary'] as Rec) : null
      // 段标记：段序号落账，稳准重建 iter（无步记录的循环也不会让预算失效）。
      const iter = summary !== null ? numberField(summary['iter']) : null
      if (summary !== null && summary['kind'] === 'segment' && iter !== null) {
        segmentIter = iter
        // 空转窗口与 nudge 状态随段标记落账：续段重建后熔断状态不归零（否则每段都从头算）。
        const signatures = summary['loop_signatures']
        if (Array.isArray(signatures)) {
          rs.loopSignatures = signatures.filter((item): item is string => typeof item === 'string')
        }
        if (summary['loop_nudged'] === true) rs.loopNudged = true
        if (typeof summary['loop_nudge'] === 'string') rs.loopNudge = summary['loop_nudge'] as string
        continue
      }
      // 非终态步里的合成工具消息（如 verify 报告）：重建为工具消息回灌下一段。
      const text = summary !== null ? summary['text'] : undefined
      if (typeof text === 'string' && text.length > 0) extra.push({ role: 'tool', content: text })
      continue
    }
    if (type !== 'step.result') continue
    const assistant = isRecord(item['assistant']) ? (item['assistant'] as Rec) : {}
    const usage =
      (isRecord(item['usage']) ? (item['usage'] as Rec) : null) ??
      (isRecord(assistant['meta']) && isRecord((assistant['meta'] as Rec)['usage'])
        ? ((assistant['meta'] as Rec)['usage'] as Rec)
        : null)
    if (usage !== null) lastUsage = usage
    const parts = Array.isArray(assistant['parts']) ? (assistant['parts'] as Json[]) : []
    committed = mergeParts(committed, parts)
    const reasonings: string[] = []
    const cards: Rec[] = []
    for (const part of parts) {
      if (!isRecord(part)) continue
      if (part['type'] === 'reasoning' && typeof part['text'] === 'string') {
        reasonings.push(part['text'] as string)
        continue
      }
      if (part['type'] === 'tool') cards.push(part)
    }
    const results = Array.isArray(item['tool_results']) ? (item['tool_results'] as Json[]) : []
    if (results.length === 0) {
      // 工具调用承接步：本步无结果，推理留待随其结果的步一并回灌。
      pendingReasoning.push(...reasonings)
      continue
    }
    const carried = pendingReasoning.concat(reasonings)
    pendingReasoning = []
    // 作答步：其 tool_results 的 call_id 全在已回灌集合里（question 挂起步已记 pending），
    // 且没有新的正文 / 推理——原位覆盖结果为 answers，不再多插一个 assistant(tool_calls) 帧，
    // 否则模型看到重复调用 + 无配对结果的 tool_call（严格 provider 会拒）。
    const callIds = results.map((result, index) => resultCallId(result, index))
    const supersedes = callIds.every((id) => emittedCalls.has(id))
    const assistantContent = assistant['content']
    const hasContent = typeof assistantContent === 'string' && assistantContent.length > 0
    if (supersedes && !hasContent && carried.length === 0) {
      results.forEach((result, index) => {
        const id = callIds[index]
        const position = emittedCalls.get(id)
        if (position !== undefined) extra[position] = { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
      })
      continue
    }
    const seq = numberField(item['seq'])
    const intents = seq !== null ? callsBySeq.get(seq) : undefined
    const resultIds = new Set(results.map((result, index) => resultCallId(result, index)))
    const calls = intents !== undefined && intents.length > 0
      ? intents
      : cards
          .filter((card) => resultIds.has(asString(card['call_id']) ?? ''))
          .map((card, index) => ({ id: asString(card['call_id']) ?? `call-${index}`, name: asString(card['tool']) ?? '', arguments: isRecord(card['args']) ? card['args'] : {} }))
    const message: Rec = {
      role: 'assistant',
      content: typeof assistant['content'] === 'string' ? (assistant['content'] as string) : '',
    }
    // 展示段按步增量为真源：本迭代推理即本步（含承接步携带）的推理，无需再按累积前缀截取。
    if (carried.length > 0) message['reasoning'] = carried.join('')
    if (calls.length > 0) message['tool_calls'] = calls
    extra.push(message)
    results.forEach((result, index) => {
      const id = resultCallId(result, index)
      extra.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) })
      emittedCalls.set(id, extra.length - 1)
    })
  }
  rs.extraMessages = extra
  rs.steps = maxSeq
  rs.iter = segmentIter ?? dispatchIntents + 1
  rs.committedParts = committed
  if (lastUsage !== null) rs.shared['last_usage'] = lastUsage
  return { rs, iter: { outputs: new Map(), inputs: new Map(), executed: new Set() } }
}
