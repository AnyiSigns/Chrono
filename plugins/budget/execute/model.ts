// 预算建模：窗 − 输出 − 余量 → 预算标量，并按预算比例给出每来源配额上限。
// 只有 P0 本身超窗的硬错误判定留消费方；本模块只管建模，缺档案回落保守默认并标 `profile_missing`。

import type { BudgetModel, QuotaCaps } from './types.ts'

/** 预算建模入参：模型档案 `config` 与消费方生效的 policy 数值（单一真源在消费方）。 */
export interface BudgetParams {
  config: Record<string, unknown> | null
  margin_ratio: number
  default_context_window: number
  default_max_output: number
  quota: QuotaCaps
}

/** 缺省建模参数（消费方未下传时回落；与随包默认同值）。 */
export const DEFAULT_PARAMS: BudgetParams = {
  config: null,
  margin_ratio: 0.05,
  default_context_window: 8192,
  default_max_output: 1024,
  quota: { l2: 0.08, l1: 0.08, skill: 0.1, recall: 0.12, style: 0.03 },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function ratioOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 从 `config` 取模型档案，缺档案回落默认；`profile_missing` 标记输出保留是否回落。 */
export function computeBudget(params: BudgetParams): BudgetModel {
  const config = params.config
  const flags: string[] = []
  const contextWindow = positiveNumber(config?.['context_window'])
  const maxOutput = positiveNumber(config?.['max_output'])
  const window = contextWindow ?? params.default_context_window
  const output = maxOutput ?? params.default_max_output
  if (contextWindow === null || maxOutput === null) flags.push('profile_missing')
  const margin = Math.floor(window * params.margin_ratio)
  // 输出不静态预留：输入预算 = 窗 − 余量（余量是整体安全头寸），输出在请求期按剩余动态给
  // （消费方取 `max_tokens = min(max_output, 窗 − 已用输入)`），这样输入能尽量用满模型窗。
  // `max_output` 只作请求输出上限的天花板，夹到不超过窗本身。
  const budget = window - margin
  const cap = (ratio: number): number => Math.floor(budget * ratio)
  return {
    budget,
    context_window: window,
    max_output: Math.min(output, window),
    margin,
    origin: contextWindow === null || maxOutput === null ? 'default' : 'profile',
    flags,
    quota: {
      l2: cap(ratioOf(params.quota.l2, DEFAULT_PARAMS.quota.l2)),
      l1: cap(ratioOf(params.quota.l1, DEFAULT_PARAMS.quota.l1)),
      skill: cap(ratioOf(params.quota.skill, DEFAULT_PARAMS.quota.skill)),
      recall: cap(ratioOf(params.quota.recall, DEFAULT_PARAMS.quota.recall)),
      style: cap(ratioOf(params.quota.style, DEFAULT_PARAMS.quota.style)),
    },
  }
}

/** 归一化调用方下传的建模参数；缺键回落默认。 */
export function parseParams(args: Record<string, unknown>): BudgetParams {
  const policy = isRecord(args['policy']) ? args['policy'] : {}
  const quota = isRecord(policy['quota']) ? policy['quota'] : {}
  const config = args['config']
  return {
    config: isRecord(config) ? config : null,
    margin_ratio: ratioOf(policy['margin_ratio'], DEFAULT_PARAMS.margin_ratio),
    default_context_window: ratioOf(
      policy['default_context_window'],
      DEFAULT_PARAMS.default_context_window,
    ),
    default_max_output: ratioOf(policy['default_max_output'], DEFAULT_PARAMS.default_max_output),
    quota: {
      l2: ratioOf(quota['l2'], DEFAULT_PARAMS.quota.l2),
      l1: ratioOf(quota['l1'], DEFAULT_PARAMS.quota.l1),
      skill: ratioOf(quota['skill'], DEFAULT_PARAMS.quota.skill),
      recall: ratioOf(quota['recall'], DEFAULT_PARAMS.quota.recall),
      style: ratioOf(quota['style'], DEFAULT_PARAMS.quota.style),
    },
  }
}
