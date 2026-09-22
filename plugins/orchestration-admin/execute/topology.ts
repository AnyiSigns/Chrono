// 图拓扑工具：邻接表 / 可达性 / 环检测 / 拓扑序 / 出入度。纯函数，无副作用。
// 供机械闸的闭合、publish 偏序、审批段可达性、llm_chain_max 折算共用。

import type { Rec } from './types.ts'

export interface Topology {
  n: number
  succ: number[][]
  pred: number[][]
  edgeKeys: string[]
}

function edgeEndpoints(edge: Rec): [number, number] | null {
  const from = Array.isArray(edge['from']) ? edge['from'] : []
  const to = Array.isArray(edge['to']) ? edge['to'] : []
  if (from.length !== 2 || to.length !== 2) return null
  const u = from[0]
  const v = to[0]
  if (typeof u !== 'number' || typeof v !== 'number') return null
  if (!Number.isInteger(u) || !Number.isInteger(v)) return null
  return [u, v]
}

/** 由节点数与边表建拓扑；越界边不计入（越界另由闭合检查报错）。 */
export function buildTopology(n: number, edges: Rec[]): Topology {
  const succ: number[][] = Array.from({ length: n }, () => [])
  const pred: number[][] = Array.from({ length: n }, () => [])
  const edgeKeys: string[] = []
  for (const edge of edges) {
    const ends = edgeEndpoints(edge)
    if (ends === null) continue
    const [u, v] = ends
    if (u < 0 || u >= n || v < 0 || v >= n) continue
    succ[u].push(v)
    pred[v].push(u)
  }
  return { n, succ, pred, edgeKeys }
}

/** 从 `from` 出发（含自身）的可达节点集合。 */
export function reachableSet(topo: Topology, from: number): Set<number> {
  const seen = new Set<number>()
  if (from < 0 || from >= topo.n) return seen
  const stack = [from]
  seen.add(from)
  while (stack.length > 0) {
    const node = stack.pop() as number
    for (const next of topo.succ[node]) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

/** `from` 是否能到达 `to`（含 from === to）。 */
export function reaches(topo: Topology, from: number, to: number): boolean {
  if (from === to) return from >= 0 && from < topo.n
  return reachableSet(topo, from).has(to)
}

/** 是否存在有向环（Kahn 拓扑序长度 < n 即存在）。 */
export function hasCycle(topo: Topology): boolean {
  const indeg = topo.pred.map((list) => list.length)
  const queue: number[] = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.pop() as number
    visited += 1
    for (const next of topo.succ[node]) {
      indeg[next] -= 1
      if (indeg[next] === 0) queue.push(next)
    }
  }
  return visited < topo.n
}

/** 拓扑序（DAG 时）；有环时回落自然序（调用方已另行报环）。 */
export function topoOrder(topo: Topology): number[] {
  const indeg = topo.pred.map((list) => list.length)
  const queue: number[] = []
  for (let i = 0; i < topo.n; i++) if (indeg[i] === 0) queue.push(i)
  const order: number[] = []
  while (queue.length > 0) {
    const node = queue.shift() as number
    order.push(node)
    for (const next of topo.succ[node]) {
      indeg[next] -= 1
      if (indeg[next] === 0) queue.push(next)
    }
  }
  if (order.length < topo.n) {
    for (let i = 0; i < topo.n; i++) if (!order.includes(i)) order.push(i)
  }
  return order
}

export function hasEdge(topo: Topology, u: number, v: number): boolean {
  return u >= 0 && u < topo.n && topo.succ[u].includes(v)
}
