// `plugin.validate` → `plugin.write` 强制顺序的机械凭据（住宿主 ③，可重算、不进世界）。
// 键 = 候选树规范化哈希（见 README「候选树规范化哈希」），值 = 上次 validate 的 result_hash。
// 候选树一变键就变 ⇒ 缓存自然失效；write 另比对算出的 commit 哈希与缓存值，防口径漂移。

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { stateDir } from './config.ts'
import { isRecord } from './plan.ts'
import type { Rec } from './types.ts'

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
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        // 单文件 stat / 删除失败不影响本次写入
      }
    }
  } catch {
    // 目录不可读：跳过回收
  }
}

export interface ValidateCacheEntry {
  identity: string
  result_hash: string
  at: number
}

function cacheDir(): string {
  return join(stateDir(), 'validate')
}

function cacheFile(key: string): string {
  return join(cacheDir(), `${key}.json`)
}

/** 原子写：先写同目录唯一临时文件再 rename 替换，读方永不看到半截 JSON。 */
function writeFileAtomic(file: string, data: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    sweepStaleTemps(dirname(file), `${basename(file)}.`)
    writeFileSync(temporary, data, 'utf8')
    renameSync(temporary, file)
  } catch (err) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 临时文件清理失败不掩盖原始错误
    }
    throw err
  }
}

/** 写一条 validate 凭据；写失败不阻断 validate（下次 write 按缺失报 validate_required）。 */
export function writeValidateCache(key: string, entry: ValidateCacheEntry): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileAtomic(cacheFile(key), JSON.stringify(entry))
  } catch {
    // ③ 写失败不阻断 validate：下次 write 会按缺失报 validate_required
  }
}

/** 读一条 validate 凭据；缺失 / 损坏 / 形态非法 → null。 */
export function readValidateCache(key: string): ValidateCacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(key), 'utf8')) as unknown
    if (!isRecord(parsed as Rec)) return null
    const rec = parsed as Rec
    if (typeof rec['result_hash'] !== 'string') return null
    return {
      identity: typeof rec['identity'] === 'string' ? rec['identity'] : '',
      result_hash: rec['result_hash'],
      at: typeof rec['at'] === 'number' ? rec['at'] : 0,
    }
  } catch {
    return null
  }
}

/** 删除一条凭据（校验失败 / 哈希不符时清掉旧值，避免误用）。 */
export function clearValidateCache(key: string): void {
  try {
    rmSync(cacheFile(key), { force: true })
  } catch {
    // 缺失即幂等
  }
}
