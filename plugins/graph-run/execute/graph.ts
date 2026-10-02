// 图拓扑工具真源在 `plugin-sdk`（graph-gate / graph-run 共用同一口径，避免两份复刻漂移）。
// 本文件保留同名 re-export 面，供本包既有直接 import 解析。

export { buildTopology, edgeEndpoints, edgeKey, hasCycle, reachableSet, reaches, topoOrder } from 'plugin-sdk'
export type { Topology } from 'plugin-sdk'
