// 预算 / 用量横切契约：`budget`（提供方）与 `context-window`（消费方）之间经线协议交换的形状单源。
// 消费插件经宿主准备阶段链接的 `node_modules/chain-contract` 裸导入本包（红线 1 白名单），
// 不再各写一份本地副本，避免任一方改字段后静默脱节。
// 自包含：不 import 任何模块、不触网、不取时钟。

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

/** 预算模型：`budget.model` 的返回形状。 */
export interface BudgetModel {
  budget: number
  context_window: number
  max_output: number
  margin: number
  origin: BudgetOrigin
  flags: string[]
  quota: QuotaCaps
}

/** 真实用量解析结果（缓存命中率由此可观测）；`budget.observe` 回值。 */
export interface UsageManifest {
  prompt_tokens: number
  cached_tokens: number
  cache_creation_tokens: number
  completion_tokens: number
  hit_rate: number | null
  correction_factor: number | null
}
