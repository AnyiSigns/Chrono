// 宿主公共面：进程起停、离线命令、路径解析与协议形状。
// 评审只从本面导入；加导出 = 改规格。

export { startHost } from './host.ts'
export type { HostHandle, HostOptions } from './host.ts'
export { readPluginManifest, runReplay, runSeed, runVerify } from './offline.ts'
export type { ReplayReport, SeedItem, SeedReport, VerifyReport } from './offline.ts'
export type { PluginEntry } from './assembly/index.ts'
export { hostPaths, resolveRoot, socketPath } from './paths.ts'
export type { HostPaths } from './paths.ts'
export { PROTOCOL_VERSION } from './wire.ts'
export type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
