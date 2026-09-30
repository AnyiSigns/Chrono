// 反向调用后端实现：经 `port.call` 调 `token-estimate` / `budget`，失败作结构化错误（ServiceError），
// 不抛未捕获错误、不断通道。等待上限严格大于提供方声明（多一跳严格嵌套超时），且小于本服务 `context.build`。
// 本插件 `needs` 含 `token-estimate`（one）与 `budget`（one）。

import { ServiceError } from 'plugin-sdk'
import { isRecord } from './text.ts'
import type { BudgetBackend, ContextBackends, TokenBackend } from './backends.ts'
import type { BudgetModel, QuotaCaps } from './budget.ts'
import type { UsageManifest } from './types.ts'
import type { Json, PortCaller } from 'plugin-sdk'

/** `token-estimate.count` 反向调用等待上限；须严格大于 `token-estimate.count` 声明（30000）。 */
export const TOKEN_COUNT_TIMEOUT_MS = 35000
/** `token-estimate.version` 反向调用等待上限；须严格大于其声明（5000）。 */
export const TOKEN_VERSION_TIMEOUT_MS = 10000
/** `budget.model` 反向调用等待上限；须严格大于其声明（30000）。 */
export const BUDGET_MODEL_TIMEOUT_MS = 35000
/** `budget.factor` 反向调用等待上限；须严格大于其声明（10000）。 */
export const BUDGET_FACTOR_TIMEOUT_MS = 15000
/** `budget.observe` 反向调用等待上限；须严格大于其声明（30000）。 */
export const BUDGET_OBSERVE_TIMEOUT_MS = 35000

function numberArray(value: Json | undefined): number[] | null {
  if (!Array.isArray(value)) return null
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null
    out.push(item)
  }
  return out
}

function quotaOf(value: Json): QuotaCaps {
  const record = isRecord(value) ? value : {}
  const pick = (key: string): number => {
    const item = record[key]
    return typeof item === 'number' && Number.isFinite(item) ? item : 0
  }
  return {
    skill: pick('skill'),
    style: pick('style'),
  }
}

function budgetModelOf(value: Json): BudgetModel {
  if (!isRecord(value))
    throw new ServiceError('budget_bad_result', 'budget.model returned a non-object')
  const number = (key: string): number => {
    const item = value[key]
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new ServiceError('budget_bad_result', `budget.model missing numeric ${key}`)
    }
    return item
  }
  const flags = Array.isArray(value['flags'])
    ? value['flags'].filter((item): item is string => typeof item === 'string')
    : []
  return {
    budget: number('budget'),
    context_window: number('context_window'),
    max_output: number('max_output'),
    margin: number('margin'),
    origin: value['origin'] === 'profile' ? 'profile' : 'default',
    flags,
    quota: quotaOf((value['quota'] ?? null) as Json),
  }
}

/** `token-estimate.count` / `version` 的反向调用后端。 */
export class RemoteTokenEstimate implements TokenBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async count(texts: string[]): Promise<number[]> {
    const outcome = await this.link.call(
      'token-estimate',
      'count',
      { texts },
      { timeoutMs: TOKEN_COUNT_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    const counts = numberArray((outcome.value as { counts?: Json } | null)?.counts)
    if (counts === null || counts.length !== texts.length) {
      throw new ServiceError(
        'token_estimate_bad_result',
        'token-estimate.count returned a mismatched counts array',
      )
    }
    return counts
  }

  async version(): Promise<string> {
    const outcome = await this.link.call(
      'token-estimate',
      'version',
      {},
      { timeoutMs: TOKEN_VERSION_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    const value = (outcome.value as { version?: Json } | null)?.version
    if (typeof value !== 'string') {
      throw new ServiceError(
        'token_estimate_bad_result',
        'token-estimate.version returned no version',
      )
    }
    return value
  }
}

/** `budget.model` / `factor` / `observe` 的反向调用后端。 */
export class RemoteBudget implements BudgetBackend {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async model(args: Record<string, unknown>): Promise<BudgetModel> {
    const outcome = await this.link.call('budget', 'model', args, {
      timeoutMs: BUDGET_MODEL_TIMEOUT_MS,
    })
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    return budgetModelOf(outcome.value)
  }

  async factor(model: string): Promise<number> {
    const outcome = await this.link.call(
      'budget',
      'factor',
      { model },
      { timeoutMs: BUDGET_FACTOR_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    const value = (outcome.value as { factor?: Json } | null)?.factor
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ServiceError('budget_bad_result', 'budget.factor returned no factor')
    }
    return value
  }

  async observe(
    model: string,
    estimate: number,
    usage: unknown,
  ): Promise<{ factor: number; usage: UsageManifest | null }> {
    const outcome = await this.link.call(
      'budget',
      'observe',
      { model, estimate, usage: (usage ?? null) as Json },
      { timeoutMs: BUDGET_OBSERVE_TIMEOUT_MS },
    )
    if (!outcome.ok) throw new ServiceError(outcome.code, outcome.message)
    if (!isRecord(outcome.value)) {
      throw new ServiceError('budget_bad_result', 'budget.observe returned a non-object')
    }
    const factor = outcome.value['factor']
    if (typeof factor !== 'number' || !Number.isFinite(factor)) {
      throw new ServiceError('budget_bad_result', 'budget.observe returned no factor')
    }
    const rawUsage = outcome.value['usage']
    return { factor, usage: isRecord(rawUsage) ? (rawUsage as unknown as UsageManifest) : null }
  }
}

/** 构造本插件的全部反向调用后端。 */
export function createBackends(link: PortCaller): ContextBackends {
  return { token: new RemoteTokenEstimate(link), budget: new RemoteBudget(link) }
}
