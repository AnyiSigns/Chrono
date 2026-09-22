// 装配包出口：只读世界的声明解析、源码打包计划、pins 闭包与装配计划。
// 本包不 import effect / ledger 的写口——"不认识插件种类"由此成为 import 图上的事实。

export { buildOwnerIndex, computeAssemblyPlan } from './closure.ts'
export type { AssemblyPlan, DependencyEdge, IsolatedIdentity, IsolatedReason } from './closure.ts'
export {
  assemblyGen,
  DEFAULT_SCHEMA_BODY,
  isCodeGen,
  latestCodeGen,
  latestDataGen,
  listCommands,
  parsePluginDecl,
  readPluginDecl,
  readPluginDeclOfGen,
  resolveCommand,
  resolveTreeBlob,
  resolveTreeEntry,
  resolveTreeJson,
  termDefOf,
} from './decl.ts'
export type {
  CommandDecl,
  DeclRead,
  ParseDeclResult,
  PluginBuildStep,
  PluginCommand,
  PluginDecl,
  PluginMember,
  TreeEntryRef,
} from './decl.ts'
export { classifyGenerationChange } from './generation.ts'
export type { GenerationChange } from './generation.ts'
export { validateArgs, validateArgsSchema } from './args-schema.ts'
export type { ArgsSchemaCheck } from './args-schema.ts'
export {
  orderEntriesForSeed,
  planIngest,
  planPack,
  readPluginManifest,
  resolvePluginSourceRoot,
} from './ingest.ts'
export type { IngestPlan, IngestResult, PluginEntry } from './ingest.ts'
export { copyAssetsManifest, readAssetsManifest } from './assets-manifest.ts'
export type { AssetManifestEntry, AssetsManifestRead } from './assets-manifest.ts'
export {
  gcMaterialized,
  MATERIALIZED_KEEP_GENERATIONS,
  materializeCommit,
  materializedKeepSet,
} from './materialize.ts'
export type { MaterializedGcReport } from './materialize.ts'
export { startAssembly } from './runtime.ts'
export type { AssemblyRuntimeHandle, LoadedIdentity, StartAssemblyOptions } from './runtime.ts'
