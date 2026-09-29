// 反向调用后端抽象（服务 → 宿主，docs/protocol.md §2.4）：跨身份不 import，消费方保留本地类型，
// 经 `port.call` 取数。生产环境是 `port-link.ts` 的远程实现；单测注入假后端。
// 本插件消费 `token-estimate`（批量计数）与 `budget`（预算建模 / 系数 / 校准）。

import type { BudgetModel } from './budget.ts'
import type { UsageManifest } from './types.ts'

/** `token-estimate` 后端：批量计数与规格版本。 */
export interface TokenBackend {
  /** 一次收一组文本、回同序计数数组（热路径一轮只发一次）。 */
  count(texts: string[]): Promise<number[]>
  /** 估算器规格版本。 */
  version(): Promise<string>
}

/** `budget` 后端：预算建模、每模型系数、以真实用量更新 EWMA。 */
export interface BudgetBackend {
  /** 窗 − 输出 − 余量 → 预算标量与配额上限。 */
  model(args: Record<string, unknown>): Promise<BudgetModel>
  /** 当前生效的每模型校正系数（无则 1）。 */
  factor(model: string): Promise<number>
  /** 以真实 usage 更新系数；返回更新后系数与该次解析出的用量形状。 */
  observe(
    model: string,
    estimate: number,
    usage: unknown,
  ): Promise<{ factor: number; usage: UsageManifest | null }>
}

/** 一次装配所依赖的反向调用后端。 */
export interface ContextBackends {
  token: TokenBackend
  budget: BudgetBackend
}
