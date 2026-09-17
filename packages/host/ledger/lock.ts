// 单写者锁：跨平台原子创建 + 存活检测；同一时刻只允许一个写者。
// 锁只是宿主侧 ③，不进世界；死锁（持有者已退出）由后到者清理。

import {
  closeSync,
  existsSync,
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
}

export interface LockAcquired {
  ok: true
}

export interface LockBusy {
  ok: false
  code: 'writer_busy'
  holder: LockInfo | null
}

/** 读锁信息；文件不存在或内容损坏都返回 null。 */
export function readLock(file: string): LockInfo | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>
    if (typeof parsed.pid !== 'number') return null
    return {
      pid: parsed.pid,
      started_at: typeof parsed.started_at === 'number' ? parsed.started_at : 0,
    }
  } catch {
    // 半写 / 损坏的锁文件等同于无有效持有者，交由 acquire 清理
    return null
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

/** 抢锁：原子创建独占文件；已存在且持有者存活即 `writer_busy`，否则清理死锁后重试。 */
export function acquireLock(file: string, now: number): LockAcquired | LockBusy {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started_at: now }))
      } finally {
        closeSync(fd)
      }
      return { ok: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = readLock(file)
    if (holder && isProcessAlive(holder.pid)) {
      return { ok: false, code: 'writer_busy', holder }
    }
    try {
      unlinkSync(file)
    } catch {
      // 竞争清理：另一个进程已先一步删掉，下一轮 open 会重新定论
    }
  }
  return { ok: false, code: 'writer_busy', holder: readLock(file) }
}

/** 释放锁；文件已不在也无妨。 */
export function releaseLock(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // 幂等释放：重复调用或已被清理都视为成功
  }
}
