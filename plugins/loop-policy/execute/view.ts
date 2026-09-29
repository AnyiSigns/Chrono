// 图视图：契约索引 + 拓扑 + 尺度（供解释器 / 收口共用；只装配，不做机械闸校验）。
// 机械闸（闭合 / 类型 / 偏序 / 不变量 / 演化）归 `graph-gate` 提供方，本插件运行时经 `port.call` 消费。

import { contractIndex, graphEdges, graphNodes, graphSink, type GraphModel } from './model.ts'
import { buildTopology, type Topology } from './graph.ts'
import type { Rec } from './types.ts'

export interface GraphView {
  model: GraphModel
  contracts: Map<string, Rec>
  topo: Topology
  n: number
  sink: number
}

export function buildView(model: GraphModel): GraphView {
  const ids = graphNodes(model.graph)
  const topo = buildTopology(ids.length, graphEdges(model.graph))
  return {
    model,
    contracts: contractIndex(model),
    topo,
    n: ids.length,
    sink: graphSink(model.graph),
  }
}
