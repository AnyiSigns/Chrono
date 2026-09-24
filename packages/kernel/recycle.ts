// 世界回收：compact 时按可达性回收不可达 def + 世代窗口化。
// 世界 = base 快照 + journal 增量；compact 时按可达闭包裁剪 def，未达 def 不写进新 base。
// 回收后的 base 是子世界；冷段仍保留历史，供 full verify 全链校验。
// 回收只作用于 def 与世代，不改 journal 追加语义；full verify 仍从冷段全链过。
// 回收是**策略**：调用方决定保留根与淘汰根；内核只做机械闭包与裁剪，不替上层定策略。
//
// 空操作：不触发任何裁剪时返回入参世界（genWindow<=0 且无 dropRoots 即空操作）。
// 回收失败不阻断执行：调用方以 try/catch 兜底，fail-open。

import { flattenPatches } from './rebase.ts'
import type { Def, Gen, Hash, Json, World } from './types.ts'

/** 世界回收规格：世代窗口 + 可达根集合。 */
export interface RecycleSpec {
  /** 每身份保留最近 N 代（含 active）；<=0 = 不按窗口裁世代。 */
  genWindow: number
  /** 额外保留根：这些 def 及其可达闭包一律保留。 */
  keepRoots?: Hash[]
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

const HASH_PATTERN = /^[0-9a-f]{64}$/

/** `{"def":hash}` 形态的引用标记：body 里以此指向其它 def，是可达闭包的边。 */
function markerHash(value: Json): Hash | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'def') return null
  const hash = (value as { def?: Json }).def
  return typeof hash === 'string' && HASH_PATTERN.test(hash) ? hash : null
}

/** 递归收集 JSON 值里所有引用标记（哈希）。 */
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

/** 计算每身份的保留世代：窗口 + active + pins 固定点 + graft 来源 + 补丁 base。 */
function retainedGens(world: World, genWindow: number): Map<string, Set<number>> {
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
  if (genWindow <= 0) return keep
  const owners = payloadOwners(world)
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(world.ids)) {
      const gens = world.ids[id].gens
      for (const index of [...(keep.get(id) as Set<number>)]) {
        const gen = gens[index]
        if (gen === undefined) continue
        for (const pin of Object.values(gen.pins)) {
          for (const owner of owners.get(pin) ?? []) {
            if (addIndex(world, keep, owner.id, owner.index)) changed = true
          }
        }
        if (gen.graft !== undefined && addIndex(world, keep, gen.graft.from, gen.graft.gen)) {
          changed = true
        }
        // 补丁世代的 base 世代必须一并保留，否则组装悬挂（base 是 seq，随重建重映射）
        if (gen.base !== undefined && addIndex(world, keep, id, gen.base)) {
          changed = true
        }
      }
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

/** graft 来源世代下标随世代重建重映射。 */
function remapGrafts(ids: World['ids'], oldToNew: Map<string, Map<number, number>>): void {
  for (const id of Object.keys(ids)) {
    for (const gen of ids[id].gens) {
      if (gen.graft === undefined) continue
      const mapped = oldToNew.get(gen.graft.from)?.get(gen.graft.gen)
      if (mapped !== undefined && mapped !== gen.graft.gen) {
        gen.graft = { from: gen.graft.from, gen: mapped }
      }
    }
  }
}

/** 补丁世代的 base 随世代重建重映射：base 世代必被 retainedGens 保留，映射必存在。 */
function remapBases(ids: World['ids'], oldToNew: Map<string, Map<number, number>>): void {
  for (const id of Object.keys(ids)) {
    for (const gen of ids[id].gens) {
      if (gen.base === undefined) continue
      const mapped = oldToNew.get(id)?.get(gen.base)
      if (mapped !== undefined) gen.base = mapped
    }
  }
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

function pruneDefs(world: World, removed: ReadonlySet<Hash>): World['defs'] {
  if (removed.size === 0) return world.defs
  const defs: World['defs'] = {}
  for (const key of Object.keys(world.defs)) if (!removed.has(key)) defs[key] = world.defs[key]
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
  const keep = retainedGens(source.world, spec.genWindow)
  const rebuilt = rebuildIds(source.world, keep)
  remapGrafts(rebuilt.ids, rebuilt.oldToNew)
  remapBases(rebuilt.ids, rebuilt.oldToNew)
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
