// `budget` 服务类型：JSON 值沿用本地定义；预算 / 用量横切契约单源在 `chain-contract`。
// 提供方 `budget` 与消费方 `context-window` 共用同一份契约，不再各写本地副本。

/** 内核口径的 JSON 值（协议帧载荷）。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type { BudgetModel, BudgetOrigin, QuotaCaps, UsageManifest } from 'chain-contract'
