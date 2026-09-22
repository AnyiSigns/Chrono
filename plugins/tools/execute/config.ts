// 私有参数：并发上限与结果缓存（声明住 schema/tools.json，服务侧用同一缺省）。
// 单次调用可用 bag.concurrency / bag.cache 覆盖；非法值回落缺省，不抛。

import { isRecord } from './types.ts'
import type { Rec } from './types.ts'

/** 整批 dispatch 的进程内并发缺省上限（schema 同值）。 */
export const DEFAULT_CONCURRENCY = 4

/** 并发上限硬顶：防单次调用把并发开到失控。 */
export const MAX_CONCURRENCY = 64

/** 结果缓存条目缺省上限（schema 同值）。 */
export const DEFAULT_CACHE_MAX_ENTRIES = 256

/** 解析单次 dispatch 的并发上限：bag 覆盖 > 缺省；非法回落缺省，超硬顶截断。 */
export function resolveConcurrency(bag: Rec, fallback: number = DEFAULT_CONCURRENCY): number {
  const raw = bag['concurrency']
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    return Math.min(raw, MAX_CONCURRENCY)
  }
  return Math.min(fallback, MAX_CONCURRENCY)
}

/** 解析单次 dispatch 是否启用结果缓存：bag.cache === false 显式关闭。 */
export function resolveCacheEnabled(bag: Rec, fallback: boolean): boolean {
  if (bag['cache'] === false) return false
  if (isRecord(bag['cache']) && bag['cache']['enabled'] === false) return false
  return fallback
}
