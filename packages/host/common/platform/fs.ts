// 文件系统平台差异：目录链接类型（Windows junction / POSIX dir symlink）、POSIX 权限收紧、
// 目录 fsync（Windows 不支持目录句柄 fsync，失败即忽略），以及基于它们的原子落盘。
// 原子落盘语义：temp → fsync 文件 → rename →（尽力）fsync 目录，journal / 基础世界 /
// 资产 / 审计侧存等多处共用同一份持久化语义，避免各自漂移。

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { isWindows } from './os.ts'

/** 建目录链接：Windows 用 junction（无需权限、目录可用），POSIX 用 dir symlink。 */
export function symlinkDirOrJunction(linkPath: string, source: string): void {
  symlinkSync(source, linkPath, isWindows() ? 'junction' : 'dir')
}

/**
 * 整文件原子替换；父目录不存在则创建。
 * `mode` 可选：给出即按它落盘权限（如密钥文件 `0o600`）；Windows 不支持 POSIX 权限，忽略 mode 不报错。
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
  writeFileStaged(file, data, mode)
  if (mode !== undefined) chmodIfSupported(file, mode)
  fsyncDir(dirname(file))
}

/**
 * 批量落盘的底层步骤：temp → fsync 文件 → rename，**不 fsync 目录**。
 * 调用方在全部文件 rename 后调 `fsyncDir` 一次，把 N 次目录 fsync 合并为一次（compact 分片写入用）。
 * 每文件 fsync 保留：数据持久化不可省。
 */
export function writeFileStaged(file: string, data: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  const fd = openSync(temp, 'w', mode ?? 0o666)
  try {
    writeAllSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
}

/**
 * 写满整段：`writeSync` 可能短写（返回写入字节数小于请求），静默接受会丢尾部字节。
 * 逐段续写直到写完；零进展（返回 <= 0）即抛，不无限循环。
 */
export function writeAllSync(fd: number, data: string | Uint8Array): void {
  const buffer =
    typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error('short_write')
    offset += written
  }
}

/** POSIX 权限收紧：Windows 不支持 POSIX 权限，直接跳过；其余平台尽力而为，失败不致命。 */
export function chmodIfSupported(file: string, mode: number): void {
  if (isWindows()) return
  try {
    // 显式 chmod：open 的 mode 受 umask 削减，收紧权限须再确认一次
    chmodSync(file, mode)
  } catch {
    // 权限收紧尽力而为：不改写内容，失败不致命
  }
}

/** 目录 fsync：Windows 不支持目录句柄 fsync，失败即忽略（尽力而为）。 */
export function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // 平台不支持目录 fsync：忽略
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 已关闭
      }
    }
  }
}
