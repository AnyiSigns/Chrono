// 图执行判据的共用形状与结构辅助：判据求值本身住在拥有方 `loop-policy`（见 `rule-port.ts`），
// 本文件只保留解释器构造上下文与归一结果所需的中立类型 / 结构检查，不再枚举判据名。

import { checkToolCalls as checkToolCallsShared, isRecord } from 'plugin-sdk'
import type { RuleEvalCtx, RuleEvalResult, WhenEvalResult } from 'chain-contract'
import type { Json, Rec } from './types.ts'

// 规则求值契约单源在 `chain-contract`（与提供方 loop-policy 共用）；消费方在其上加本进程内字段与传输错误码。
/** 规则求值上下文（解释器逐步构造，随反向调用序列化为中立形状）。 */
export interface RuleCtx extends RuleEvalCtx {
  /** 判据求值端口（`loop-rule` 成员）；只在本进程内使用，不随 args 出线。 */
  rules?: RuleEvaluator
}

/** `pre` / `post` 求值结果（`code` 为消费方传输层错误码，提供方不产生）。 */
export interface RuleResult extends RuleEvalResult {
  code?: string
}

/** `when` 求值结果：`ok:false` 是结构化拒绝（未知 / 畸形判据），不是「条件不成立」。 */
export interface WhenResult extends WhenEvalResult {
  code?: string
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

/** 模型 tool_calls 结构校验：结构真源在 `plugin-sdk`；成功剥除 `__bad` 标记，失败原样带标记。 */
export function checkToolCalls(raw: Json | undefined): { ok: boolean; reason?: string; calls: Rec[] } {
  const checked = checkToolCallsShared(raw)
  return checked.ok ? { ok: true, calls: checked.calls.map(stripBad) } : checked
}

function stripBad(call: Rec): Rec {
  const { __bad: _bad, ...rest } = call
  return rest
}
