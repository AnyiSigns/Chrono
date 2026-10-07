// 定义表访问抽象：内核只认识「按哈希读 def」「按哈希判存在」「列出 def 键」三件事，
// 具体存储（内存 map 或惰性分片）由调用方决定。宿主侧用惰性代理实现按需加载，
// 内核经本模块的全局符号识别惰性表并做廉价克隆，避免 `{...defs}` 展开整张表。
//
// 普通内存表与惰性表对外行为一致：克隆、判存在、列键语义相同，只是惰性表不读 body。
// 零 IO：只做符号分派与薄封装。

import type { Def, Hash } from './types.ts'

/** 惰性 defs 句柄的全局符号：内核与宿主按同一符号识别，跨包不共享模块实例。 */
export const LAZY_DEFS = Symbol.for('chrono.lazyDefs')

/** 惰性 defs 表暴露给内核的最小面：不读 body 的判存在 / 列键，以及廉价克隆。 */
export interface LazyDefsHandle {
  has(hash: Hash): boolean
  hashes(): Hash[]
  clone(): Record<Hash, Def>
}

function handleOf(defs: Record<Hash, Def>): LazyDefsHandle | undefined {
  return (defs as unknown as Record<symbol, LazyDefsHandle | undefined>)[LAZY_DEFS]
}

/** 复制 defs 表：惰性表走其廉价克隆，普通表浅拷贝（保持既有「复制可写层」语义）。 */
export function cloneDefs(defs: Record<Hash, Def>): Record<Hash, Def> {
  const handle = handleOf(defs)
  return handle !== undefined ? handle.clone() : { ...defs }
}

/** 键存在判定：惰性表查清单（不读 body），普通表查自有键。 */
export function defHas(defs: Record<Hash, Def>, hash: Hash): boolean {
  const handle = handleOf(defs)
  return handle !== undefined ? handle.has(hash) : Object.hasOwn(defs, hash)
}

/** def 键清单：惰性表回清单（不读 body），普通表回自有键。 */
export function defsKeys(defs: Record<Hash, Def>): Hash[] {
  const handle = handleOf(defs)
  return handle !== undefined ? handle.hashes() : Object.keys(defs)
}
