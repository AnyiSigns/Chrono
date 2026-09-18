// 原子落盘：temp → fsync 文件 → rename →（尽力）fsync 目录。
// journal / 基础世界 / 资产三处共用同一份持久化语义，避免各自漂移。

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/** 整文件原子替换；父目录不存在则创建。 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${randomUUID()}`
  const fd = openSync(temp, 'w')
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, file)
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
