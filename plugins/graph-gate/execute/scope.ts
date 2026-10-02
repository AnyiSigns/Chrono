// 实例选择真源在 `plugin-sdk`（graph-gate 语义 owner 与 graph-run 共用同一口径）：
// 先按 `scope` 过滤候选集，再按确定性 tie-break 取首；强制点在实例选择（机械、不可绕过）。
// 本文件保留同名 re-export 面，供本包既有直接 import 解析。

export { isolationRank, scopeMatches, selectInstance } from 'plugin-sdk'
export type { ChosenInstance, ScopeCtx } from 'plugin-sdk'
