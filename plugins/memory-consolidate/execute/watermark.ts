// sweep 水位（住宿主侧 ③ `state/plugins/memory-consolidate/`，可重算、可统一 GC）。
// 语义：上次 sweep 的时间（ISO at）；下次只扫描 `at > 水位` 的条目（省本插件扫描，
// 不省 periodic.reads 的全量注入）。args.cursor 显式给出时优先，保证同输入同删除集。

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const FILE_NAME = 'sweep-watermark.json'

/** 进程内写序号：与 pid 一起防同一目标文件的临时名相撞。 */
let writeSeq = 0

/** 崩溃残留的临时文件视为过期的阈值：活跃写者的临时文件不会存活这么久。 */
const STALE_TEMP_MS = 60 * 60 * 1000

/** 机会式回收：清理同目录中本模块遗留的过期临时文件，避免崩溃残留的 `.tmp` 堆积。 */
function sweepStaleTemps(dir: string, prefix: string): void {
  try {
    const cutoff = Date.now() - STALE_TEMP_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch {
        // 单文件 stat / 删除失败不影响本次写入
      }
    }
  } catch {
    // 目录不可读：跳过回收
  }
}

/** ③ 目录：宿主起服务时以 `CHRONO_PLUGIN_STATE` 注入本身份路径；未注入则水位只驻内存。 */
export function resolveStateDir(): string | null {
  const dir = process.env['CHRONO_PLUGIN_STATE']
  return typeof dir === 'string' && dir.length > 0 ? dir : null
}

let memoryWatermark: string | null = null

/** ISO 时间归一为 epoch 毫秒；非法回 null。 */
export function isoMs(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 时间先后判据：`at` 是否不晚于 `cursor`。
 * 两侧可带不同时区偏移 / 不同精度，故先归一为 epoch 毫秒再比较；无法解析时回落字典序（保持旧行为）。
 */
export function atOrBefore(at: string, cursor: string): boolean {
  const atMs = isoMs(at)
  const cursorMs = isoMs(cursor)
  if (atMs !== null && cursorMs !== null) return atMs <= cursorMs
  return at <= cursor
}

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

/**
 * 写水位：单调前进（仅当 cursor 大于当前水位才写，禁止回退），原子替换（临时文件 + rename）。
 * ③ 可写则落盘；失败不致命（水位可重算），仍更新内存副本。
 */
export function writeWatermark(cursor: string): void {
  const current = readWatermark()
  // 单调判据按时间归一：带偏移 / 不同精度的 ISO 串字典序会误判前进方向。
  if (current !== null && atOrBefore(cursor, current)) return
  memoryWatermark = cursor
  const dir = resolveStateDir()
  if (dir === null) return
  const target = join(dir, FILE_NAME)
  const temp = `${target}.${process.pid}.${writeSeq++}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    sweepStaleTemps(dir, `${basename(target)}.`)
    writeFileSync(temp, JSON.stringify({ cursor }), 'utf8')
    renameSync(temp, target)
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件可能尚未创建或已被 rename 消费：忽略
    }
    // 水位是 ③ 可重算产物：写失败只丢增量优化，不影响删除集正确性
  }
}
