// 回合落盘展示 parts（纯函数）：把本轮消息时间线（iter 间 assistant 承接帧 + 工具结果）
// 折叠成有序展示段（reasoning / text / tool），供 UI 定稿后按到达序渲染工具卡与推理块。
//
// 纯展示数据，不进模型上下文：context-window 丢弃 reasoning / tool part（只取 text 段），
// 工具调用与结果对模型的可见性由 `extra_messages` 回灌（message.tool_calls / tool_call_id）保证。

import type { Json, Rec } from './types.ts'

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 工具名 → render 描述符（来自 bag.tools 目录 decl；未登记 / 无 render 返回 null）。 */
function renderIndex(tools: Json[]): Map<string, Json> {
  const index = new Map<string, Json>()
  for (const tool of tools) {
    if (!isRec(tool)) continue
    const name = str(tool['name'])
    if (name !== null && isRec(tool['render'])) index.set(name, tool['render'])
  }
  return index
}

/** 解析工具结果消息体（`JSON.stringify({call_id, ok, result?, error?})`）；非该形状返回 null。 */
function callResult(content: unknown): Rec | null {
  if (typeof content !== 'string' || content.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(content)
    return isRec(parsed) && typeof parsed['call_id'] === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 时间线 → 展示段。工具调用先落占位段（带 args / render），随后按 `tool_call_id` 回填结果与状态。
 * `finalMessage` 是本轮终止的 assistant 消息（不在时间线内），其 reasoning / content 追加到末尾。
 */
export function displayParts(timeline: Json[], finalMessage: Rec | null, tools: Json[]): Json[] {
  const renders = renderIndex(tools)
  const parts: Json[] = []
  const toolPartByCall = new Map<string, Rec>()

  for (const item of timeline) {
    if (!isRec(item)) continue
    if (item['role'] === 'assistant') {
      const reasoning = str(item['reasoning'])
      if (reasoning !== null) parts.push({ type: 'reasoning', text: reasoning })
      const content = str(item['content'])
      if (content !== null) parts.push({ type: 'text', text: content })
      const calls = Array.isArray(item['tool_calls']) ? (item['tool_calls'] as Json[]) : []
      for (const call of calls) {
        if (!isRec(call)) continue
        const callId = str(call['id'])
        if (callId === null) continue
        const tool = str(call['name']) ?? ''
        const part: Rec = {
          type: 'tool',
          call_id: callId,
          tool,
          args: call['arguments'] ?? null,
          render: renders.get(tool) ?? null,
          result: null,
          status: null,
        }
        parts.push(part)
        toolPartByCall.set(callId, part)
      }
      continue
    }
    if (item['role'] === 'tool') {
      const result = callResult(item['content'])
      const callId = result !== null ? str(result['call_id']) : null
      const part = callId !== null ? toolPartByCall.get(callId) : undefined
      if (part === undefined || result === null) continue
      part['status'] = result['ok'] === true ? 'ok' : 'error'
      part['result'] = result['ok'] === true ? (result['result'] ?? null) : (result['error'] ?? result['result'] ?? null)
    }
  }

  if (finalMessage !== null) {
    const reasoning = str(finalMessage['reasoning'])
    if (reasoning !== null) parts.push({ type: 'reasoning', text: reasoning })
    const content = str(finalMessage['content'])
    if (content !== null) parts.push({ type: 'text', text: content })
  }
  return parts
}
