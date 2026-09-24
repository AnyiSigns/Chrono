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
export { auditRefOf, readBase, writeBase, BASE_VERSION } from './base.ts'
export type { BaseAuditRef, BaseFile } from './base.ts'
export { acquireLock, isProcessAlive, readLock, releaseLock } from './lock.ts'
export type { LockAcquired, LockBusy, LockInfo } from './lock.ts'
