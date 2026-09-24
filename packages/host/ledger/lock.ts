// 单写者锁：跨平台原子创建 + 存活检测；同一时刻只允许一个写者。
// 锁只是宿主侧 ③，不进世界；死锁（持有者已退出）由后到者清理。
//
// 抢锁用「唯一临时文件 → fsync → link 到锁文件」：link 是原子且**带内容**的独占创建，
// 消除了 `open('wx')` 建空文件到 `writeSync` 之间的窗口（后到者不会读到空锁而误判可抢）。
// 释放按 token 校验持有者身份，避免 ABA（旧释放删掉他人刚建立的新鲜锁）。

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

export interface LockInfo {
  pid: number
  started_at: number
  /** 抢锁者本次获取的唯一标识；旧格式锁可能没有。 */
  token?: string
}

export interface LockAcquired {
  ok: true
  /** 本次获取的持有者信息；释放时原样回传给 `releaseLock` 做身份校验。 */
  info: LockInfo
}

export interface LockBusy {
  ok: false
  code: 'writer_busy'
  holder: LockInfo | null
}

/** 读锁信息；文件不存在或内容损坏都返回 null。 */
export function readLock(file: string): LockInfo | null {
  return readLockRaw(file).info
}

/** 读锁并区分「不存在」与「存在但损坏」：清理路径据此决定是否可删。 */
export function readLockRaw(file: string): { exists: boolean; info: LockInfo | null } {
  if (!existsSync(file)) return { exists: false, info: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof parsed.pid !== 'number') return { exists: true, info: null }
    const info: LockInfo = {
      pid: parsed.pid,
      started_at: typeof parsed.started_at === 'number' ? parsed.started_at : 0,
    }
    if (typeof parsed.token === 'string') info.token = parsed.token
    return { exists: true, info }
  } catch (err) {
    // 读窗口内被并发删除（ENOENT 竞态）等同「不存在」，不得误报存在
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, info: null }
    // 半写 / 损坏的锁文件等同于无有效持有者，交由 acquire 清理
    return { exists: true, info: null }
  }
}

/** 进程存活：`kill(pid, 0)` 探针；EPERM 表示存在但无权限，视为存活。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 持有者身份一致：pid + started_at 必比；双方都有 token 时 token 也须一致。 */
function sameHolder(current: LockInfo, expect: LockInfo): boolean {
  if (current.pid !== expect.pid || current.started_at !== expect.started_at) return false
  if (current.token !== undefined && expect.token !== undefined) {
    return current.token === expect.token
  }
  return true
}

/**
 * 原子独占创建：先写唯一临时文件（fsync 后关闭），再 link 到目标路径。
 * link 命中已存在目标即 `exists`（原子失败）；临时文件无论成败都清掉。
 * 硬链接不可用的文件系统（EPERM / ENOSYS / EXDEV）退回 `open('wx')` 独占创建：
 * 该路径在「建空文件」到「写入内容」之间有窗口，但只在无硬链接的 FS 上启用；
 * token 内容照写，后到者至多读到空锁并按损坏锁清理，不会误判为有效持有者。
 */
function createExclusive(file: string, info: LockInfo): 'created' | 'exists' {
  const temp = `${file}.${process.pid}.${info.token ?? 'x'}.tmp`
  try {
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, JSON.stringify(info))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temp, file)
      return 'created'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return 'exists'
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EXDEV') {
        return createExclusiveWithoutLink(file, info)
      }
      throw err
    }
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件可能尚未创建或已被清理：不影响定论
    }
  }
}

/** 无硬链接 FS 的兜底独占创建：`open('wx')` 命中已存在即 `exists`；内容照写（保留 token）。 */
function createExclusiveWithoutLink(file: string, info: LockInfo): 'created' | 'exists' {
  let fd: number
  try {
    fd = openSync(file, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw err
  }
  try {
    writeSync(fd, JSON.stringify(info))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return 'created'
}

/**
 * 清理一把死锁：经 `lockfile+'.clean'` 清理互斥串行，抢到后**重读**确认仍是同一死锁再删。
 * 重读确保不会删掉「观察后已被他人清理、又被新持有者接管」的锁（ABA）。
 */
function cleanupDeadLock(file: string, observed: LockInfo | null): void {
  const cleanFile = `${file}.clean`
  const cleanInfo: LockInfo = { pid: process.pid, started_at: Date.now(), token: randomUUID() }
  if (createExclusive(cleanFile, cleanInfo) !== 'created') {
    // 另一清理者在跑：若它已死则回收一次再试，否则本轮放弃（下次 acquire 再定论）
    const holder = readLock(cleanFile)
    if (holder !== null && isProcessAlive(holder.pid)) return
    try {
      unlinkSync(cleanFile)
    } catch {
      return
    }
    if (createExclusive(cleanFile, cleanInfo) !== 'created') return
  }
  try {
    const current = readLockRaw(file)
    if (!current.exists) return
    if (current.info !== null && isProcessAlive(current.info.pid)) return
    if (!sameObserved(observed, current.info)) return
    try {
      unlinkSync(file)
    } catch {
      // 竞争清理：另一个进程已先一步删掉，下一轮 open 会重新定论
    }
  } finally {
    try {
      unlinkSync(cleanFile)
    } catch {
      // 清理互斥的释放是尽力而为
    }
  }
}

/** 重读结果与初次观察是否同一（null = 损坏锁；损坏对损坏视为同一，可清）。 */
function sameObserved(observed: LockInfo | null, current: LockInfo | null): boolean {
  if (observed === null) return current === null
  if (current === null) return false
  return sameHolder(current, observed)
}

/** 抢锁尝试上限：死锁清理成功后再给一次独占创建机会，避免「末次清理成功却仍报 busy」。 */
const MAX_LOCK_ATTEMPTS = 3

/** 抢锁：原子创建独占文件；已存在且持有者存活即 `writer_busy`，否则清理死锁后重试。 */
export function acquireLock(file: string, now: number): LockAcquired | LockBusy {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    const info: LockInfo = { pid: process.pid, started_at: now, token: randomUUID() }
    if (createExclusive(file, info) === 'created') return { ok: true, info }
    const holder = readLock(file)
    if (holder && isProcessAlive(holder.pid)) {
      return { ok: false, code: 'writer_busy', holder }
    }
    cleanupDeadLock(file, holder)
  }
  return { ok: false, code: 'writer_busy', holder: readLock(file) }
}

/**
 * 释放锁；文件已不在也无妨。
 * 给了 `expect` 则读回校验 pid + started_at（+ token）一致才删，防 ABA；
 * 未给 `expect` 时只释放本进程持有的锁（旧调用点兼容）。
 */
export function releaseLock(file: string, expect?: LockInfo): void {
  const current = readLock(file)
  if (current === null) return
  if (expect !== undefined) {
    if (!sameHolder(current, expect)) return
  } else if (current.pid !== process.pid) {
    return
  }
  try {
    unlinkSync(file)
  } catch {
    // 幂等释放：重复调用或已被清理都视为成功
  }
}
