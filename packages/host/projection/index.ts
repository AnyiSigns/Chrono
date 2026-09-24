// 投影包：宿主对世界的只读视图，作为 directive 的 ctx 交给 term。
// v1 `base_only`：无快照 ⇒ 基础世界 = 宿主当前世界（全量重放结果，随链头推进演化）。
// 形状以身份字面 id 为键（内核 ["g", path] 是静态字面路径，哈希键不可达）；不给 defs 表，不含源码 tree/blob。
// 按引用构造，O(#身份)（world_rev 另按 #defs 计），不深拷贝。
// 引用只回**哈希**（`{"def":hash}` 标记直接出现的键，值不含 body）：投影不随历史内联整份闭包，
// 深层 def body 由消费方经只读解析能力（宿主 `host.def.read`）按需取回。

import { assembleBody, readPatchOps, worldRev } from '../../kernel/index.ts'
import { latestDataGen, readPluginDecl } from '../assembly/decl.ts'
import type { Gen, Hash, Head, Json, World } from '../../kernel/index.ts'

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
 * 引用集合：body 里 `{"def":hash}` 标记**直接**出现的哈希，排序去重、`cap` 为硬上限。
 * 只回键不回 body；深度引用由消费方沿标记逐跳解析（`host.def.read`），投影不随历史膨胀。
 */
function collectRefHashes(body: Json, cap: number): Hash[] {
  const found: Hash[] = []
  collectMarkers(body, found)
  const seen = new Set<Hash>()
  const unique: Hash[] = []
  for (const hash of found) {
    if (seen.has(hash)) continue
    seen.add(hash)
    unique.push(hash)
    if (unique.length >= cap) break
  }
  unique.sort()
  return unique
}

/**
 * 从一段 body 出发跟随 `{"def":hash}` 标记，返回世界内可达 def 的哈希集合（键集合，不含 body）。
 * 供只读解析能力做**越权门禁**：只放行从某身份投影 body 可达的 def；缺失 def 跳过、已访问去重防环。
 * `cap` 为防异常数据撑爆的硬上限。
 */
export function reachableDefHashes(world: World, body: Json, cap = DEFAULT_REF_CAP): Set<Hash> {
  const reachable = new Set<Hash>()
  const queue: Hash[] = []
  collectMarkers(body, queue)
  for (let i = 0; i < queue.length && reachable.size < cap; i++) {
    const hash = queue[i]
    if (reachable.has(hash)) continue
    const def = world.defs[hash]
    if (def === undefined) continue
    reachable.add(hash)
    collectMarkers(def.body, queue)
  }
  return reachable
}

/** 单个身份直接引用集合的硬上限（防异常数据撑爆投影；正常会话远低于此）。 */
export const DEFAULT_REF_CAP = 1000

/**
 * 组装某身份某世代的 body：整份世代取 payload def body；补丁世代取 base 世代组装结果再按序应用补丁。
 * base 恒指向更早世代（`base < seq`），无环；任一环缺失（base 越界 / def 缺失 / 补丁体非法）回 null
 * （fail-closed，不抛）。结果按下标记忆，避免链式回溯重复组装。
 */
function assembleGenBody(
  world: World,
  gens: Gen[],
  index: number,
  memo: (Json | null | undefined)[],
): Json | null {
  const cached = memo[index]
  if (cached !== undefined) return cached
  const gen = gens[index]
  if (gen === undefined) return null
  if (gen.base === undefined) {
    const body = world.defs[gen.payload]?.body ?? null
    memo[index] = body
    return body
  }
  if (!Number.isInteger(gen.base) || gen.base < 0 || gen.base >= index) {
    memo[index] = null
    return null
  }
  const baseBody = assembleGenBody(world, gens, gen.base, memo)
  const ops = baseBody === null ? null : readPatchOps(world.defs[gen.payload]?.body ?? null)
  if (baseBody === null || ops === null) {
    memo[index] = null
    return null
  }
  let assembled: Json
  try {
    assembled = assembleBody(baseBody, ops)
  } catch {
    memo[index] = null
    return null
  }
  memo[index] = assembled
  return assembled
}

export interface ProjectionOptions {
  /** 覆盖 `DEFAULT_REF_CAP`（测试用）。 */
  refCap?: number
  /** 源码 CAS 目录：解析身份声明（pointer blob）取 `pins` 时经它读文本。 */
  blobsDir?: string
}

/**
 * `base_only` 投影：链头锚 + 内容摘要 + 逐身份 active / 世代（不含履历）/ `body` / `data_gen` / `pins` / 引用集合 `refs`。
 * `body` 口径（G7 A1）= **最近数据世代的组装结果**（整份世代取 payload def body；补丁世代取 base 世代组装后按序应用补丁）；
 * 无数据世代则回落 active（代码 / commit）def body；`active` / `gens` 保持链上原义。
 * `data_gen` = 组装来源世代 `{seq, payload}`（无数据世代 / 组装失败为 null）；写方据此把下一世代写成
 * 补丁世代（`add_gen` 携带 `base = data_gen.seq`）。`pins` = 当前代码世代声明里的 `pins` 表（名 → 被依赖身份名，
 * 机械来自声明，供调用方入口 term 判「端口 ⊆ pins」）；无代码世代则 null。
 * `refs` = body 里 `{"def":hash}` 标记直接出现的哈希列表（只回引用、不回 body；全量无截断，`cap` 仅硬上限）。
 * 只读是宿主纪律：不写链、不推进 head、不参与哈希。
 * @param world 基础世界（v1 = 宿主当前世界）
 * @param head 该世界的链头（投影反映构造时点的世界）
 * @param options 引用集合硬上限覆盖（缺省 `DEFAULT_REF_CAP`）
 * @returns 交给 term 的 JSON 视图
 */
export function projectBaseOnly(world: World, head: Head, options?: ProjectionOptions): Json {
  const cap = options?.refCap ?? DEFAULT_REF_CAP
  const ids: { [id: string]: Json } = {}
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const active = identity.active
    const dataGen = latestDataGen(world, id)
    const memo: (Json | null | undefined)[] = []
    // body = 最近数据世代的组装结果；无数据世代回落 active（代码 / commit def body）。
    // data_gen = 组装来源世代（写方据此把下一世代写成补丁世代：base = data_gen.seq）。
    const body = dataGen === null ? (active === null ? null : (world.defs[active]?.body ?? null)) : assembleGenBody(world, identity.gens, dataGen.seq, memo)
    const dataGenView: Json | null = dataGen !== null && body !== null ? { seq: dataGen.seq, payload: dataGen.payload } : null
    // pins = 当前代码世代声明里的表（逻辑端点名 → 被依赖身份名字面值）；无代码世代 → null
    const decl = readPluginDecl(world, id, options?.blobsDir)
    ids[id] = {
      active,
      gens: identity.gens.map((gen) => ({ seq: gen.seq, payload: gen.payload })),
      body,
      data_gen: dataGenView,
      pins: decl === null ? null : decl.decl.pins,
      refs: body === null ? [] : collectRefHashes(body, cap),
      next_before: null,
    }
  }
  return {
    head: { seq: head.seq, hash: head.hash },
    world_rev: worldRev(world),
    ids,
  }
}
