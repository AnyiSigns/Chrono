// 工具调用 ↔ 工具结果配对：组装边界处保证每个 `tool_call` 都有配对结果。
// 无结果（老化裁掉 / 中断 / 上游只回灌了调用）时合成 `{ok:false,error:'interrupted'}` 占位，
// 避免裁出孤儿 tool_call 被厂商 400。自检发现残留缺口时返回结构化错误，不抛异常。

import { interruptedResult } from './aging.ts'
import { canonicalize } from './normalize.ts'
import type { CanonicalMessage, Json } from './types.ts'

interface CallRef {
  id: string
}

/** assistant 消息携带的工具调用（只取有字符串 id 的项）。 */
export function toolCallsOf(message: CanonicalMessage): CallRef[] {
  if (!Array.isArray(message.toolCalls)) return []
  const calls: CallRef[] = []
  for (const item of message.toolCalls as Json[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const id = (item as Record<string, Json>)['id']
    if (typeof id === 'string' && id.length > 0) calls.push({ id })
  }
  return calls
}

function hasResult(messages: CanonicalMessage[], from: number, callId: string): boolean {
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage
    if (message.role === 'tool' && message.toolCallId === callId) return true
  }
  return false
}

/** 为缺失结果的调用合成中断占位结果（与调用同来源 / 同原子组，紧邻其后）。 */
function synthesize(call: CallRef, assistant: CanonicalMessage, scale: number): CanonicalMessage {
  return canonicalize([
    {
      role: 'tool',
      parts: [{ type: 'text', text: interruptedResult() }],
      source: assistant.source,
      priority: assistant.priority,
      at: assistant.at,
      atomic: true,
      atomicGroup: assistant.atomicGroup,
      toolCallId: call.id,
      from: null,
      orderHint: assistant.orderHint + 0.5,
    },
  ], { scale })[0] as CanonicalMessage
}

/**
 * 配对修复：逐个 assistant 工具调用补齐缺失结果。保持数组顺序，合成结果紧邻其调用之后。
 * `scale` 为每模型 token 校正系数，合成占位与其余消息同口径计数。
 */
export function repairPairing(messages: CanonicalMessage[], scale = 1): CanonicalMessage[] {
  const out: CanonicalMessage[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage
    out.push(message)
    const calls = toolCallsOf(message)
    for (const call of calls) {
      if (hasResult(messages, index + 1, call.id)) continue
      out.push(synthesize(call, message, scale))
    }
  }
  return out
}

/** 配对自检：返回缺失结果的调用 id 列表（空 = 不变量成立）。 */
export function missingResults(messages: CanonicalMessage[]): string[] {
  const missing: string[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as CanonicalMessage
    for (const call of toolCallsOf(message)) {
      if (!hasResult(messages, index + 1, call.id)) missing.push(call.id)
    }
  }
  return missing
}
