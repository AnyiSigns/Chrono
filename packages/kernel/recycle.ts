// 世界回收：compact 时按可达性回收不可达 def + 世代窗口化。
// 世界 = base 快照 + journal 增量；compact 时按可达闭包裁剪 def，未达 def 不写进新 base。
// 回收后的 base 是子世界；冷段仍保留历史，供 full verify 全链校验。
// 回收只作用于 def 与世代，不改 journal 追加语义；full verify 仍从冷段全链过。
// 回收是**策略**：调用方决定保留根与淘汰根；内核只做机械闭包与裁剪，不替上层定策略。
//
// 空操作：不触发任何裁剪时返回入参世界（genWindow<=0 且无 dropRoots 即空操作）。
// 回收失败不阻断执行：调用方以 try/catch 兜底，fail-open。

import { cloneDefs } from './defs.ts'
import { flattenPatches, remapGens } from './rebase.ts'
import { isHash, isRecord, walkJson } from './value.ts'
import type { Def, Gen, Hash, Json, World } from './types.ts'

/** 世界回收规格：世代窗口 + 可达根集合。 */
export interface RecycleSpec {
  /** 每身份保留最近 N 代（含 active）；<=0 = 不按窗口裁世代。 */
  genWindow: number
  /** 额外保留根：这些 def 及其可达闭包一律保留。 */
  keepRoots?: Hash[]
  /** 额外保留世代（`{id, seq}` 机械并集）：内核只并入保留集，不解释数据 / 代码语义。 */
  keepGens?: { id: string; seq: number }[]
  /** 淘汰根：只回收「被这些根独占」的 def，不碰未被任何根引用的孤儿 def（保守口径）。 */
  dropRoots?: Hash[]
  /** 严格口径：true = 回收保留闭包外的全部 def；false = 只回收淘汰根独有 def。 */
  strict?: boolean
  /** 补丁链压扁阈值：>=2 时把线性补丁世代链折叠成整份世代（缩短链）；缺省 / <2 不压扁。 */
  flattenChain?: number
}

export interface RecycleStats {
  removedDefs: number
  droppedGens: number
  keptDefs: number
}

export interface RecycleResult {
  world: World
  stats: RecycleStats
}

/** `{"def":hash}` 形态的引用标记：body 里以此指向其它 def，是可达闭包的边。 */
function markerHash(value: Json | undefined): Hash | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'def') return null
  const hash = value['def']
  return isHash(hash) ? hash : null
}

/** 递归收集 JSON 值里所有引用标记（哈希）；命中标记即不再下探。 */
function collectMarkers(value: Json, out: Hash[]): void {
  walkJson(
    value,
    (node, _depth, next) => {
      const hash = markerHash(node)
      if (hash !== null) {
        out.push(hash)
        return node as Json
      }
      if (Array.isArray(node)) {
        for (const item of node) next(item)
        return node
      }
      if (typeof node === 'object' && node !== null) {
        for (const key of Object.keys(node)) next((node as { [k: string]: Json })[key])
      }
      return node as Json
    },
    0,
  )
}

/** 单个 def 的出边：`sig` + `pins` 值 + body 内的引用标记。 */
function defEdges(def: Def, out: Hash[]): void {
  if (typeof def.sig === 'string') out.push(def.sig)
  for (const pin of Object.values(def.pins ?? {})) if (typeof pin === 'string') out.push(pin)
  collectMarkers(def.body, out)
}

/** 从种子集合出发求可达闭包（只沿存在的 def 走，缺失即止）。 */
function closure(world: World, seeds: Iterable<Hash>): Set<Hash> {
  const visited = new Set<Hash>()
  const stack: Hash[] = []
  for (const seed of seeds) {
    if (!visited.has(seed)) {
      visited.add(seed)
      stack.push(seed)
    }
  }
  while (stack.length > 0) {
    const hash = stack.pop() as Hash
    const def = world.defs[hash]
    if (def === undefined) continue
    const next: Hash[] = []
    defEdges(def, next)
    for (const item of next) {
      if (!visited.has(item)) {
        visited.add(item)
        stack.push(item)
      }
    }
  }
  return visited
}

/** 一个世代的种子：payload + sig + pins 值。 */
function genSeeds(gen: Gen): Hash[] {
  const out: Hash[] = [gen.payload]
  if (typeof gen.sig === 'string') out.push(gen.sig)
  for (const pin of Object.values(gen.pins)) if (typeof pin === 'string') out.push(pin)
  return out
}

/** 全部身份的种子：schema + 每个世代。 */
function identitySeeds(world: World): Hash[] {
  const out: Hash[] = []
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    if (typeof identity.schema === 'string') out.push(identity.schema)
    for (const gen of identity.gens) out.push(...genSeeds(gen))
  }
  return out
}

/** payload → 世代位置（身份, 下标）索引；用于 pins 固定点回填。 */
function payloadOwners(world: World): Map<Hash, { id: string; index: number }[]> {
  const owners = new Map<Hash, { id: string; index: number }[]>()
  for (const id of Object.keys(world.ids)) {
    const gens = world.ids[id].gens
    for (let index = 0; index < gens.length; index++) {
      const list = owners.get(gens[index].payload)
      if (list === undefined) owners.set(gens[index].payload, [{ id, index }])
      else list.push({ id, index })
    }
  }
  return owners
}

/** 把一个世代下标加入保留集（越界/重复返回 false），供 pins/graft/base 固定点回填。 */
function addIndex(
  world: World,
  keep: Map<string, Set<number>>,
  id: string,
  index: number,
): boolean {
  const set = keep.get(id)
  const gens = world.ids[id]?.gens
  if (set === undefined || gens === undefined || index < 0 || index >= gens.length) return false
  if (set.has(index)) return false
  set.add(index)
  return true
}

/**
 * 计算每身份的保留世代：窗口 + active + 调用方显式保留集 + pins 固定点 + graft 来源 + 补丁 base。
 * `keepGens` 是调用方的机械保留集（如投影数据世代），内核只做并集、不解释其含义；
 * 并入发生在固定点回填之前，故其 pins / graft / base 依赖同样被拉入。
 * 固定点用工作表推进：新增项才入表，每代只处理一次（不每轮全量重扫）。
 */
function retainedGens(
  world: World,
  genWindow: number,
  keepGens: readonly { id: string; seq: number }[],
): Map<string, Set<number>> {
  const keep = new Map<string, Set<number>>()
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const set = new Set<number>()
    const from = genWindow > 0 ? Math.max(0, identity.gens.length - genWindow) : 0
    for (let i = from; i < identity.gens.length; i++) set.add(i)
    if (identity.active !== null) {
      const active = identity.gens.findIndex((gen) => gen.payload === identity.active)
      if (active >= 0) set.add(active)
    }
    keep.set(id, set)
  }
  for (const item of keepGens) addIndex(world, keep, item.id, item.seq)
  const owners = payloadOwners(world)
  const work: { id: string; index: number }[] = []
  for (const id of Object.keys(world.ids)) {
    for (const index of keep.get(id) as Set<number>) work.push({ id, index })
  }
  while (work.length > 0) {
    const item = work.pop() as { id: string; index: number }
    const gen = world.ids[item.id]?.gens[item.index]
    if (gen === undefined) continue
    for (const pin of Object.values(gen.pins)) {
      for (const owner of owners.get(pin) ?? []) {
        if (addIndex(world, keep, owner.id, owner.index)) {
          work.push({ id: owner.id, index: owner.index })
        }
      }
    }
    if (gen.graft !== undefined && addIndex(world, keep, gen.graft.from, gen.graft.gen)) {
      work.push({ id: gen.graft.from, index: gen.graft.gen })
    }
    // 补丁世代的 base 世代必须一并保留，否则组装悬挂（base 是 seq，随重建重映射）
    if (gen.base !== undefined && addIndex(world, keep, item.id, gen.base)) {
      work.push({ id: item.id, index: gen.base })
    }
  }
  return keep
}

interface RebuiltIds {
  ids: World['ids']
  dropped: number
  oldToNew: Map<string, Map<number, number>>
}

/** 按保留集重建身份世代：seq = 新下标，并返回旧→新映射（供 graft/base 重映射）。 */
function rebuildIds(world: World, keep: Map<string, Set<number>>): RebuiltIds {
  const ids: World['ids'] = {}
  const oldToNew = new Map<string, Map<number, number>>()
  let dropped = 0
  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const kept = [...(keep.get(id) as Set<number>)].sort((a, b) => a - b)
    dropped += identity.gens.length - kept.length
    const map = new Map<number, number>()
    const gens: Gen[] = kept.map((oldIndex, newIndex) => {
      map.set(oldIndex, newIndex)
      return { ...identity.gens[oldIndex], seq: newIndex }
    })
    oldToNew.set(id, map)
    ids[id] = { ...identity, gens }
  }
  return { ids, dropped, oldToNew }
}

/** 计算待回收的 def：保留闭包外、且符合当前口径的 def。 */
function removedDefs(world: World, retained: World, spec: RecycleSpec): Set<Hash> {
  const keepRoots = spec.keepRoots ?? []
  const retainedClosure = closure(retained, [...identitySeeds(retained), ...keepRoots])
  if (spec.strict === true) {
    const removed = new Set<Hash>()
    for (const key of Object.keys(world.defs)) if (!retainedClosure.has(key)) removed.add(key)
    return removed
  }
  // 保守口径：只回收「被淘汰根独占」的 def——不被任何根引用的孤儿 def 不碰（内核引用图不完备）。
  // 淘汰根通常来自上层保留策略（如审计窗口淘汰键）。
  const dropRoots = spec.dropRoots ?? []
  const allClosure = closure(world, [...identitySeeds(world), ...keepRoots, ...dropRoots])
  const removed = new Set<Hash>()
  for (const hash of allClosure) {
    if (!retainedClosure.has(hash) && Object.hasOwn(world.defs, hash)) removed.add(hash)
  }
  return removed
}

/** 保留闭包外的 def 从表里移除：克隆可写层（惰性表保持惰性），再按键移除。 */
function pruneDefs(world: World, removed: ReadonlySet<Hash>): World['defs'] {
  if (removed.size === 0) return world.defs
  const defs = cloneDefs(world.defs)
  for (const hash of removed) Reflect.deleteProperty(defs, hash)
  return defs
}

/**
 * 世界回收：世代窗口 + 可达闭包裁剪 def。
 * @param world 入参世界（不改，返回新世界）。
 * @param spec 回收规格；genWindow<=0 且无 dropRoots 即空操作。
 * @returns 回收后的世界与统计（不改 journal 追加语义）。
 */
export function recycleWorld(world: World, spec: RecycleSpec): RecycleResult {
  // 先压扁（可选）：把线性补丁链折叠成整份世代，再按保留集裁 def / 世代
  const source =
    spec.flattenChain !== undefined && spec.flattenChain >= 2
      ? flattenPatches(world, spec.flattenChain)
      : { world, flattened: 0 }
  const keep = retainedGens(source.world, spec.genWindow, spec.keepGens ?? [])
  const rebuilt = rebuildIds(source.world, keep)
  remapGens(rebuilt.ids, rebuilt.oldToNew)
  const retained: World = { defs: source.world.defs, ids: rebuilt.ids }
  const removed = removedDefs(source.world, retained, spec)
  if (removed.size === 0 && rebuilt.dropped === 0 && source.flattened === 0) {
    return {
      world,
      stats: { removedDefs: 0, droppedGens: 0, keptDefs: Object.keys(world.defs).length },
    }
  }
  const defs = pruneDefs(source.world, removed)
  return {
    world: { defs, ids: rebuilt.ids },
    stats: {
      removedDefs: removed.size,
      droppedGens: rebuilt.dropped,
      keptDefs: Object.keys(defs).length,
    },
  }
}
