// A1 路由：发出者 `needs.one` 绑定（cap → 提供方身份名）→ 该身份当前装配世代 → 端点表。
// 宿主依赖哨兵 `host`（绑定值 `host`）→ 宿主保留能力类，不经世界解析。
// 只读世界：不执行效果、不写链；端点表键不含调用方（impl+gen+cap+method）。
// 绑定按身份名跟随：依赖换代即解析到新 active；退役 / 装载失败得 `stale` / `not_loaded`。

import {
  assemblyGen,
  capabilityProviders,
  needsBindingsOf,
  readPluginDecl,
  resolveJudgmentHash,
} from '../assembly/index.ts'
import { DEFAULT_ECOSYSTEM } from '../assembly/ecosystem.ts'
import type { EcosystemProfile } from '../assembly/ecosystem.ts'
import { HOST_CAPABILITY, HOST_METHODS } from '../host-methods.ts'
import type { DeclRead, NeedDecl } from '../assembly/index.ts'
import type { JudgmentCall } from './judgment.ts'
import type { EndpointCallResult, EndpointRow } from '../endpoint-table.ts'
import type { EndpointTable } from '../endpoint-table.ts'
import type { CallEnv } from '../wire.ts'
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
 * 宿主保留能力类调用器：方法级派发，`emitter` 是发出者身份（run.spawn 的 initiator 用它）。
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
  /** 生态 profile：声明解析（同语言入口扩展名等）随它；缺省内建默认（零行为变化）。 */
  ecosystem?: EcosystemProfile
  /** 宿主保留能力类派发器；缺省时 `host` 路由 → `not_loaded`（未接线，不猜）。 */
  host?: HostCapabilityCall
  /**
   * 判定求值器：命中提供方 `judgments` 的能力方法由它就地求值（无服务）。
   * 缺省时命中判定 → `not_loaded`（未接线，不猜）。
   */
  judgment?: JudgmentCall
  /**
   * 活端点表世界 getter：提供时按它解析（而非传入的锚定世界），使解析世界与活端点表同代，
   * 消除「锚定世界 active 世代 vs 端点表已换代」的偏斜；缺省仍用锚定世界（判定/路由/提交同世界）。
   */
  liveWorld?: () => World
  /**
   * 运行期休眠身份集 getter：休眠 = 运行期隔离（世界 `active` 未变、服务停、端点摘除）。
   * 判定不住端点表，故须显式按它摘除休眠身份的判定路由——否则休眠身份的判定方法仍可路由。
   */
  suspended?: () => ReadonlySet<string>
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
  // 声明解析口径随构造期注入的生态 profile；缺省即内建默认（零行为变化）。
  const ecosystem = options.ecosystem ?? DEFAULT_ECOSYSTEM
  // 每个身份只留最近解析的 (gen → {caps, needs, judgments})：声明不可变，命中可复用；换代替换，不随历史世代累积。
  const declFactsCache = new Map<
    string,
    {
      gen: Hash
      caps: Set<string>
      needs: Record<string, NeedDecl>
      judgments: Record<string, Record<string, Hash>>
    }
  >()

  const factsOf = (
    world: World,
    id: string,
    gen: Hash,
  ): {
    caps: Set<string>
    needs: Record<string, NeedDecl>
    judgments: Record<string, Record<string, Hash>>
  } | null => {
    const cached = declFactsCache.get(id)
    if (cached !== undefined && cached.gen === gen) return cached
    const read = readPluginDecl(world, id, options.blobsDir, ecosystem)
    // 声明读不出（def / blob 暂缺）：不缓存 null，下一次解析可重试；补齐后同键重算成功
    if (read === null) return null
    const facts = {
      gen,
      caps: new Set(read.decl.implements),
      needs: read.decl.needs,
      judgments: resolveJudgments(world, read),
    }
    declFactsCache.set(id, facts)
    return facts
  }

  /**
   * 解析声明里的 `judgments`：`cap → method → 入口 term def 哈希`（`$ref` 已替换）。
   * 路径解析不到（缺文件 / 坏引用）即从表中省略——该方法的判定不可用，路由回落端点行（无则 `not_loaded`）。
   */
  const resolveJudgments = (world: World, read: DeclRead): Record<string, Record<string, Hash>> => {
    const out: Record<string, Record<string, Hash>> = {}
    for (const cap of Object.keys(read.decl.judgments)) {
      const bound = read.decl.judgments[cap]
      const resolved: Record<string, Hash> = {}
      for (const method of Object.keys(bound)) {
        const hash = resolveJudgmentHash(
          world,
          read.tree,
          bound[method],
          read.gen.sig,
          options.blobsDir,
        )
        if (hash !== null) resolved[method] = hash
      }
      if (Object.keys(resolved).length > 0) out[cap] = resolved
    }
    return out
  }

  /** 该身份/世代在能力类 `cap` 上的方法 `method` 的判定入口哈希；无判定返回 null。 */
  const judgmentEntryOf = (
    world: World,
    id: string,
    gen: Hash,
    cap: string,
    method: string,
  ): Hash | null => factsOf(world, id, gen)?.judgments[cap]?.[method] ?? null

  /** 判定端点行：无进程（pid 未设），调用经注入的判定求值器；缺省时 → `not_loaded`。 */
  const judgeRow = (
    world: World,
    owner: string,
    gen: Hash,
    cap: string,
    method: string,
    entry: Hash,
  ): EndpointRow => ({
    impl: owner,
    gen,
    cap,
    method,
    transport: 'term',
    link: {
      call: (_port, called, args, timeoutMs, signal, env): Promise<EndpointCallResult> => {
        const run = options.judgment
        if (run === undefined) {
          return Promise.resolve({ ok: false, code: 'not_loaded', message: 'judgment not wired' })
        }
        // 外层调用帧原样透传：判定内效果的 run/thread/now 取外层帧，emitter 在落帧时改写为判定属主。
        return run(world, { owner, gen, cap, method: called, entry }, args, timeoutMs, signal, env)
      },
    },
  })

  /**
   * 解析能力类 `cap` 的方法 `method` 到端点行：判定优先（`judgments`），否则查端点表。
   * 判定命中不 spawn 服务、随世界换代热生效；两者皆无 → `not_loaded`。
   */
  const rowFor = (
    world: World,
    owner: string,
    gen: Hash,
    cap: string,
    method: string,
  ): RouteOutcome => {
    // 休眠身份整体不可路由（服务端点已被摘除；判定不住端点表，须在此一并摘除）——
    // 与休眠服务的收口一致：`not_loaded` 数据错误，不抛、不连坐调用方。
    if (options.suspended?.().has(owner) === true) return { ok: false, error: 'not_loaded' }
    const entry = judgmentEntryOf(world, owner, gen, cap, method)
    if (entry !== null) return { ok: true, row: judgeRow(world, owner, gen, cap, method, entry) }
    const row = options.endpoints.get(owner, gen, cap, method)
    if (row === null) return { ok: false, error: 'not_loaded' }
    return { ok: true, row }
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
    const members = capabilityProviders(resolutionWorld, cap, options.blobsDir, ecosystem)
    if (!members.includes(target)) return { ok: false, error: 'not_loaded' }
    if (!Object.hasOwn(resolutionWorld.ids, target)) return { ok: false, error: 'stale' }
    const memberGen = assemblyGen(resolutionWorld, target)
    if (memberGen === null) return { ok: false, error: 'stale' }
    const caps = implementsOf(resolutionWorld, target, memberGen.payload)
    if (caps === null || !caps.has(cap)) return { ok: false, error: 'not_loaded' }
    return rowFor(resolutionWorld, target, memberGen.payload, cap, method)
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
      // G7 A1：`needs` / 声明 / 端点都按「最近代码世代」解析（数据世代可能正处 active）
      const gen = assemblyGen(resolutionWorld, emitterId)
      const bound = gen === null ? undefined : needsBindingsOf(resolutionWorld, gen)[cap]
      if (bound === HOST_CAPABILITY) {
        // 宿主依赖哨兵：只认 cap = host 且方法在保留集内，不查世界 / 端点表
        if (cap !== HOST_CAPABILITY || !HOST_METHODS.has(method)) {
          return { ok: false, error: 'not_loaded' }
        }
        if (options.host === undefined) return { ok: false, error: 'not_loaded' }
        return { ok: true, row: hostRow(emitterId, method, options.host) }
      }
      if (typeof bound === 'string') {
        // `one` 绑定（`commit.body.meta.needs` 的身份名）：按绑定身份当前代码世代解析端点，
        // 优先于自能力路径。按名绑定（非哈希）故只按名跟随，不比对哈希。
        if (!Object.hasOwn(resolutionWorld.ids, bound)) return { ok: false, error: 'stale' }
        const ownerGen = assemblyGen(resolutionWorld, bound)
        if (ownerGen === null) return { ok: false, error: 'stale' }
        const boundCaps = implementsOf(resolutionWorld, bound, ownerGen.payload)
        if (boundCaps === null || !boundCaps.has(cap)) return { ok: false, error: 'not_loaded' }
        return rowFor(resolutionWorld, bound, ownerGen.payload, cap, method)
      }
      // 自能力路径（无消费绑定）：发出者未消费该 cap，但自身装配世代声明实现了它 →
      // 解析到发出者自己的端点行。保留能力类 `host` 不参与（须显式 needs 哨兵才认）。
      if (gen === null || cap === HOST_CAPABILITY) return { ok: false, error: 'unresolved_cap' }
      const own = implementsOf(resolutionWorld, emitterId, gen.payload)
      if (own === null || !own.has(cap)) return { ok: false, error: 'unresolved_cap' }
      return rowFor(resolutionWorld, emitterId, gen.payload, cap, method)
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
      for (const provider of capabilityProviders(
        resolutionWorld,
        cap,
        options.blobsDir,
        ecosystem,
      )) {
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
        const memberRow = rowFor(resolutionWorld, provider, memberGen.payload, cap, method)
        if (!memberRow.ok) {
          members.push({ provider, ok: false, error: memberRow.error })
          continue
        }
        members.push({ provider, ok: true, row: memberRow.row })
      }
      return { members }
    },
  }
}
