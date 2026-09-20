// 闭包（装配相）：沿 pins 只读遍历世界 → SCC + 逆拓扑序 + 坏分支隔离。
// 纯计算：不装载、不执行效果、不写链；产装配计划与运维事件，调用方按序起服务并落日志。
// 运行相（自身换代重装、依赖退役隔离）不在本模块。

import { stale } from '../../kernel/index.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { assemblyGen } from './decl.ts'
import type { Hash, World } from '../../kernel/index.ts'

/** 隔离原因：cycle = 成环分支（环成员及其依赖者）；stale = 依附失效（含依赖者）。 */
export type IsolatedReason = 'cycle' | 'stale'

/** 依赖边：from 依赖 to（to 是被依赖身份，启动序中先起）。 */
export interface DependencyEdge {
  from: string
  to: string
}

export interface IsolatedIdentity {
  id: string
  reason: IsolatedReason
}

export interface AssemblyPlan {
  /** 启动序：被依赖者先起；不含被隔离身份。 */
  order: string[]
  /** 被隔离身份（含坏分支的依赖者）与原因，按 id 排序。 */
  isolated: IsolatedIdentity[]
  /** 检测到的环（每个元素是一个 SCC 的身份集合，成员已排序）。 */
  cycles: string[][]
  /** 根集内的依赖边（from 依赖 to），用于核对启动序。 */
  edges: DependencyEdge[]
  /** 待落运维日志的事件（时间戳 / pid 由调用方补）。 */
  events: Array<{ kind: IsolatedReason; id: string }>
}

interface DepGraph {
  roots: string[]
  edges: DependencyEdge[]
  outgoing: Map<string, string[]>
  dependents: Map<string, string[]>
  depFailed: Set<string>
  selfFailed: Set<string>
}

/**
 * 反查索引：世代 payload → 属主身份，O(1) 反查。
 * 只认 payload（`pins` 解析到的是被依赖身份的世代 payload）；可从 `world.ids` 重建；
 * active 世代的 payload 优先，其余按键与身份 id 字典序先到先得。
 */
export function buildOwnerIndex(world: World): Map<Hash, string> {
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
  return index
}

function appendEdge(map: Map<string, string[]>, from: string, to: string): void {
  const list = map.get(from)
  if (list === undefined) map.set(from, [to])
  else list.push(to)
}

function buildGraph(world: World, ownerIndex: Map<Hash, string>): DepGraph {
  const roots = Object.keys(world.ids)
    .filter((id) => world.ids[id].active !== null)
    .sort()
  const edges: DependencyEdge[] = []
  const seen = new Set<string>()
  const outgoing = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()
  const depFailed = new Set<string>()
  const selfFailed = new Set<string>()
  for (const from of roots) {
    // G7 A1：装配按「最近代码世代」取 pins / 判 stale；数据世代只影响投影读侧。
    const gen = assemblyGen(world, from)
    const payloadDef = gen === null ? undefined : world.defs[gen.payload]
    if (
      !gen ||
      payloadDef === undefined ||
      world.defs[gen.sig] === undefined ||
      stale(payloadDef, world, from)
    ) {
      selfFailed.add(from)
      continue
    }
    for (const pin of Object.values(gen.pins)) {
      // 保留能力类 `host`：不建边、不置 depFailed（宿主不是世界节点）
      if (pin === HOST_CAPABILITY) continue
      const to = ownerIndex.get(pin)
      if (to === undefined || world.ids[to].active === null) {
        depFailed.add(from) // 漏 pins / 依赖退役：显式失效，绝不猜
        continue
      }
      if (seen.has(`${from}\u0000${to}`)) continue
      seen.add(`${from}\u0000${to}`)
      edges.push({ from, to })
      appendEdge(outgoing, from, to)
      appendEdge(dependents, to, from)
    }
  }
  return { roots, edges, outgoing, dependents, depFailed, selfFailed }
}

/** Tarjan 单趟：按发出序给出 SCC —— 对边 A→B，B 的 SCC 先于 A 的 SCC，即被依赖者先起。 */
function tarjan(nodes: string[], outgoing: Map<string, string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0
  const visit = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter += 1
    stack.push(node)
    onStack.add(node)
    for (const next of outgoing.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node) as number, low.get(next) as number))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) as number, index.get(next) as number))
      }
    }
    if (low.get(node) === index.get(node)) {
      const scc: string[] = []
      let member: string
      do {
        member = stack.pop() as string
        onStack.delete(member)
        scc.push(member)
      } while (member !== node)
      sccs.push(scc)
    }
  }
  for (const node of nodes) if (!index.has(node)) visit(node)
  return sccs
}

function hasSelfLoop(id: string, outgoing: Map<string, string[]>): boolean {
  return (outgoing.get(id) ?? []).includes(id)
}

/** 反向可达：种子本身 + 所有（传递）依赖种子的身份；靠 dependents（谁依赖我）上溯。 */
function reverseReachable(seeds: Iterable<string>, dependents: Map<string, string[]>): Set<string> {
  const reached = new Set<string>()
  const queue: string[] = []
  for (const seed of seeds) {
    if (!reached.has(seed)) {
      reached.add(seed)
      queue.push(seed)
    }
  }
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const dependent of dependents.get(current) ?? []) {
      if (!reached.has(dependent)) {
        reached.add(dependent)
        queue.push(dependent)
      }
    }
  }
  return reached
}

/**
 * 装配计划（装配相）：
 * 1. 沿 pins 建依赖边（反查索引把 pin 值解析回被依赖身份；pin 绑定身份、不锁版本）；
 * 2. Tarjan 单趟出 SCC 与逆拓扑序（被依赖者先起）；
 * 3. 环成员及其依赖者、pin 缺失 / 退役依赖、自身世代不完整或相对自身 active 世代 stale 者
 *    同样隔离（含其依赖者）；
 * 4. 其余身份按逆拓扑序装载。
 */
export function computeAssemblyPlan(world: World): AssemblyPlan {
  const ownerIndex = buildOwnerIndex(world)
  const graph = buildGraph(world, ownerIndex)
  const sccs = tarjan(graph.roots, graph.outgoing)

  const cycles: string[][] = []
  const cycleMembers = new Set<string>()
  for (const scc of sccs) {
    if (scc.length === 1 && !hasSelfLoop(scc[0], graph.outgoing)) continue
    const sorted = [...scc].sort()
    cycles.push(sorted)
    for (const id of sorted) cycleMembers.add(id)
  }
  cycles.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const cycleBad = reverseReachable(cycleMembers, graph.dependents)
  const staleSeeds = new Set<string>([...graph.depFailed, ...graph.selfFailed])
  const staleBad = reverseReachable(staleSeeds, graph.dependents)

  const isolated = new Map<string, IsolatedReason>()
  for (const id of staleBad) isolated.set(id, 'stale')
  for (const id of cycleBad) isolated.set(id, 'cycle') // 成环分支按环隔离记账

  const order: string[] = []
  for (const scc of sccs) {
    for (const id of [...scc].sort()) {
      if (!isolated.has(id)) order.push(id)
    }
  }

  const isolatedList = [...isolated.keys()]
    .sort()
    .map((id) => ({ id, reason: isolated.get(id) as IsolatedReason }))
  return {
    order,
    isolated: isolatedList,
    cycles,
    edges: graph.edges,
    events: isolatedList.map((entry) => ({ kind: entry.reason, id: entry.id })),
  }
}
