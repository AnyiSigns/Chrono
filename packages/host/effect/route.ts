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
  /** pin 哈希与依赖当前 active 不一致：漂移证据（每次解析都可能触发，去重归调用方），不阻塞调用。 */
  onDrift?: (emitter: string, cap: string, gen: Hash) => void
  /** 宿主保留能力类派发器；缺省时 `host` 路由 → `not_loaded`（未接线，不猜）。 */
  host?: HostCapabilityCall
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
 * 构造 A1 路由器。ownerIndex 按世界对象缓存（世界只在 done 轮换代，轮内审计 put 不改 ids），
 * 依赖“已声明能力类”按 (impl, gen) 缓存解析结果——解析仍每调用机械对照世界。
 */
export function createRoundRouter(options: RouterOptions): RoundRouter {
  const ownerIndexes = new WeakMap<World, Map<Hash, string>>()
  const implementsCache = new Map<string, Set<string> | null>()

  const ownerIndexOf = (world: World): Map<Hash, string> => {
    const cached = ownerIndexes.get(world)
    if (cached !== undefined) return cached
    const index = new Map<Hash, string>()
    const ids = Object.keys(world.ids).sort()
    for (const id of ids) {
      const identity = world.ids[id]
      if (identity.active === null) continue
      for (const gen of identity.gens) {
        if (gen.payload === identity.active && !index.has(gen.payload)) index.set(gen.payload, id)
      }
    }
    for (const id of ids) {
      for (const gen of world.ids[id].gens) {
        if (!index.has(gen.payload)) index.set(gen.payload, id)
      }
    }
    ownerIndexes.set(world, index)
    return index
  }

  const implementsOf = (world: World, id: string, gen: Hash): Set<string> | null => {
    const key = `${id}\u0000${gen}`
    const cached = implementsCache.get(key)
    if (cached !== undefined) return cached
    const decl = readPluginDecl(world, id)?.decl ?? null
    const caps = decl === null ? null : new Set(decl.implements)
    implementsCache.set(key, caps)
    return caps
  }

  return {
    resolve(world, emitterId, cap, method) {
      // G7 A1：pins / 声明 / 端点都按「最近代码世代」解析（数据世代可能正处 active）
      const gen = assemblyGen(world, emitterId)
      const pinned = gen?.pins[cap]
      if (pinned === undefined) {
        // 自能力路径（无自 pin）：发出者未 pin 该 cap，但自身装配世代声明实现了它 →
        // 解析到发出者自己的端点行。保留能力类 `host` 不参与（须显式 pin 值 host 才认）。
        if (gen === null || cap === HOST_CAPABILITY) return { ok: false, error: 'unresolved_cap' }
        const own = implementsOf(world, emitterId, gen.payload)
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
      if (world.defs[pinned] === undefined) return { ok: false, error: 'stale' }
      const owner = ownerIndexOf(world).get(pinned)
      if (owner === undefined) return { ok: false, error: 'stale' }
      const ownerGen = assemblyGen(world, owner)
      if (ownerGen === null) return { ok: false, error: 'stale' }
      const caps = implementsOf(world, owner, ownerGen.payload)
      if (caps === null || !caps.has(cap)) return { ok: false, error: 'not_loaded' }
      const row = options.endpoints.get(owner, ownerGen.payload, cap, method)
      if (row === null) return { ok: false, error: 'not_loaded' }
      if (pinned !== ownerGen.payload) options.onDrift?.(emitterId, cap, ownerGen.payload)
      return { ok: true, row }
    },
  }
}
