// A1 路由：发出者 pins（名 → 哈希）→ def → 属主身份 → 该身份当前 active 世代 → 端点表。
// 只读世界：不执行效果、不写链；端点表键不含调用方（impl+gen+cap+method）。
// `pin` 绑定身份：依赖换代重解析到新 active；pin 哈希 ≠ 依赖 active 只记漂移证据，不阻塞。

import { assemblyGen, readPluginDecl } from '../assembly/decl.ts'
import { HOST_CAPABILITY, HOST_METHODS } from '../host-methods.ts'
import type { EndpointCallResult, EndpointRow } from '../endpoint-table.ts'
import type { EndpointTable } from '../endpoint-table.ts'
import type { Gen, Hash, Identity, Json, World } from '../../kernel/index.ts'

/** 路由失败码：与 protocol §四 同名（作为 `EffResult.error` 落审计，内核归 `eff_error`）。 */
export type RouteError = 'unresolved_cap' | 'not_loaded' | 'stale'

export type RouteOutcome = { ok: true; row: EndpointRow } | { ok: false; error: RouteError }

/** 路由钩子：effect 在挂起点用它把 `eff` 解析到端点；实现由宿主按当前端点表构造。 */
export interface RoundRouter {
  resolve(world: World, emitterId: string, cap: string, method: string): RouteOutcome
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

/** 身份当前 active 世代；无身份 / retired / 世代缺失返回 null。 */
export function activeGenOf(identity: Identity | undefined): Gen | null {
  if (identity === undefined || identity.active === null) return null
  return identity.gens.find((gen) => gen.payload === identity.active) ?? null
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
 * 构造 A1 路由器。ownerIndex 按 `world.ids` 对象缓存（审计落账只改 defs、共享 ids，
 * 故同代身份的索引跨审计命中）；依赖"已声明能力类"按 (impl, gen) 缓存解析结果——
 * gen 是内容哈希，声明不可变，命中即可复用；解析仍每调用机械对照世界。
 */
export function createRoundRouter(options: RouterOptions): RoundRouter {
  const ownerIndexes = new WeakMap<World['ids'], Map<Hash, string>>()
  // 已声明能力类按 (id, gen) 缓存（gen 内容哈希 ⇒ 声明不可变）；声明读不出（null）不缓存，下次可重试。
  const implementsCache = new Map<string, Set<string>>()

  const ownerIndexOf = (ids: World['ids']): Map<Hash, string> => {
    const cached = ownerIndexes.get(ids)
    if (cached !== undefined) return cached
    const index = new Map<Hash, string>()
    const keys = Object.keys(ids).sort()
    for (const id of keys) {
      const identity = ids[id]
      if (identity.active === null) continue
      for (const gen of identity.gens) {
        if (gen.payload === identity.active && !index.has(gen.payload)) index.set(gen.payload, id)
      }
    }
    for (const id of keys) {
      for (const gen of ids[id].gens) {
        if (!index.has(gen.payload)) index.set(gen.payload, id)
      }
    }
    ownerIndexes.set(ids, index)
    return index
  }

  const implementsOf = (world: World, id: string, gen: Hash): Set<string> | null => {
    const key = `${id}\u0000${gen}`
    const cached = implementsCache.get(key)
    if (cached !== undefined) return cached
    const decl = readPluginDecl(world, id, options.blobsDir)?.decl ?? null
    // 声明读不出（def / blob 暂缺）：不缓存 null，下一次解析可重试；补齐后同键重算成功
    if (decl === null) return null
    const caps = new Set(decl.implements)
    implementsCache.set(key, caps)
    return caps
  }

  return {
    resolutionWorld(anchored) {
      // 活端点表世界优先（提供时）：解析世代与端点表同代，避免换代偏斜
      return options.liveWorld?.() ?? anchored
    },
    resolve(world, emitterId, cap, method) {
      // 活端点表世界优先（提供时）：解析世代与端点表同代，避免换代偏斜
      const resolutionWorld = options.liveWorld?.() ?? world
      // G7 A1：pins / 声明 / 端点都按「最近代码世代」解析（数据世代可能正处 active）
      const gen = assemblyGen(resolutionWorld, emitterId)
      const pinned = gen?.pins[cap]
      if (pinned === undefined) {
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
      const owner = ownerIndexOf(resolutionWorld.ids).get(pinned)
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
  }
}
