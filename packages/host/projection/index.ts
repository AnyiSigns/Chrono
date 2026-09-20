// 投影包：宿主对世界的只读视图，作为 directive 的 ctx 交给 term。
// v1 `base_only`：无快照 ⇒ 基础世界 = 宿主当前世界（全量重放结果，随链头推进演化）。
// 形状以身份字面 id 为键（内核 ["g", path] 是静态字面路径，哈希键不可达）；不给 defs 表，不含源码 tree/blob。
// 按引用构造，O(#身份)（world_rev 另按 #defs 计），不深拷贝。

import { worldRev } from '../../kernel/index.ts'
import { latestDataGen } from '../assembly/decl.ts'
import type { Hash, Head, Json, World } from '../../kernel/index.ts'

/** def 键的形状：64 位小写十六进制；不符（业务数据恰好带 `def` 字段）不当作引用标记。 */
const HASH_PATTERN = /^[0-9a-f]{64}$/

/** 引用标记：`{"def": "<64hex>"}`——body 里指向另一 def 的显式标记。 */
function markerHash(value: Json): Hash | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'def') return null
  const hash = (value as { def?: Json }).def
  return typeof hash === 'string' && HASH_PATTERN.test(hash) ? hash : null
}

/** 收集一段 JSON 里直接出现的标记哈希（不进入标记内部，标记本身只承载哈希）。 */
function collectMarkers(value: Json, out: Hash[]): void {
  const hash = markerHash(value)
  if (hash !== null) {
    out.push(hash)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarkers(item, out)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      collectMarkers((value as { [k: string]: Json })[key], out)
    }
  }
}

/**
 * 引用闭包：从身份 body 出发跟随 `{"def":hash}` 标记，把可达 def 的 body 收进 `refs`。
 * 全量返回、不截断（翻页窗口由调用方在 refs 上切片）；`cap` 只是防异常数据撑爆投影的硬上限。
 * 标记指向缺失 def 时跳过（世界里的悬空引用不抛）；已访问哈希去重，天然防环。
 */
function collectRefs(world: World, body: Json, cap: number): { [hash: string]: Json } {
  const refs: { [hash: string]: Json } = {}
  const visited = new Set<Hash>()
  const queue: Hash[] = []
  collectMarkers(body, queue)
  let count = 0
  for (let i = 0; i < queue.length && count < cap; i++) {
    const hash = queue[i]
    if (visited.has(hash)) continue
    visited.add(hash)
    const def = world.defs[hash]
    if (def === undefined) continue
    refs[hash] = def.body
    count += 1
    collectMarkers(def.body, queue)
  }
  return refs
}

/** 单个身份闭包 refs 的硬上限（防异常数据撑爆投影；正常会话远低于此）。 */
export const DEFAULT_REF_CAP = 1000

export interface ProjectionOptions {
  /** 覆盖 `DEFAULT_REF_CAP`（测试用）。 */
  refCap?: number
}

/**
 * `base_only` 投影：链头锚 + 内容摘要 + 逐身份 active / 世代（不含履历）/ `body` / 引用闭包 `refs`。
 * `body` 口径（G7 A1）= **最近数据世代的 payload def body**；无数据世代则回落 active（代码 / commit）
 * def body；`active` / `gens` 保持链上原义。`refs` = body 里 `{"def":hash}` 可达闭包（全量、`next_before` 恒 null）。
 * 只读是宿主纪律：不写链、不推进 head、不参与哈希。
 * @param world 基础世界（v1 = 宿主当前世界）
 * @param head 该世界的链头（投影反映构造时点的世界）
 * @param options 闭包硬上限覆盖（缺省 `DEFAULT_REF_CAP`）
 * @returns 交给 term 的 JSON 视图
 */
export function projectBaseOnly(world: World, head: Head, options?: ProjectionOptions): Json {
  const cap = options?.refCap ?? DEFAULT_REF_CAP
  const ids: { [id: string]: Json } = {}
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const active = identity.active
    const dataGen = latestDataGen(world, id)
    const bodyHash = dataGen?.payload ?? active
    const body = bodyHash === null ? null : (world.defs[bodyHash]?.body ?? null)
    ids[id] = {
      active,
      gens: identity.gens.map((gen) => ({ seq: gen.seq, payload: gen.payload })),
      body,
      refs: body === null ? {} : collectRefs(world, body, cap),
      next_before: null,
    }
  }
  return {
    head: { seq: head.seq, hash: head.hash },
    world_rev: worldRev(world),
    ids,
  }
}
