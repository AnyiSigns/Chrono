// 运维日志：宿主生命周期事件的唯一落点。
// 逐行原子追加 + fsync；不进世界、不进链、不参与重放。

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'

/** 追加一条生命周期事件；文件不存在则连同父目录一起创建。 */
export function appendLifecycle(file: string, event: Json): void {
  mkdirSync(dirname(file), { recursive: true })
  const line = canonicalJson(event) + '\n'
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
