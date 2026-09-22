// 跨 run 续跑游标：把解释器进程内状态（iter / outputs / inputs / executed / 消息 / 派发标志）序列化，
// 随队列项落世界（H5 / H18）；恢复时反序列化并注入裁决 / 答案。游标是服务自造的 opaque 结构，宿主不认识。

import { asString, isRecord, numberField } from './plan.ts'
import { freshState, type IterState } from './iter-ctx.ts'
import type { Json, Rec, RunState } from './types.ts'

function serializeOutputs(map: Map<number, Rec>): Rec {
  const out: Rec = {}
  for (const [index, value] of map) out[String(index)] = value
  return out
}

function deserializeOutputs(value: Json): Map<number, Rec> {
  const map = new Map<number, Rec>()
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      const index = Number(key)
      if (Number.isInteger(index) && isRecord(item)) map.set(index, item)
    }
  }
  return map
}

/**
 * 构造跨 run 续跑游标（含当时的槽 / 已执行集 / 原始输入）。
 * `originalInput` = 本轮 `bag.input`（原始用户消息）：作答 / 裁决时刻的槽已换成
 * `approval.decide` / `question.answer`，恢复时须用游标内的原始输入重建上下文。
 */
export function graphCursor(
  kind: string,
  nodeIndex: number,
  rs: RunState,
  iter: IterState,
  callId: string | null,
  originalInput: Json = null,
): Rec {
  const cursor: Rec = {
    kind,
    iter: rs.iter,
    node_index: nodeIndex,
    outputs: serializeOutputs(iter.outputs),
    inputs: serializeOutputs(iter.inputs),
    executed: [...iter.executed],
    messages: rs.messages,
    extra_messages: rs.extraMessages,
    slots: rs.slots,
    shared: rs.shared,
    dispatched_tools: rs.dispatchedTools,
    question_pending: rs.questionPending,
    verify_failed: rs.verifyFailed,
    last_calls: rs.lastCalls,
    steps: rs.steps,
    original_input: originalInput,
  }
  if (callId !== null) cursor['call_id'] = callId
  return cursor
}

/** 从游标恢复 RunState 与 IterState。 */
export function restoreState(cursor: Rec): { rs: RunState; iter: IterState } {
  const rs = freshState()
  rs.iter = numberField(cursor['iter']) ?? 1
  rs.steps = numberField(cursor['steps']) ?? 0
  rs.messages = Array.isArray(cursor['messages']) ? (cursor['messages'] as Json[]) : []
  rs.extraMessages = Array.isArray(cursor['extra_messages']) ? (cursor['extra_messages'] as Json[]) : []
  rs.slots = isRecord(cursor['slots']) ? (cursor['slots'] as Rec) : {}
  rs.shared = isRecord(cursor['shared']) ? (cursor['shared'] as Rec) : {}
  rs.dispatchedTools = cursor['dispatched_tools'] === true
  rs.questionPending = cursor['question_pending'] === true
  rs.verifyFailed = cursor['verify_failed'] === true
  rs.lastCalls = Array.isArray(cursor['last_calls']) ? (cursor['last_calls'] as Rec[]) : []
  const iter: IterState = {
    outputs: deserializeOutputs(cursor['outputs']),
    inputs: deserializeOutputs(cursor['inputs']),
    executed: new Set<number>(
      Array.isArray(cursor['executed']) ? (cursor['executed'] as number[]).filter((n) => Number.isInteger(n)) : [],
    ),
  }
  return { rs, iter }
}

export function resumePayload(resume: Rec | null): Rec {
  if (resume === null) return {}
  if (isRecord(resume['payload'])) return resume['payload'] as Rec
  return resume
}

/**
 * 裁决词汇归一：槽 / 续跑 payload 用 `accept` / `deny`（#1 槽词汇），
 * 图边判定用 `approved` / `denied`（#32 item 结果态）——在此映射，边 `verdict_is(approved)` 才命中。
 */
export function normalizeResumeVerdict(verdict: string | null): string | null {
  if (verdict === 'accept') return 'approved'
  if (verdict === 'deny') return 'denied'
  return verdict
}

export function resumeVerdict(resume: Rec | null): string | null {
  const payload = resumePayload(resume)
  return normalizeResumeVerdict(asString(payload['verdict']) ?? asString(payload['decision']))
}

/** 恢复提问节点：把答案回灌为 question 工具结果（游标取自派发前，故常需按 last_calls 重建）。 */
export function patchQuestionAnswer(iter: IterState, nodeIndex: number, callId: string | null, payload: Rec, calls: Rec[]): void {
  const answers = payload['answers'] ?? null
  const output = iter.outputs.get(nodeIndex)
  if (output !== undefined && Array.isArray(output['results'])) {
    output['results'] = (output['results'] as Json[]).map((item) => {
      if (!isRecord(item)) return item
      if (callId !== null && item['call_id'] !== callId) return item
      return { ...item, ok: true, result: { answers } }
    })
    iter.executed.add(nodeIndex)
    return
  }
  const results = calls.map((call, index) => ({
    call_id: typeof call['call_id'] === 'string' ? call['call_id'] : `call-${index}`,
    ok: true,
    result: call['tool'] === 'question' ? { answers } : { status: 'resumed' },
  }))
  iter.outputs.set(nodeIndex, { results })
  iter.executed.add(nodeIndex)
}
