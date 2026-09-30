// 平台适配层单测：地址派生分支、目录链接形态、原子落盘 + 权限收紧、进程存活探针。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  chmodIfSupported,
  detachedProcessGroup,
  fsyncDir,
  isProcessAlive,
  isWindows,
  socketAddress,
  symlinkDirOrJunction,
  writeFileAtomic,
} from '../index.ts'
import { createTempRoot, cleanupTempRoot } from '../../../test/test-helpers.ts'

describe('平台适配层', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await cleanupTempRoot(root)
  })

  it('socketAddress：win32 为根摘要命名管道，其余为 UDS 文件', () => {
    const address = socketAddress(root)
    if (isWindows()) {
      expect(address).toMatch(/^\\\\\.\\pipe\\chrono-host-[0-9a-f]{16}$/)
    } else {
      expect(address).toBe(resolve(root, 'state', 'sock', 'host.sock'))
    }
  })

  it('symlinkDirOrJunction 建出的链接可解析到目标内容', () => {
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'marker.txt'), 'ok')
    const link = join(root, 'link')
    symlinkDirOrJunction(link, source)
    expect(existsSync(join(link, 'marker.txt'))).toBe(true)
    expect(readFileSync(join(link, 'marker.txt'), 'utf8')).toBe('ok')
  })

  it('writeFileAtomic 创建父目录、写内容；fsyncDir 不抛', () => {
    const file = join(root, 'nested', 'deep', 'file.txt')
    writeFileAtomic(file, 'hello')
    expect(readFileSync(file, 'utf8')).toBe('hello')
    expect(() => fsyncDir(join(root, 'nested', 'deep'))).not.toThrow()
  })

  it('chmodIfSupported：POSIX 收紧权限；Windows 为无操作', () => {
    const file = join(root, 'secret.txt')
    writeFileSync(file, 'x')
    expect(() => chmodIfSupported(file, 0o600)).not.toThrow()
    if (!isWindows()) {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('isProcessAlive：当前进程存活，非法 / 不存在 pid 为假', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(9_999_999)).toBe(false)
  })

  it('detachedProcessGroup：仅 POSIX 建独立进程组', () => {
    expect(detachedProcessGroup()).toBe(!isWindows())
  })
})
