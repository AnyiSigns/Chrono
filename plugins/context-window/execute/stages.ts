// 流水线第 2 步（去重）：规范化后完全一致只留最新一条；跨来源时历史是事实源，丢记忆副本。
// 原子组完整性由配对修复（`pairing.ts`）在装配边界兜底：去重不会为孤儿工具调用留下缺口。
// 工具结果（role=tool）只按调用配对、绝不按正文去重：删任一条都会让对应 tool_call 变孤儿并被
// 补成 `interrupted`（语义＝调用失败），造成「读过却像没读到」。
// 同理，携带 `toolCalls` 的 assistant 帧也绝不去重：内容为空时它们共享 `assistant|` 键，塌缩会
// 让对应工具结果变孤儿；工调身份（id）不参与 dedup_key，故结构性豁免是最小代价的修法。

import type { CanonicalMessage, Source } from './types.ts'

export interface DedupResult {
  messages: CanonicalMessage[]
  deduped: number
}

/** 记忆来源：与历史内容完全一致时丢记忆副本（历史是事实源，记忆只是提示）。 */
const MEMORY_SOURCES: ReadonlySet<Source> = new Set(['l1', 'l2', 'recall'])

/** 结构性豁免：工具结果与携带工具调用的 assistant 帧不按正文去重（见文件头）。 */
function dedupExempt(message: CanonicalMessage): boolean {
  if (message.role === 'tool') return true
  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0
}

/**
 * 去重：同一 dedup_key 只保留一条。
 * 先跨来源：记忆来源与历史消息内容一致 → 丢记忆副本；
 * 再同键：组内若含历史消息 → 保留位置最新的历史消息；否则保留位置最新的一条。
 */
export function dedupe(messages: CanonicalMessage[]): DedupResult {
  const historyKeys = new Set<string>()
  for (const message of messages) {
    if (message.source === 'history') historyKeys.add(message.contentKey)
  }
  const crossSource = messages.filter(
    (message) => !(MEMORY_SOURCES.has(message.source) && historyKeys.has(message.contentKey)),
  )

  const groups = new Map<string, number[]>()
  crossSource.forEach((message, index) => {
    // 工具结果与携带工具调用的 assistant 帧按结构豁免，不按正文去重（见文件头）。
    if (dedupExempt(message)) return
    const list = groups.get(message.dedupKey)
    if (list === undefined) groups.set(message.dedupKey, [index])
    else list.push(index)
  })

  const keep = new Set<number>()
  crossSource.forEach((message, index) => {
    if (dedupExempt(message)) keep.add(index)
  })
  for (const indices of groups.values()) {
    if (indices.length === 1) {
      keep.add(indices[0] as number)
      continue
    }
    const historyIndices = indices.filter((index) => (crossSource[index] as CanonicalMessage).source === 'history')
    const pool = historyIndices.length > 0 ? historyIndices : indices
    keep.add(pool[pool.length - 1] as number)
  }

  const kept = crossSource.filter((_message, index) => keep.has(index))
  return { messages: kept, deduped: messages.length - kept.length }
}
