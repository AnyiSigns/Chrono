// sweep 水位（住宿主侧 ③ `state/plugins/memory-consolidate/`，可重算、可统一 GC）。
// 语义：上次 sweep 的时间（ISO at）；下次只扫描 `at > 水位` 的条目（省本插件扫描，
// 不省 periodic.reads 的全量注入）。args.cursor 显式给出时优先，保证同输入同删除集。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = 'sweep-watermark.json'

/** ③ 目录：宿主起服务时以 `CHRONO_PLUGIN_STATE` 注入本身份路径；未注入则水位只驻内存。 */
export function resolveStateDir(): string | null {
  const dir = process.env['CHRONO_PLUGIN_STATE']
  return typeof dir === 'string' && dir.length > 0 ? dir : null
}

let memoryWatermark: string | null = null

/** 读水位：③ 文件优先，未注入目录时回落进程内存。 */
export function readWatermark(): string | null {
  const dir = resolveStateDir()
  if (dir === null) return memoryWatermark
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8'))
    return typeof parsed?.cursor === 'string' && parsed.cursor.length > 0 ? parsed.cursor : null
  } catch {
    return null
  }
}

/** 写水位：③ 可写则落盘；失败不致命（水位可重算），仍更新内存副本。 */
export function writeWatermark(cursor: string): void {
  memoryWatermark = cursor
  const dir = resolveStateDir()
  if (dir === null) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE_NAME), JSON.stringify({ cursor }), 'utf8')
  } catch {
    // 水位是 ③ 可重算产物：写失败只丢增量优化，不影响删除集正确性
  }
}
