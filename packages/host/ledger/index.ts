// 账本包出口：journal 文件读写、全量重放 / 校验、单写者锁。

export {
  appendJournal,
  archiveColdSegment,
  headOf,
  loadAnchor,
  readAllEntries,
  readColdEntries,
  readJournal,
  readJournalTolerant,
  repairJournalTail,
  replayFull,
  verifyFull,
  writeJournalAtomic,
} from './journal.ts'
export type { Anchor, JournalRead, VerifyReport } from './journal.ts'
export { readBase, writeBase, BASE_VERSION, LEGACY_BASE_VERSION, BASE_SHARD } from './base.ts'
export type { BaseFile } from './base.ts'
export { DefStore, createLazyDefs, DEFAULT_DEF_CACHE, DEFAULT_DEF_CACHE_BYTES } from './def-store.ts'
export type { DefStoreOptions, DefStoreStats } from './def-store.ts'
export { acquireLock, isProcessAlive, readLock, releaseLock } from './lock.ts'
export type { LockAcquired, LockBusy, LockInfo } from './lock.ts'
