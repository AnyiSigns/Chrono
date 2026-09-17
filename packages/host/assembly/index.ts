// 装配包出口：只读世界的声明解析与源码打包计划。
// 本包不 import effect / ledger 的写口——"不认识插件种类"由此成为 import 图上的事实。

export {
  listCommands,
  parsePluginDecl,
  readPluginDecl,
  resolveCommand,
  resolveTreeBlob,
  resolveTreeJson,
  termDefOf,
} from './decl.ts'
export type {
  CommandDecl,
  DeclRead,
  ParseDeclResult,
  PluginCommand,
  PluginDecl,
  PluginMember,
} from './decl.ts'
export { planIngest, resolvePackageRoot } from './ingest.ts'
export type { IngestPlan, IngestResult, PluginEntry } from './ingest.ts'
export { packSourceDir } from './source.ts'
export type { PackedSource } from './source.ts'
