// `budget` 服务内部类型：预算模型、配额上限与真实用量形状。
// 跨身份不 import：消费方 `context-window` 保留同口径的本地类型。

/** 内核口径的 JSON 值（协议帧载荷）。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 预算来源：模型档案给出，或缺失时回落默认值。 */
export type BudgetOrigin = 'profile' | 'default'

/** 每来源配额上限（token，占预算比例取整；未用额度下滚给历史）。 */
export interface QuotaCaps {
  l2: number
  l1: number
  skill: number
  recall: number
  style: number
}

/** 预算模型：总预算标量、窗口 / 输出保留 / 余量与每来源配额上限。 */
export interface BudgetModel {
  budget: number
  context_window: number
  max_output: number
  margin: number
  origin: BudgetOrigin
  flags: string[]
  quota: QuotaCaps
}

/** 真实用量解析结果（缓存命中率由此可观测）。 */
export interface UsageManifest {
  prompt_tokens: number
  cached_tokens: number
  cache_creation_tokens: number
  completion_tokens: number
  hit_rate: number | null
  correction_factor: number | null
}
