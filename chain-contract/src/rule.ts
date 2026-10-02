// 规则求值横切契约：`graph-run`（消费方）与 `loop-policy`（提供方）之间 when / pre / post 的中立形状单源。
// 消费插件经宿主准备阶段链接的 `node_modules/chain-contract` 裸导入本包，不再各写一份本地副本而漂移。
// 自包含：只 import 类型，不触网、不取时钟。
import type { Json, Rec } from './runtime.ts'

/** 规则求值上下文（解释器构造，经线协议序列化后由提供方反序列化）。 */
export interface RuleEvalCtx {
  nodeIndex: number
  outputs: Map<number, Rec>
  inputs: Map<number, Rec>
  shared: Rec
  thresholds: Rec
  state: Rec
  effLog: Json[]
}

/** `pre` / `post` 求值结果。 */
export interface RuleEvalResult {
  ok: boolean
  reason?: string
}

/** `when` 求值结果：`ok:false` 是结构化拒绝（未知 / 畸形判据），不是「条件不成立」。 */
export interface WhenEvalResult {
  ok: boolean
  value: boolean
  reason?: string
}
