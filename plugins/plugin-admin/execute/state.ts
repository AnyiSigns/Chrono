// `plugin.validate` → `plugin.write` 强制顺序的机械凭据（住宿主 ③，可重算、不进世界）。
// 键 = 候选树规范化哈希（见 README「候选树规范化哈希」），值 = 上次 validate 的 result_hash。
// 候选树一变键就变 ⇒ 缓存自然失效；write 另比对算出的 commit 哈希与缓存值，防口径漂移。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './config.ts'
import { isRecord } from './plan.ts'
import type { Rec } from './types.ts'

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

/** 写一条 validate 凭据（原子性不作强求：③ 可重算，损坏按缺失处理）。 */
export function writeValidateCache(key: string, entry: ValidateCacheEntry): void {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(cacheFile(key), JSON.stringify(entry), 'utf8')
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
