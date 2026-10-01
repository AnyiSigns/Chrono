// `loop-rule` 消费端：按世界成员表向各提供方按名求值 when / pre / post。
// 名发现 = 逐个成员探测（`probe`）取首个认领者，按提供方身份名码元序；无提供方认领即 fail-closed。
// 求值上下文序列化为中立 JSON 随 args 出线，提供方回结构化结果，本插件不持有任何判据实现。

import { parseRule, type RuleCtx, type RuleEvaluator, type RuleResult, type WhenResult } from './rules.ts'
import { isRecord } from './plan.ts'
import type { PortCaller, Rec } from './types.ts'

const WHEN_UNSAT = 'when_unsat'

/** 把规则上下文序列化为出线中立形状（数值键 Map → 对象；仅 JSON 值）。 */
function serializeCtx(ctx: RuleCtx): Rec {
  const outputs: Rec = {}
  for (const [key, value] of ctx.outputs) outputs[String(key)] = value
  const inputs: Rec = {}
  for (const [key, value] of ctx.inputs) inputs[String(key)] = value
  return {
    node_index: ctx.nodeIndex,
    outputs,
    inputs,
    shared: ctx.shared,
    thresholds: ctx.thresholds,
    state: ctx.state,
    eff_log: ctx.effLog,
  }
}

type RuleKind = 'when' | 'pre' | 'post'

export function makeRuleEvaluator(port: PortCaller, providers: string[]): RuleEvaluator {
  // 名 → 提供方身份（null = 无成员认领）；按 kind 分别缓存，互不串味。
  const resolved = new Map<string, string | null>()

  /** 探测某 kind 下 name 的认领提供方（首个 known 者，按成员序）。 */
  async function resolve(kind: RuleKind, name: string): Promise<string | null> {
    const key = `${kind}:${name}`
    const cached = resolved.get(key)
    if (cached !== undefined) return cached
    for (const provider of providers) {
      const outcome = await port.call('loop-rule', kind, { name, probe: true }, { provider })
      if (!outcome.ok) continue
      const value = isRecord(outcome.value) ? outcome.value : null
      if (value !== null && value['known'] === true) {
        resolved.set(key, provider)
        return provider
      }
    }
    resolved.set(key, null)
    return null
  }

  /** 求值一次（已定提供方）；返回原始提供方值，传输失败 / 未认领回 null。 */
  async function evaluate(kind: RuleKind, name: string, payload: Rec): Promise<Rec | null> {
    const provider = await resolve(kind, name)
    if (provider === null) return null
    const outcome = await port.call('loop-rule', kind, { name, ...payload }, { provider })
    if (!outcome.ok) return null
    const value = isRecord(outcome.value) ? outcome.value : null
    if (value === null || value['known'] !== true) return null
    return value
  }

  async function when(expr: string, ctx: RuleCtx, sourceNode: number): Promise<WhenResult> {
    const text = expr.trim()
    if (text.length === 0) return { ok: true, value: true }
    if (text.startsWith('not ')) {
      const inner = await when(text.slice(4), ctx, sourceNode)
      if (!inner.ok) return inner
      return { ok: true, value: !inner.value }
    }
    const { name, args } = parseRule(text)
    const value = await evaluate('when', name, {
      args,
      source_node: sourceNode,
      ctx: serializeCtx(ctx),
    })
    if (value === null) {
      return { ok: false, value: false, code: WHEN_UNSAT, reason: `unknown_when:${name}` }
    }
    if (value['ok'] === false) {
      return {
        ok: false,
        value: false,
        code: WHEN_UNSAT,
        reason: typeof value['reason'] === 'string' ? (value['reason'] as string) : `unknown_when:${name}`,
      }
    }
    return { ok: true, value: value['value'] === true }
  }

  async function pre(name: string, ctx: RuleCtx): Promise<RuleResult> {
    const value = await evaluate('pre', name, { ctx: serializeCtx(ctx) })
    if (value === null) return { ok: false, code: 'pre_unsat', reason: `unknown_pre:${name}` }
    if (value['ok'] === false) {
      return {
        ok: false,
        code: 'pre_unsat',
        reason: typeof value['reason'] === 'string' ? (value['reason'] as string) : `pre_failed:${name}`,
      }
    }
    return { ok: true }
  }

  async function post(name: string, ctx: RuleCtx): Promise<RuleResult> {
    const value = await evaluate('post', name, { ctx: serializeCtx(ctx) })
    if (value === null) return { ok: false, reason: `unknown_post:${name}` }
    if (value['ok'] === false) {
      return {
        ok: false,
        reason: typeof value['reason'] === 'string' ? (value['reason'] as string) : 'post_failed',
      }
    }
    return { ok: true }
  }

  /** 入口 fail-closed：任一 `when` 表达式名无成员认领即回该表达式（空串 = 无条件）。 */
  async function checkWhens(expressions: readonly (string | undefined)[]): Promise<string | null> {
    for (const expr of expressions) {
      if (expr === undefined) continue
      const text = expr.trim()
      if (text.length === 0) continue
      const inner = text.startsWith('not ') ? text.slice(4).trim() : text
      const { name } = parseRule(inner)
      if ((await resolve('when', name)) === null) return expr
    }
    return null
  }

  return { checkWhens, when, pre, post }
}
