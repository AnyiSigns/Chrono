// 源码 watcher 出口：监听投递路径 → 重新入世 → 交装配跟随（宿主热更能力，默认关）。

export { DEFAULT_WATCH_DEBOUNCE_MS, Debouncer } from './debounce.ts'
export { isPackedChange, watchPathSegments } from './ignore.ts'
export { reloadPlugin } from './reload.ts'
export type { ReloadDeps, ReloadOutcome } from './reload.ts'
export { resolveWatchTargets, startSourceWatcher } from './watcher.ts'
export type { SourceWatcherHandle, SourceWatcherOptions, WatchTarget } from './watcher.ts'
