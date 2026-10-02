// 模型 tool_calls 结构校验：接受模型原始形状（`name` / `id` / `arguments`）与归一形状
// （`tool` / `call_id` / `args`），输出统一的 `{call_id, tool, args}`；失败条目带 `__bad` 标记。
// 纯函数，零内核零宿主依赖；调用方自行决定如何剥除标记。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

/** 校验结果：`calls` 逐条带 `__bad` 标记；`ok:false` 时至少一条为真。 */
export interface ToolCallsCheck {
  ok: boolean
  reason?: string
  calls: Rec[]
}

function asText(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** 结构校验：name 非空串、args 是对象（或 `arguments` 可解析为对象）、call_id 不重复。 */
export function checkToolCalls(raw: Json | undefined): ToolCallsCheck {
  if (raw === undefined || raw === null) return { ok: true, calls: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed_tool_call', calls: [] }
  const calls: Rec[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      calls.push({ call_id: `__bad-${index}`, tool: '', args: {}, __bad: true })
      return
    }
    const name = asText(item['name']) || asText(item['tool'])
    const callId = asText(item['id']) || asText(item['call_id']) || `call-${index}`
    let args: Json
    if (item['args'] !== undefined && item['args'] !== null) {
      args = item['args']
    } else {
      const rawArgs = item['arguments']
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs) as Json
        } catch {
          args = null
        }
      } else if (isRecord(rawArgs)) {
        args = rawArgs
      } else {
        args = {}
      }
    }
    const bad = name.length === 0 || !isRecord(args) || seen.has(callId)
    if (!bad) seen.add(callId)
    calls.push({ call_id: callId, tool: name, args: isRecord(args) ? args : {}, __bad: bad })
  })
  const bad = calls.find((call) => call['__bad'] === true)
  return bad === undefined ? { ok: true, calls } : { ok: false, reason: 'malformed_tool_call', calls }
}
