// A1 路由：发出者 pins（名 → 哈希）→ def → 属主身份 → 该身份当前 active 世代 → 端点表。
// `one` 绑定（`commit.body.meta.needs` 的身份名）走同一条端点解析，只按名不按哈希。
// 只读世界：不执行效果、不写链；端点表键不含调用方（impl+gen+cap+method）。
// `pin` 绑定身份：依赖换代重解析到新 active；pin 哈希 ≠ 依赖 active 只记漂移证据，不阻塞。

import {
  assemblyGen,
  buildOwnerIndex,
  capabilityProviders,
  needsBindingsOf,
  readPluginDecl,
} from '../assembly/index.ts'
import { HOST_CAPABILITY, HOST_METHODS } from '../host-methods.ts'
import type { NeedDecl } from '../assembly/index.ts'
import type { EndpointCallResult, EndpointRow } from '../endpoint-table.ts'
import type { EndpointTable } from '../endpoint-table.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

/** 路由失败码：与 protocol §四 同名（作为 `EffResult.error` 落审计，内核归 `eff_error`）。 */
export type RouteError = 'unresolved_cap' | 'not_loaded' | 'stale'

export type RouteOutcome = { ok: true; row: EndpointRow } | { ok: false; error: RouteError }

/** 槽的一个成员：解析到端点行，或该成员自身的元素错误（不整槽失败）。 */
export type SlotMember =
  | { provider: string; ok: true; row: EndpointRow }
  | { provider: string; ok: false; error: RouteError }

/** 槽解析结果：按提供方身份名有序的成员表；0 命中 = 空表（合法）。 */
export interface SlotOutcome {
  members: SlotMember[]
}

/** 路由钩子：effect 在挂起点用它把 `eff` 解析到端点；实现由宿主按当前端点表构造。 */
export interface RoundRouter {
  /**
   * 解析一个调用到端点行。`target` 给定时为「按成员定位的 many」：`cap` 是扩展类、`target` 是
   * 目标提供方身份名，要求「该类在发出者 `needs` 且 `mode:"many"`」且「目标 ∈ 索引(类)」；
   * 缺省为单值语义（`pins` / `one`-needs / 自能力）。
   */
  resolve(
    world: World,
    emitterId: string,
    cap: string,
    method: string,
    target?: string,
  ): RouteOutcome
  /**
   * 按 `many` 声明解析槽：有序成员表（各自端点行或元素错误）。
   * 未声明该 cap / `mode:"one"` / 发出者无装配世代 → null（`one` 走 `resolve` 的 needs 分支）。
   */
  resolveSlot?(world: World, emitterId: string, cap: string, method: string): SlotOutcome | null
  /**
   * 路由实际采用的解析世界（可选）：注入 `liveWorld` 时 `resolve` 按活世界解析，
   * 调用方（run loop 的方法级超时解析）须与路由同代，故经此取同一 getter 的结果。
   * 缺省（未实现）⇒ 解析世界 = 传入的锚定世界。
   */
  resolutionWorld?(anchored: World): World
}

/**
 * 宿主保留能力类调用器：方法级派发，`emitter` 是发出者身份（thread.resume 的 initiator 用它）。
 * 返回一律是数据（成功值或错误码），不抛错。
 */
export type HostCapabilityCall = (
  method: string,
  emitter: string,
  args: Json,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<EndpointCallResult>

export interface RouterOptions {
  endpoints: EndpointTable
  /** 源码 CAS 目录：解析身份声明（pointer blob）时经它读文本。 */
  blobsDir?: string
  /** pin 哈希与依赖当前 active 不一致：漂移证据（每次解析都可能触发，去重归调用方），不阻塞调用。 */
  onDrift?: (emitter: string, cap: string, gen: Hash) => void
  /** 宿主保留能力类派发器；缺省时 `host` 路由 → `not_loaded`（未接线，不猜）。 */
  host?: HostCapabilityCall
  /**
   * 活端点表世界 getter：提供时按它解析（而非传入的锚定世界），使解析世界与活端点表同代，
   * 消除「锚定世界 active 世代 vs 端点表已换代」的偏斜；缺省仍用锚定世界（判定/路由/提交同世界）。
   */
  liveWorld?: () => World
}

/** 宿主保留端点行：无进程（pid 0），调用经注入的派发器；`gen` 也是保留字面量。 */
function hostRow(emitter: string, method: string, host: HostCapabilityCall): EndpointRow {
  return {
    impl: HOST_CAPABILITY,
    gen: HOST_CAPABILITY,
    cap: HOST_CAPABILITY,
    method,
    transport: 'host',
    pid: 0,
    link: {
      call: (_port, called, args, timeoutMs, signal) =>
        host(called, emitter, args, timeoutMs, signal),
    },
  }
}

/**
 * 构造 A1 路由器。ownerIndex 按 `world.ids` 对象缓存（同代世界共享 ids，重建是 O(#身份×世代)）；
 * 依赖"已声明能力类"按身份缓存**最近一次解析的世代**——gen 是内容哈希、声明不可变，命中即可复用；
 * 只保留每个身份的最近世代，避免键含世代哈希的 Map 只增（世代换代即替换）。
 */
export function createRoundRouter(options: RouterOptions): RoundRouter {
  const ownerIndexes = new WeakMap<World['ids'], Map<Hash, string>>()
  // 每个身份只留最近解析的 (gen → {caps, needs})：声明不可变，命中可复用；换代替换，不随历史世代累积。
  const declFactsCache = new Map<
    string,
    { gen: Hash; caps: Set<string>; needs: Record<string, NeedDecl> }
  >()

  const ownerIndexOf = (world: World): Map<Hash, string> => {
    const cached = ownerIndexes.get(world.ids)
    if (cached !== undefined) return cached
    const index = buildOwnerIndex(world)
    ownerIndexes.set(world.ids, index)
    return index
  }

  const factsOf = (
    world: World,
    id: string,
    gen: Hash,
  ): { caps: Set<string>; needs: Record<string, NeedDecl> } | null => {
    const cached = declFactsCache.get(id)
    if (cached !== undefined && cached.gen === gen) return cached
    const decl = readPluginDecl(world, id, options.blobsDir)?.decl ?? null
    // 声明读不出（def / blob 暂缺）：不缓存 null，下一次解析可重试；补齐后同键重算成功
    if (decl === null) return null
    const facts = { gen, caps: new Set(decl.implements), needs: decl.needs }
    declFactsCache.set(id, facts)
    return facts
  }

  const implementsOf = (world: World, id: string, gen: Hash): Set<string> | null =>
    factsOf(world, id, gen)?.caps ?? null

  const needsOf = (world: World, id: string, gen: Hash): Record<string, NeedDecl> | null =>
    factsOf(world, id, gen)?.needs ?? null

  /**
   * 按成员定位的 many：发出者对 `cap` 须声明 `needs` 且 `mode:"many"`，`target` 须是世界能力索引(cap)
   * 的成员；命中则解析到该成员在 `cap` 上的端点行。任一不满足作数据错误，不抛。
   */
  const resolveMember = (
    resolutionWorld: World,
    emitterId: string,
    cap: string,
    method: string,
    target: string,
  ): RouteOutcome => {
    const gen = assemblyGen(resolutionWorld, emitterId)
    if (gen === null) return { ok: false, error: 'unresolved_cap' }
    const need = needsOf(resolutionWorld, emitterId, gen.payload)?.[cap]
    if (need === undefined || need.mode !== 'many') return { ok: false, error: 'unresolved_cap' }
    const members = capabilityProviders(resolutionWorld, cap, options.blobsDir)
    if (!members.includes(target)) return { ok: false, error: 'not_loaded' }
    if (!Object.hasOwn(resolutionWorld.ids, target)) return { ok: false, error: 'stale' }
    const memberGen = assemblyGen(resolutionWorld, target)
    if (memberGen === null) return { ok: false, error: 'stale' }
    const caps = implementsOf(resolutionWorld, target, memberGen.payload)
    if (caps === null || !caps.has(cap)) return { ok: false, error: 'not_loaded' }
    const row = options.endpoints.get(target, memberGen.payload, cap, method)
    if (row === null) return { ok: false, error: 'not_loaded' }
    return { ok: true, row }
  }

  return {
    resolutionWorld(anchored) {
      // 活端点表世界优先（提供时）：解析世代与端点表同代，避免换代偏斜
      return options.liveWorld?.() ?? anchored
    },
    resolve(world, emitterId, cap, method, target) {
      // 活端点表世界优先（提供时）：解析世代与端点表同代，避免换代偏斜
      const resolutionWorld = options.liveWorld?.() ?? world
      // 按成员定位的 many：扩展类在发出者 needs 且 mode:"many"，目标须是世界索引(cap)成员。
      if (target !== undefined)
        return resolveMember(resolutionWorld, emitterId, cap, method, target)
      // G7 A1：pins / 声明 / 端点都按「最近代码世代」解析（数据世代可能正处 active）
      const gen = assemblyGen(resolutionWorld, emitterId)
      const pinned = gen?.pins[cap]
      if (pinned === undefined) {
        // `one` 绑定（`commit.body.meta.needs` 的身份名）：按绑定身份当前代码世代解析端点，
        // 优先于自能力路径。按名绑定（非哈希）故不触发 `onDrift`、不比对 pinned 与 active。
        const bound = gen === null ? undefined : needsBindingsOf(resolutionWorld, gen)[cap]
        if (typeof bound === 'string') {
          if (!Object.hasOwn(resolutionWorld.ids, bound)) return { ok: false, error: 'stale' }
          const ownerGen = assemblyGen(resolutionWorld, bound)
          if (ownerGen === null) return { ok: false, error: 'stale' }
          const boundCaps = implementsOf(resolutionWorld, bound, ownerGen.payload)
          if (boundCaps === null || !boundCaps.has(cap)) return { ok: false, error: 'not_loaded' }
          const boundRow = options.endpoints.get(bound, ownerGen.payload, cap, method)
          if (boundRow === null) return { ok: false, error: 'not_loaded' }
          return { ok: true, row: boundRow }
        }
        // 自能力路径（无自 pin）：发出者未 pin 该 cap，但自身装配世代声明实现了它 →
        // 解析到发出者自己的端点行。保留能力类 `host` 不参与（须显式 pin 值 host 才认）。
        if (gen === null || cap === HOST_CAPABILITY) return { ok: false, error: 'unresolved_cap' }
        const own = implementsOf(resolutionWorld, emitterId, gen.payload)
        if (own === null || !own.has(cap)) return { ok: false, error: 'unresolved_cap' }
        const ownRow = options.endpoints.get(emitterId, gen.payload, cap, method)
        if (ownRow === null) return { ok: false, error: 'not_loaded' }
        return { ok: true, row: ownRow }
      }
      // 保留能力类 `host`：只认 cap = host 且方法在保留集内，不查世界 / 端点表
      if (pinned === HOST_CAPABILITY) {
        if (cap !== HOST_CAPABILITY || !HOST_METHODS.has(method)) {
          return { ok: false, error: 'not_loaded' }
        }
        if (options.host === undefined) return { ok: false, error: 'not_loaded' }
        return { ok: true, row: hostRow(emitterId, method, options.host) }
      }
      if (resolutionWorld.defs[pinned] === undefined) return { ok: false, error: 'stale' }
      const owner = ownerIndexOf(resolutionWorld).get(pinned)
      if (owner === undefined) return { ok: false, error: 'stale' }
      const ownerGen = assemblyGen(resolutionWorld, owner)
      if (ownerGen === null) return { ok: false, error: 'stale' }
      const caps = implementsOf(resolutionWorld, owner, ownerGen.payload)
      if (caps === null || !caps.has(cap)) return { ok: false, error: 'not_loaded' }
      const row = options.endpoints.get(owner, ownerGen.payload, cap, method)
      if (row === null) return { ok: false, error: 'not_loaded' }
      if (pinned !== ownerGen.payload) options.onDrift?.(emitterId, cap, ownerGen.payload)
      return { ok: true, row }
    },
    resolveSlot(world, emitterId, cap, method) {
      // 活端点表世界优先（提供时）：与 `resolve` 同规，成员按当前世界解析、随世界收缩 / 扩张。
      const resolutionWorld = options.liveWorld?.() ?? world
      const gen = assemblyGen(resolutionWorld, emitterId)
      if (gen === null) return null
      const needs = needsOf(resolutionWorld, emitterId, gen.payload)
      const need = needs?.[cap]
      if (need === undefined || need.mode !== 'many') return null
      // 成员 = 世界能力索引（码元序、排除退役 / 声明读不出 / host）逐项解析端点行；
      // 端点行缺失（休眠隔离 / 方法未声明）作该成员的元素错误，不整槽失败；静默缺席者不入表。
      const members: SlotMember[] = []
      for (const provider of capabilityProviders(resolutionWorld, cap, options.blobsDir)) {
        const memberGen = assemblyGen(resolutionWorld, provider)
        if (memberGen === null) {
          members.push({ provider, ok: false, error: 'not_loaded' })
          continue
        }
        const caps = implementsOf(resolutionWorld, provider, memberGen.payload)
        if (caps === null || !caps.has(cap)) {
          members.push({ provider, ok: false, error: 'not_loaded' })
          continue
        }
        const row = options.endpoints.get(provider, memberGen.payload, cap, method)
        if (row === null) {
          members.push({ provider, ok: false, error: 'not_loaded' })
          continue
        }
        members.push({ provider, ok: true, row })
      }
      return { members }
    },
  }
}
