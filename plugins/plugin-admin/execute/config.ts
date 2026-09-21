// 运行期参数与 ③ 缓存目录：源码大小上限从同包 schema 读（缺省回落常量），
// 缓存目录取宿主注入的 CHRONO_PLUGIN_STATE（服务 ③，可重算；无注入时回落临时目录）。

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from './plan.ts'
import type { Json } from './types.ts'

/** 缺省源码总字节上限（schema 未声明 / 不可读时）。 */
export const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024
/** 缺省候选文件数上限。 */
export const DEFAULT_MAX_FILES = 2048

export interface Limits {
  maxSourceBytes: number
  maxFiles: number
}

function positiveInt(value: Json | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 读同包 schema 的非安全参数；文件缺失 / 形态非法回落缺省。 */
export function resolveLimits(): Limits {
  try {
    const text = readFileSync(new URL('../schema/plugin-admin.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRecord(parsed)) {
      return {
        maxSourceBytes: positiveInt(parsed['max_source_bytes'], DEFAULT_MAX_SOURCE_BYTES),
        maxFiles: positiveInt(parsed['max_files'], DEFAULT_MAX_FILES),
      }
    }
  } catch {
    // schema 不可读不是致命：用缺省门禁
  }
  return { maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES, maxFiles: DEFAULT_MAX_FILES }
}

/** 服务 ③ 目录：宿主起服务时以 CHRONO_PLUGIN_STATE 注入。 */
export function stateDir(): string {
  const injected = process.env['CHRONO_PLUGIN_STATE']
  if (typeof injected === 'string' && injected.length > 0) return injected
  return join(tmpdir(), 'chrono-plugin-admin-state')
}
