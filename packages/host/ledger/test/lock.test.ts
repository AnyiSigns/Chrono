import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { acquireLock, isProcessAlive, readLock, releaseLock } from '../index.ts'
import type { LockAcquired } from '../index.ts'
import { readLockRaw } from '../lock.ts'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
    mkdirSync(dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, started_at: Date.now() }))
    expect(isProcessAlive(deadPid)).toBe(false)
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
  })

  it('acquire 写入带 token 的完整锁文件，且不残留临时文件', () => {
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
    const info = readLock(lockFile)
    expect(info).not.toBeNull()
    expect(typeof info!.token).toBe('string')
    expect(readdirSync(dirname(lockFile))).toEqual(['lock.json'])
  })

  it('releaseLock 校验 expect：token 不符不删，符合才删', () => {
    const first = acquireLock(lockFile, Date.now()) as LockAcquired
    releaseLock(lockFile, { ...first.info, token: 'stale-token' })
    expect(readLock(lockFile)).not.toBeNull()
    releaseLock(lockFile, first.info)
    expect(readLock(lockFile)).toBeNull()
  })

  it('ABA：旧持有者的释放不删掉新持有者的新鲜锁', () => {
    const first = acquireLock(lockFile, 1000) as LockAcquired
    releaseLock(lockFile, first.info)
    const second = acquireLock(lockFile, 2000) as LockAcquired
    // 旧 expect 再释放一次：token 不符，不得删掉 second 的锁
    releaseLock(lockFile, first.info)
    expect(readLock(lockFile)?.started_at).toBe(2000)
    releaseLock(lockFile, second.info)
    expect(readLock(lockFile)).toBeNull()
  })

  it('损坏 / 空锁文件视为死锁清理，清理后不残留 .clean 互斥文件', () => {
    mkdirSync(dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, '')
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
    expect(readdirSync(dirname(lockFile))).toEqual(['lock.json'])
  })

  it('readLockRaw：文件不存在返回 exists:false（ENOENT 竞态不得误报存在）', () => {
    expect(readLockRaw(lockFile)).toEqual({ exists: false, info: null })
  })

  it('死锁 + 陈旧 .clean 互斥：回收后仍抢到锁，不误报 writer_busy', () => {
    const deadPid = 9999999
    mkdirSync(dirname(lockFile), { recursive: true })
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, started_at: Date.now() }))
    writeFileSync(`${lockFile}.clean`, JSON.stringify({ pid: deadPid, started_at: Date.now() }))
    const result = acquireLock(lockFile, Date.now())
    expect(result.ok).toBe(true)
    expect(readdirSync(dirname(lockFile))).toEqual(['lock.json'])
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
