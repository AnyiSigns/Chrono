// 日志与世界：两个身份（位置哈希 / 内容摘要）、空世界常量、链位置、锚点、重放与段校验。
// 逐 op 的机械语义在 journal.apply.ts（允许的点分段拆分），本文件转口其公共件。

import { KernelError } from './types.ts'
import type { Def, Entry, Hash, Head, Identity, Json, World } from './types.ts'
import { cloneDefs, defsKeys } from './defs.ts'
import { H } from './hash.ts'
import { applyEntry } from './journal.apply.ts'

export { applyEntry }

// 冻结（含内层 map）：兑现"空世界字面量只读"——误用未克隆的 EMPTY_WORLD 就地写入会当场抛
export const EMPTY_WORLD: World = Object.freeze({
  defs: Object.freeze<Record<Hash, Def>>({}),
  ids: Object.freeze<Record<string, Identity>>({}),
})

/** 空链头：首条 entry 的 seq = 0、prev = null。 */
export const EMPTY_HEAD: Head = Object.freeze({ seq: -1, hash: null })

/**
 * 只复制"会被就地改写的层"，不是深拷贝：`Def` / `Gen` 元素按不可变共享。
 * defs 表经 `cloneDefs` 复制——惰性表走廉价克隆（共享底层分片、只复制可写覆盖层），
 * 普通表浅拷贝；两种表行为一致。于是整体成本 = 一次 `cloneWorld` + 每条 entry O(1)。
 */
export function cloneWorld(w: World): World {
  const ids: World['ids'] = {}
  for (const key of Object.keys(w.ids)) {
    const identity = w.ids[key]
    ids[key] = { ...identity, gens: [...identity.gens] }
  }
  return { defs: cloneDefs(w.defs), ids }
}

/**
 * 单条 entry 的位置哈希：只吃 `argsHash` 等定长字段，不读 `args`（O(1)）。
 * @param e 待哈希 entry——其 `argsHash` 必须已定（commit 回填后，或已落盘 entry）
 * @returns 64-hex 链位置；与 `pos([e])` 同值
 */
export function entryHash(e: Entry): Hash {
  // ref 可为 undefined：canonicalJson 统一剔除 undefined 键，Json 类型未表达这一口径
  return H({
    at: e.at,
    seq: e.seq,
    prev: e.prev,
    op: e.op,
    argsHash: e.argsHash,
    by: e.by,
    ref: e.ref,
  } as unknown as Json)
}

/**
 * 内容身份：`H({ keys, ids 摘要 })`。keys = defs 键 code-unit 升序；
 * ids 摘要只吃 `schema` / `active` / gen 内容哈希，**不吃 `born` / `adopted` 履历**。
 * 按需算（快照 / 跨世界比较），不挂在每条写入上。
 * @param world 任意世界（只读）
 * @returns 64-hex 内容身份；同内容同 active 而履历不同的世界必得同值
 */
export function worldRev(world: World): Hash {
  const keys = defsKeys(world.defs).slice().sort()
  const digest: Record<string, Json> = {}
  for (const key of Object.keys(world.ids)) {
    const identity = world.ids[key]
    digest[key] = {
      id: identity.id,
      schema: identity.schema,
      active: identity.active,
      gens: identity.gens.map((g) => ({
        seq: g.seq,
        payload: g.payload,
        pins: g.pins,
        sig: g.sig,
        ...(g.graft ? { graft: g.graft } : {}),
        ...(g.base !== undefined ? { base: g.base } : {}),
      })),
    }
  }
  return H({ keys, ids: digest })
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
 * @throws KernelError('apply_failed' | 'args_hash_mismatch')；`applyEntry` 的 KernelError 亦原样穿出
 *   （目前只有链内 snapshot 自校失败可达：'world_rev_mismatch'。§19：replay 的契约就是抛）
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
 * **不抛**：一切失败转返回码——含链内 snapshot 自校的 world_rev_mismatch（§20；replay 保持抛，契约不同）。
 * @param anchor 链锚点起点，缺省 = 空世界 + EMPTY_HEAD
 * @param expected.hashes 与 entries 下标对齐（段首 entry 对应 hashes[0]）
 */
export function verify(
  entries: Entry[],
  anchor: { world: World; head: Head } = { world: EMPTY_WORLD, head: EMPTY_HEAD },
  expected?: { hashes?: Hash[]; worldRev?: Hash },
): { ok: boolean; error?: string } {
  try {
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
  } catch (e) {
    // verify 自身从不抛（§10.1 旁注）：applyEntry 的 KernelError 全部转返回码
    if (e instanceof KernelError) return { ok: false, error: e.code }
    throw e
  }
}
