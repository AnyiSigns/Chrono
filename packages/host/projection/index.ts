// 投影包：宿主对世界的只读视图，作为 directive 的 ctx 交给 term。
// v1 `base_only`：无快照 ⇒ 基础世界 = 宿主当前世界（全量重放结果，随链头推进演化）。
// 形状以身份字面 id 为键（内核 ["g", path] 是静态字面路径，哈希键不可达）；不给 defs 表，不含源码 tree/blob。
// 按引用构造，O(#身份)（world_rev 另按 #defs 计），不深拷贝。

import { worldRev } from '../../kernel/index.ts'
import { latestDataGen } from '../assembly/decl.ts'
import type { Head, Json, World } from '../../kernel/index.ts'

/**
 * `base_only` 投影：链头锚 + 内容摘要 + 逐身份 active / 世代（不含履历）/ `body`。
 * `body` 口径（G7 A1）= **最近数据世代的 payload def body**；无数据世代则回落 active（代码 / commit）
 * def body；`active` / `gens` 保持链上原义。只读是宿主纪律：不写链、不推进 head、不参与哈希。
 * @param world 基础世界（v1 = 宿主当前世界）
 * @param head 该世界的链头（投影反映构造时点的世界）
 * @returns 交给 term 的 JSON 视图
 */
export function projectBaseOnly(world: World, head: Head): Json {
  const ids: { [id: string]: Json } = {}
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const active = identity.active
    const dataGen = latestDataGen(world, id)
    const bodyHash = dataGen?.payload ?? active
    ids[id] = {
      active,
      gens: identity.gens.map((gen) => ({ seq: gen.seq, payload: gen.payload })),
      body: bodyHash === null ? null : (world.defs[bodyHash]?.body ?? null),
    }
  }
  return {
    head: { seq: head.seq, hash: head.hash },
    world_rev: worldRev(world),
    ids,
  }
}
