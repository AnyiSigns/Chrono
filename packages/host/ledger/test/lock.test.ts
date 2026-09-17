import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { acquireLock, isProcessAlive, readLock, releaseLock } from '../index.ts'
import { join } from 'node:path'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'

describe('单写者锁', () => {
  let root: string
  let lockFile: string

  beforeEach(() => {
    root = createTempRoot()
    lockFile = join(root, 'state', 'runtime', 'lock.json')
  })

  afterEach(() => cleanupTempRoot(root))

  it('首次 acquire 成功，readLock 返回 pid 与 started_at', () => {
    const now = Date.now()
    const result = acquireLock(lockFile, now)
    expect(result.ok).toBe(true)
    const info = readLock(lockFile)
    expect(info).not.toBeNull()
    expect(info!.pid).toBe(process.pid)
    expect(info!.started_at).toBe(now)
  })

  it('同一进程重复 acquire → busy（文件已存在且持有者存活）', () => {
    acquireLock(lockFile, Date.now())
    const second = acquireLock(lockFile, Date.now())
    expect(second.ok).toBe(false)
    const busy = second as import('../index.ts').LockBusy
    expect(busy.code).toBe('writer_busy')
    expect(busy.holder).not.toBeNull()
    expect(busy.holder!.pid).toBe(process.pid)
  })

  it('死锁清理：持有者为不存在的 pid 时 acquire 可成功', () => {
    const deadPid = 9999999
    const { writeFileSync, mkdirSync } = require('node:fs')
    mkdirSync(require('node:path').dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, started_at: Date.now() }))
    expect(isProcessAlive(deadPid)).toBe(false)
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
  })

  it('releaseLock 幂等：重复调用不报错', () => {
    acquireLock(lockFile, Date.now())
    releaseLock(lockFile)
    expect(() => releaseLock(lockFile)).not.toThrow()
  })

  it('releaseLock 后再次 acquire 成功', () => {
    acquireLock(lockFile, Date.now())
    releaseLock(lockFile)
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
  })

  it('isProcessAlive 对当前进程返回 true', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('isProcessAlive 对不存在的 pid 返回 false', () => {
    expect(isProcessAlive(9999999)).toBe(false)
  })

  it('isProcessAlive 对 pid <= 0 返回 false', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
