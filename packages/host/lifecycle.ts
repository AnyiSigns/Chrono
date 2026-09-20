// 运维日志：宿主生命周期事件的唯一落点。
// 逐行原子追加 + fsync；不进世界、不进链、不参与重放。

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalJson } from '../kernel/index.ts'
import type { Json } from '../kernel/index.ts'

/** 运维日志事件的两级命名：`kind` 封闭、`event` 每 kind 有规范表（见 `docs/host.md` §五 其它）。 */
export type LifecycleKind = 'host' | 'dep' | 'handshake' | 'service'

/** 一条运维日志记录；`at` 必有，其余按事件取用；`seq` 仅换代类事件可选携带。 */
export interface LifecycleRecord {
  at: number
  kind: LifecycleKind
  event: string
  impl?: string
  gen?: string
  cap?: string
  reason?: string
  caps?: string[]
  seq?: number
  /** run 生命周期异常（如 `run_failed`）标注的宿主 run id。 */
  run?: string
}

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
