// 图执行判据的共用形状与结构辅助：判据求值本身住在拥有方 `loop-policy`（见 `rule-port.ts`），
// 本文件只保留解释器构造上下文与归一结果所需的中立类型 / 结构检查，不再枚举判据名。

import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 规则求值上下文（解释器逐步构造，随反向调用序列化为中立形状）。 */
export interface RuleCtx {
  nodeIndex: number
  outputs: Map<number, Rec>
  inputs: Map<number, Rec>
  shared: Rec
  thresholds: Rec
  state: Rec
  effLog: Json[]
  /** 判据求值端口（`loop-rule` 成员）；只在本进程内使用，不随 args 出线。 */
  rules?: RuleEvaluator
}

export interface RuleResult {
  ok: boolean
  code?: string
  reason?: string
}

/** `when` 求值结果：`ok:false` 是结构化拒绝（未知 / 畸形判据），不是「条件不成立」。 */
export interface WhenResult {
  ok: boolean
  value: boolean
  code?: string
  reason?: string
}

/** 判据求值端口（消费方视角）：按名向 `loop-rule` 成员求值。 */
export interface RuleEvaluator {
  checkWhens(expressions: readonly (string | undefined)[]): Promise<string | null>
  when(expr: string, ctx: RuleCtx, sourceNode: number): Promise<WhenResult>
  pre(name: string, ctx: RuleCtx): Promise<RuleResult>
  post(name: string, ctx: RuleCtx): Promise<RuleResult>
}

/** 解析 `name` 或 `name(args)`。 */
export function parseRule(expr: string): { name: string; args: string } {
  const text = expr.trim()
  const open = text.indexOf('(')
  if (open < 0 || !text.endsWith(')')) return { name: text, args: '' }
  return { name: text.slice(0, open).trim(), args: text.slice(open + 1, -1).trim() }
}

/** 待办未完成：items 里有 pending / in_progress。 */
export function todoIncomplete(todo: Json | undefined): boolean {
  const items: Json[] = []
  const collect = (value: Json | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) items.push(item)
      return
    }
    if (isRecord(value)) {
      if (Array.isArray(value['items'])) for (const item of value['items']) items.push(item)
      const conversations = value['conversations']
      if (isRecord(conversations)) {
        for (const entry of Object.values(conversations)) collect(entry)
      }
    }
  }
  collect(todo)
  for (const item of items) {
    if (!isRecord(item)) continue
    const status = item['status']
    if (status === 'pending' || status === 'in_progress') return true
  }
  return false
}

function asText(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** 模型 tool_calls 结构校验：name 非空串、args 是对象（或 arguments 可解析为对象）、call_id 不重复。 */
export function checkToolCalls(raw: Json | undefined): { ok: boolean; reason?: string; calls: Rec[] } {
  if (raw === undefined || raw === null) return { ok: true, calls: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed_tool_call', calls: [] }
  const calls: Rec[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      calls.push({ call_id: `__bad-${index}`, tool: '', args: {}, __bad: true })
      return
    }
    // 同时接受模型原始形状（name / id / arguments）与归一形状（tool / call_id / args）。
    const name = asText(item['name']) || asText(item['tool'])
    const callId = asText(item['id']) || asText(item['call_id']) || `call-${index}`
    // args 显式给出则必须是对象；否则回落模型原始 `arguments`（字符串 JSON 或对象）。
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
  return bad === undefined ? { ok: true, calls: calls.map(stripBad) } : { ok: false, reason: 'malformed_tool_call', calls }
}

function stripBad(call: Rec): Rec {
  const { __bad: _bad, ...rest } = call
  return rest
}
