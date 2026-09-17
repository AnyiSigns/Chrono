// 投影包：宿主对世界的只读视图，作为 directive 的 ctx 交给 term。
// 投影不写、不改，不暴露可变更的世界内部结构。

import { worldRev } from '../../kernel/index.ts'
import type { Head, Json, World } from '../../kernel/index.ts'

/** `base_only` 投影：链头锚点 + 内容摘要；无基础世界时不可用（本阶段世界即基础）。 */
export function projectBaseOnly(world: World, head: Head): Json {
  return { head: { seq: head.seq, hash: head.hash }, world_rev: worldRev(world) }
}
