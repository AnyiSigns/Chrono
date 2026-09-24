// 压扁（rebase）：把线性补丁世代链折叠成单个整份世代，缩短补丁链。
// 纯函数：返回新世界（新 defs 表 + 新 gens），不改入参。
// 只折叠安全链：起点是整份世代、后续每代 base 恰好指向前一代；且链内非末代不被
// active 指向、不被任何世代的 pins 指向、不被链外世代的 base / graft 指向。
// 任一不满足即不折叠该链（保守，宁可不缩）。

import { cloneDefs } from './defs.ts'
import { H } from './hash.ts'
import { assembleBody, readPatchOps } from './patch.ts'
import type { Gen, Hash, Json, World } from './types.ts'

export interface FlattenResult {
  world: World
  /** 折叠掉的补丁链条数。 */
  flattened: number
}

/** 组装线性补丁链 [from..to] 的 body；任一代 payload 缺失 / 补丁体非法 → null。 */
function assembleRun(defs: World['defs'], gens: Gen[], from: number, to: number): Json | null {
  let body = defs[gens[from].payload]?.body ?? null
  if (body === null) return null
  for (let index = from + 1; index <= to; index++) {
    const ops = readPatchOps(defs[gens[index].payload]?.body ?? null)
    if (ops === null) return null
    try {
      body = assembleBody(body, ops)
    } catch {
      return null
    }
  }
  return body
}

/**
 * 压扁所有身份里的线性补丁链：链折叠为单个整份世代（payload = H({body: 组装结果})，def 写入新 defs）。
 * `minChain` = 触发折叠的最短链长（含整份起点，默认 2：一个整份 + 至少一条补丁）。
 * base 与 graft 的下标随新世代表重映射；active 指向被折叠世代时改指折叠后的整份世代。
 * @param world 任意世界（只读）
 * @param minChain 最短可折叠链长（<2 不折叠任何链）
 * @returns 新世界与折叠链数
 */
export function flattenPatches(world: World, minChain = 2): FlattenResult {
  const defs: World['defs'] = cloneDefs(world.defs)
  const ids: World['ids'] = {}
  const indexMaps = new Map<string, Map<number, number>>()
  const payloadRemaps = new Map<string, Map<Hash, Hash>>()
  // 全体世代的 pins 目标：折叠会改写世代结构，被 pin 的非末代 payload 折叠后无世代承载，
  // 故任一链内非末代 payload 被 pin 即不折叠该链（pins 只在链内重映射，不跨身份改写）。
  const pinnedPayloads = new Set<Hash>()
  for (const id of Object.keys(world.ids)) {
    for (const gen of world.ids[id].gens) {
      for (const pin of Object.values(gen.pins)) {
        if (typeof pin === 'string') pinnedPayloads.add(pin)
      }
    }
  }
  // 全体世代的 graft 来源（可跨身份）：链内非末代被任何世代 graft 指向即不折叠该链。
  const graftedGens = new Map<string, Set<number>>()
  for (const id of Object.keys(world.ids)) {
    for (const gen of world.ids[id].gens) {
      if (gen.graft === undefined) continue
      const set = graftedGens.get(gen.graft.from)
      if (set === undefined) graftedGens.set(gen.graft.from, new Set([gen.graft.gen]))
      else set.add(gen.graft.gen)
    }
  }
  let flattened = 0

  for (const id of Object.keys(world.ids)) {
    const identity = world.ids[id]
    const gens = identity.gens
    const newGens: Gen[] = []
    const indexMap = new Map<number, number>()
    const payloadRemap = new Map<Hash, Hash>()
    let i = 0
    while (i < gens.length) {
      const start = i
      let end = i
      if (gens[i].base === undefined) {
        while (end + 1 < gens.length && gens[end + 1].base === end) end++
      }
      const runLength = end - start + 1
      if (runLength >= minChain) {
        // 链内非末代（[start, end)）不得被 active / 链外 base / 链外 graft 指向
        const interior = new Set<number>()
        for (let k = start; k < end; k++) interior.add(k)
        const activeInterior =
          identity.active !== null &&
          gens.some((gen, idx) => idx >= start && idx < end && gen.payload === identity.active)
        const externalBase = gens.some(
          (gen, idx) =>
            (idx < start || idx > end) && gen.base !== undefined && interior.has(gen.base),
        )
        const externalGraft = [...interior].some((k) => graftedGens.get(id)?.has(k) ?? false)
        const interiorPinned = gens.some(
          (gen, idx) => idx >= start && idx < end && pinnedPayloads.has(gen.payload),
        )
        const assembled =
          activeInterior || externalBase || externalGraft || interiorPinned
            ? null
            : assembleRun(defs, gens, start, end)
        if (assembled !== null) {
          const key = H({ body: assembled })
          defs[key] = { body: assembled }
          const last = gens[end]
          const newIndex = newGens.length
          newGens.push({
            seq: newIndex,
            payload: key,
            pins: last.pins,
            sig: last.sig,
            adopted: last.adopted,
            ...(last.graft !== undefined ? { graft: last.graft } : {}),
          })
          for (let k = start; k <= end; k++) {
            indexMap.set(k, newIndex)
            payloadRemap.set(gens[k].payload, key)
          }
          flattened += 1
          i = end + 1
          continue
        }
      }
      const newIndex = newGens.length
      indexMap.set(i, newIndex)
      newGens.push({ ...gens[i], seq: newIndex })
      i += 1
    }
    ids[id] = { ...identity, gens: newGens }
    indexMaps.set(id, indexMap)
    payloadRemaps.set(id, payloadRemap)
  }

  for (const id of Object.keys(ids)) {
    const indexMap = indexMaps.get(id)
    const payloadRemap = payloadRemaps.get(id)
    const identity = ids[id]
    for (const gen of identity.gens) {
      if (gen.base !== undefined) {
        const mapped = indexMap?.get(gen.base)
        if (mapped !== undefined) gen.base = mapped
      }
      if (gen.graft !== undefined) {
        const mapped = indexMaps.get(gen.graft.from)?.get(gen.graft.gen)
        if (mapped !== undefined) gen.graft = { from: gen.graft.from, gen: mapped }
      }
    }
    if (identity.active !== null && payloadRemap?.has(identity.active)) {
      identity.active = payloadRemap.get(identity.active) as Hash
    }
  }

  return { world: { defs, ids }, flattened }
}
