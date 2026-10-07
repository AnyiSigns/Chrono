// 世界级能力索引：能力类 → 提供方 / 拥有方身份集（按身份名字典序）。
// 入世解析与路由共用同一份函数，避免两处口径漂移。
// 世代声明派生事实按 payload（内容哈希 ⇒ 不可变）缓存：离线 seed 就地演化锚点世界，
// `world.ids` 对象引用不变，故不能按键控世界的 WeakMap 缓存索引本身；索引每次从
// `world.ids` + 世代事实缓存重算，O(#身份)，随世界确定性地增减。

import { assemblyGen, readPluginDecl, readPluginDeclOfGen } from './decl.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import type { PluginDecl, SlotDecl } from './decl.ts'
import type { Gen, World } from '../../kernel/index.ts'

/** 能力索引：能力类 → 提供方 / 拥有方身份集（各自按身份名字典序）。 */
export interface CapabilityIndex {
  providers: Map<string, string[]>
  owners: Map<string, string[]>
}

/** 单个世代声明里与能力索引相关的事实（提供方 `implements`、拥有方 `slots`）。 */
interface GenFacts {
  implements: ReadonlySet<string>
  slots: Readonly<Record<string, SlotDecl>>
}

/** 世代事实缓存上限：超出按写入序淘汰最旧，保证有界。 */
export const GEN_FACTS_CACHE_MAX = 256
const genFactsCache = new Map<string, GenFacts>()

/** 仅供测试：当前世代事实缓存条目数（验证有界性）。 */
export function capabilityFactsCacheSize(): number {
  return genFactsCache.size
}

/**
 * 世代事实缓存键：payload（内容哈希 ⇒ 声明不可变）+ 同语言入口扩展名。
 * 声明解析成败取决于 profile 的 `entryExtensions`（`inproc` / `worker` 入口门禁），
 * 故不同 profile 下同一 payload 的解析结果可能不同，缓存须按扩展名隔离。
 */
function factsCacheKey(gen: Gen, ecosystem: EcosystemProfile): string {
  return `${gen.payload}\u0000${ecosystem.entryExtensions.join(',')}`
}

/**
 * 读某世代的声明派生事实。按 `factsCacheKey` 缓存：同键则声明内容不可变。
 * 声明读不出（def / blob 暂缺）不缓存，补齐后同键可重算成功。
 */
function factsOfGen(
  world: World,
  gen: Gen,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): GenFacts | null {
  const key = factsCacheKey(gen, ecosystem)
  const cached = genFactsCache.get(key)
  if (cached !== undefined) return cached
  const read = readPluginDeclOfGen(world, gen, blobsDir, ecosystem)
  if (read === null) return null
  const facts: GenFacts = {
    implements: new Set(read.decl.implements),
    slots: read.decl.slots,
  }
  if (genFactsCache.size >= GEN_FACTS_CACHE_MAX) {
    const oldest = genFactsCache.keys().next().value
    if (oldest !== undefined) genFactsCache.delete(oldest)
  }
  genFactsCache.set(key, facts)
  return facts
}

/** 把身份追加到能力类索引项（首次出现建表；身份 id 升序遍历故结果天然有序）。 */
function appendToIndex(index: Map<string, string[]>, cap: string, id: string): void {
  const list = index.get(cap)
  if (list === undefined) index.set(cap, [id])
  else list.push(id)
}

/**
 * 建世界能力索引：遍历 active 身份（排除退役 `active === null`），按其装配世代声明
 * 汇总提供方（`implements`）与拥有方（`slots`）；声明读不出的身份静默缺席。
 * 身份名按码元序升序遍历，故各能力类的身份集同为码元序。
 */
export function buildCapabilityIndex(
  world: World,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): CapabilityIndex {
  const providers = new Map<string, string[]>()
  const owners = new Map<string, string[]>()
  for (const id of Object.keys(world.ids).sort()) {
    const gen = assemblyGen(world, id)
    if (gen === null) continue
    const facts = factsOfGen(world, gen, blobsDir, ecosystem)
    if (facts === null) continue
    for (const cap of facts.implements) {
      // 保留能力类 `host` 不是世界身份提供的，不入索引
      if (cap === HOST_CAPABILITY) continue
      appendToIndex(providers, cap, id)
    }
    for (const cap of Object.keys(facts.slots)) {
      if (cap === HOST_CAPABILITY) continue
      appendToIndex(owners, cap, id)
    }
  }
  return { providers, owners }
}

/** 某能力类的提供方身份名列表（码元序）；无则空表。 */
export function capabilityProviders(
  world: World,
  cap: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] {
  return buildCapabilityIndex(world, blobsDir, ecosystem).providers.get(cap) ?? []
}

/** 某能力类的拥有方身份名列表（码元序）；无则空表。 */
export function capabilityOwners(
  world: World,
  cap: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] {
  return buildCapabilityIndex(world, blobsDir, ecosystem).owners.get(cap) ?? []
}

/**
 * 某身份当前代码世代 `implements` 的能力类（声明序，排除保留能力类 `host`）。
 * 供宿主在「按成员定位的 many」下，用成员自身能力类解析方法级超时（调用端口是扩展类名）。
 */
export function implementedCaps(
  world: World,
  identityId: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] {
  const gen = assemblyGen(world, identityId)
  if (gen === null) return []
  const facts = factsOfGen(world, gen, blobsDir, ecosystem)
  if (facts === null) return []
  return [...facts.implements].filter((cap) => cap !== HOST_CAPABILITY)
}

/**
 * 某能力类的方法契约：第一个拥有方（码元序）`slots[cap].methods`；无拥有方 → `null`。
 * 返回副本，避免调用方改动缓存内的事实。
 */
export function capabilityContract(
  world: World,
  cap: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] | null {
  const owner = capabilityOwners(world, cap, blobsDir, ecosystem)[0]
  if (owner === undefined) return null
  const gen = assemblyGen(world, owner)
  if (gen === null) return null
  const facts = factsOfGen(world, gen, blobsDir, ecosystem)
  const contract = facts?.slots[cap]?.methods
  return contract === undefined ? null : [...contract]
}

/** 同一能力类的多个拥有方：契约「单源在拥有方」被多个身份同时声明，取码元序首个会静默随世界增删改绑。 */
export interface CapabilityOwnerConflict {
  cap: string
  /** 拥有方身份名（码元序）。 */
  owners: string[]
  /** 各拥有方声明的 methods（与 `owners` 同序）。 */
  contracts: string[][]
  /** 各拥有方契约是否一致；不一致时「取首个」的语义漂移最危险。 */
  diverges: boolean
}

/** 两个字符串数组是否同集合（忽略顺序，元素已保证无重复）。 */
function sameMethodSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  if (set.size !== new Set(b).size) return false
  return b.every((method) => set.has(method))
}

/**
 * 检测同一能力类存在多个拥有方（`slots[cap]`）的契约冲突。
 * `capabilityContract` 取码元序首个拥有方；世界增删拥有方会静默改绑消费方用的契约——
 * 宿主据此记运维事件（`capability_owner_conflict`），不静默随世界增删改绑。
 * 返回按能力类码元序；单拥有方 / 无拥有方不入表。
 */
export function capabilityOwnerConflicts(
  world: World,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): CapabilityOwnerConflict[] {
  const index = buildCapabilityIndex(world, blobsDir, ecosystem)
  const out: CapabilityOwnerConflict[] = []
  for (const cap of [...index.owners.keys()].sort()) {
    const owners = index.owners.get(cap) ?? []
    if (owners.length < 2) continue
    const contracts = owners.map((owner) => {
      const gen = assemblyGen(world, owner)
      if (gen === null) return []
      const facts = factsOfGen(world, gen, blobsDir, ecosystem)
      return [...(facts?.slots[cap]?.methods ?? [])]
    })
    const first = contracts[0]
    const diverges = contracts.some((contract) => !sameMethodSet(first, contract))
    out.push({ cap, owners: [...owners], contracts, diverges })
  }
  return out
}

/**
 * 该身份当前代码世代的 `many` 成员表：`needs` 中 `mode:"many"` 的能力类 → 世界能力索引(cap)
 * 的提供方身份名（码元序，排除退役 / 声明读不出 / `host`）。无代码世代 / 声明不可解析 → `null`。
 * 单一来源：宿主注入服务工厂上下文的 `manyNeeds`（服务据此按成员反向定位，枢纽不枚举提供方）。
 */
export function manyNeedsOf(
  world: World,
  identityId: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): Record<string, string[]> | null {
  const decl = readPluginDecl(world, identityId, blobsDir, ecosystem)
  if (decl === null) return null
  return manyNeedsForDecl(decl.decl, identityId, buildCapabilityIndex(world, blobsDir, ecosystem))
}

function manyNeedsForDecl(
  decl: PluginDecl,
  identityId: string,
  index: CapabilityIndex,
): Record<string, string[]> {
  const caps = Object.keys(decl.needs)
    .filter((cap) => decl.needs[cap].mode === 'many')
    .sort()
  const out: Record<string, string[]> = {}
  for (const cap of caps) {
    out[cap] = (index.providers.get(cap) ?? []).filter((id) => id !== identityId)
  }
  return out
}

/**
 * 全世界的 `many` 成员快照：身份 → `manyNeedsOf`（仅含声明了 `many` 需求的身份）。供宿主对比
 * 世界变迁前后成员集，命中变更的消费方强制重注入（成员变更 = 世界变更 → 重解析重注入）。
 */
export function manyNeedsMap(
  world: World,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): Map<string, Record<string, string[]>> {
  const index = buildCapabilityIndex(world, blobsDir, ecosystem)
  const out = new Map<string, Record<string, string[]>>()
  for (const id of Object.keys(world.ids).sort()) {
    const decl = readPluginDecl(world, id, blobsDir, ecosystem)
    if (decl === null) continue
    const hasMany = Object.values(decl.decl.needs).some((need) => need.mode === 'many')
    if (!hasMany) continue
    out.set(id, manyNeedsForDecl(decl.decl, id, index))
  }
  return out
}

/**
 * 提供方对某能力类的有效方法集：本包 `decl.methods[cap]` 优先；否则本包 `slots[cap].methods`
 * （拥有方自产自用）；否则世界契约；都没有 → 空表。
 * `identityId` 用于确认该身份仍在世界里（退役身份不再回落世界契约）。
 */
export function effectiveMethods(
  world: World,
  identityId: string,
  decl: PluginDecl,
  cap: string,
  blobsDir?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] {
  const own = decl.methods[cap]
  if (own !== undefined) return own
  const ownSlot = decl.slots[cap]
  if (ownSlot !== undefined) return ownSlot.methods
  if (world.ids[identityId] === undefined) return []
  return capabilityContract(world, cap, blobsDir, ecosystem) ?? []
}
