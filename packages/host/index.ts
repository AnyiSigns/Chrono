// 宿主公共面：进程起停、离线命令、路径解析与协议形状。
// 评审只从本面导入；加导出 = 改规格。

export { startHost } from './host.ts'
export type { HostHandle, HostOptions } from './host.ts'
export {
  readPluginManifest,
  runAssetGc,
  runBlobGc,
  runCompact,
  runMaterializedGc,
  runPack,
  runReplay,
  runRetire,
  runSeed,
  runVerify,
  unseededIdentities,
} from './offline.ts'
export type {
  CompactOptions,
  CompactReport,
  PackReport,
  ReplayReport,
  RetireReport,
  SeedItem,
  SeedReport,
  VerifyReport,
} from './offline.ts'
export {
  classifySource,
  listPlugins,
  readManagedManifest,
  registerPlugin,
  removePlugin,
  stagePlugin,
  unregisterPlugin,
} from './admin.ts'
export type {
  InstalledPlugin,
  ManagedEntry,
  RemoveReport,
  SourceKind,
  StageOptions,
  StagedPlugin,
} from './admin.ts'
export type { AssetGcReport, AssetRef } from './assets.ts'
export type { BlobGcReport } from './blobs.ts'
export type { MaterializedGcReport } from './assembly/index.ts'
export type { PortAuditRecord, PortAuditSink } from './port-audit.ts'
export type { PluginEntry } from './assembly/index.ts'
export { hostPaths, resolveRoot, socketPath } from './paths.ts'
export type { HostPaths } from './paths.ts'
export {
  parseEntryArgv,
  resolveCallTimeoutMs,
  resolveCompactStrict,
  resolveStartWrapper,
  resolveWatch,
} from './options.ts'
export type { EntryOptions } from './options.ts'
export { PROTOCOL_VERSION } from './wire.ts'
export type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
