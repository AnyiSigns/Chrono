// 日志与世界（kernel.md）：空世界常量、链位置、锚点、重放与段校验。
// 逐 op 的机械语义在 journal.apply.ts（允许的点分段拆分），本文件转口其公共件。

import { KernelError } from './types.ts'
import type { Def, Entry, Head, Hash, Identity, World } from './types.ts'
import { applyEntry } from './journal.apply.ts'
import { entryHash, worldRev } from './journal.id.ts'

export { applyEntry, entryHash, worldRev }

// 冻结（含内层 map）：兑现"空世界字面量只读"——误用未克隆的 EMPTY_WORLD 就地写入会当场抛
export const EMPTY_WORLD: World = Object.freeze({
  defs: Object.freeze<Record<Hash, Def>>({}),
  ids: Object.freeze<Record<string, Identity>>({}),
})

/** 空链头：首条 entry 的 seq = 0、prev = null。 */
export const EMPTY_HEAD: Head = Object.freeze({ seq: -1, hash: null })

/**
 * 只复制"会被就地改写的层"，不是深拷贝：`Def` / `Gen` 元素按不可变共享。
 * 于是整体成本 = 一次 `cloneWorld` + 每条 entry O(1)。
 */
export function cloneWorld(w: World): World {
  const ids: World['ids'] = {}
  for (const key of Object.keys(w.ids)) {
    const identity = w.ids[key]
    ids[key] = { ...identity, gens: [...identity.gens] }
  }
  return { defs: { ...w.defs }, ids }
}

/**
 * 位置身份：末条 entry 的 entryHash，O(1)。
 * @param entries 已按链序排列的 entry
 * @returns 链头哈希；空日志 = null（EMPTY_HEAD 的 hash 同值）
 */
export function pos(entries: Entry[]): Hash | null {
  return entries.length === 0 ? null : entryHash(entries[entries.length - 1])
}

/**
 * 某条 entry 之后的校验锚点：起点与 `KernelInput.head` 同形，
 * 于是 `verify` 从任意快照位置接链，不再依赖硬编码的 null。
 * @param world 应用了该 entry（及其全部前序）之后的世界
 * @param e 边界 entry
 * @returns `{ world, head: { seq: e.seq, hash: entryHash(e) } }`
 */
export function anchorAfter(world: World, e: Entry): { world: World; head: Head } {
  return { world, head: { seq: e.seq, hash: entryHash(e) } }
}

/**
 * 重放：只重建、不校验链。`replay(tail, snapshotWorld)` 与全量重放得到同一世界——
 * 长链安全的唯一依据。applyEntry 不改入参 ⇒ 比对吃的是**存着的** argsHash。
 * @param entries 链序 entry
 * @param from 起点世界，缺省 EMPTY_WORLD（内部自行 cloneWorld，对调用方是纯的）
 * @throws KernelError('apply_failed' | 'args_hash_mismatch')
 */
export function replay(entries: Entry[], from: World = EMPTY_WORLD): World {
  const w = cloneWorld(from)
  for (const e of entries) {
    const r = applyEntry(w, e)
    if (!r.ok) throw new KernelError('apply_failed')
    if (r.argsHash !== e.argsHash) throw new KernelError('args_hash_mismatch')
  }
  return w
}

/**
 * 段校验：五查——seq 连续、prev 衔接、applyEntry 成功、argsHash 与实算一致、
 * entryHash 与清单一致；段末再用可选 worldRev 锚点核对内容。只校验，不返回世界。
 * @param anchor 链锚点起点，缺省 = 空世界 + EMPTY_HEAD
 * @param expected.hashes 与 entries 下标对齐（段首 entry 对应 hashes[0]）
 */
export function verify(
  entries: Entry[],
  anchor: { world: World; head: Head } = { world: EMPTY_WORLD, head: EMPTY_HEAD },
  expected?: { hashes?: Hash[]; worldRev?: Hash },
): { ok: boolean; error?: string } {
  const w = cloneWorld(anchor.world)
  let prev = anchor.head.hash
  let expectSeq = anchor.head.seq + 1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.seq !== expectSeq || e.prev !== prev) return { ok: false, error: 'chain_broken' }
    const r = applyEntry(w, e)
    if (!r.ok) return { ok: false, error: 'apply_failed' }
    if (r.argsHash !== e.argsHash) return { ok: false, error: 'args_hash_mismatch' }
    const h = entryHash(e)
    if (expected?.hashes && expected.hashes[i] !== h) return { ok: false, error: 'chain_broken' }
    prev = h
    expectSeq += 1
  }
  if (expected?.worldRev !== undefined && worldRev(w) !== expected.worldRev) {
    return { ok: false, error: 'world_rev_mismatch' }
  }
  return { ok: true }
}
