// 账本包出口：journal 文件读写、全量重放 / 校验、单写者锁。

export {
  appendJournal,
  headOf,
  loadAnchor,
  readJournal,
  replayFull,
  verifyFull,
} from './journal.ts'
export type { Anchor, VerifyReport } from './journal.ts'
export { acquireLock, isProcessAlive, readLock, releaseLock } from './lock.ts'
export type { LockAcquired, LockBusy, LockInfo } from './lock.ts'
