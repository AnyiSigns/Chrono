// 两个身份：位置哈希（entryHash，O(1)，供并发与链完整性）与内容摘要（worldRev，按需算）。
// 从 journal.ts 点分段拆出（预算护栏）；公共面由 journal.ts 统一转口。

import { defsKeys } from './defs.ts'
import { H } from './hash.ts'
import type { Entry, Hash, Json, World } from './types.ts'

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
