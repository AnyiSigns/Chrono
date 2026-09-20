// 原子落盘：temp → fsync 文件 → rename →（尽力）fsync 目录。
// journal / 基础世界 / 资产三处共用同一份持久化语义，避免各自漂移。

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * 整文件原子替换；父目录不存在则创建。
 * `mode` 可选：给出即按它落盘权限（如密钥文件 `0o600`）；Windows 不支持 POSIX 权限，忽略 mode 不报错。
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  const fd = openSync(temp, 'w', mode ?? 0o666)
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
  if (mode !== undefined && process.platform !== 'win32') {
    try {
      // 显式 chmod：open 的 mode 受 umask 削减，收紧权限须再确认一次
      chmodSync(file, mode)
    } catch {
      // 权限收紧尽力而为：不改写内容，失败不致命
    }
  }
  fsyncDir(dirname(file))
}

/** 目录 fsync：Windows 不支持目录句柄 fsync，失败即忽略（尽力而为）。 */
function fsyncDir(dir: string): void {
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
