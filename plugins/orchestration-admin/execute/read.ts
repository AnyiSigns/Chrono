// `orchestration.list` / `orchestration.read`：只读概览与条目全文。
// 输入全部来自 bag（#33 装配）：六类条目 + 台账 + pins；服务不读投影、不发 eff、不写世界。

import {
  contractId,
  effectsPorts,
  graphDerivedFrom,
  graphEdges,
  graphNodes,
  graphSink,
  nodeContractId,
  nodeId,
  nodeImpl,
  nodeLinks,
  nodeScope,
  readGraphModel,
} from './model.ts'
import { isRecord } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 台账条目（#33 装配已解析的数组形态；无则空）。 */
function ledgerEntries(bag: Rec, kind: string): Rec[] {
  const evolution = bag['evolution']
  if (isRecord(evolution) && Array.isArray(evolution[kind])) {
    return (evolution[kind] as Json[]).filter(isRecord)
  }
  if (Array.isArray(bag[kind])) return (bag[kind] as Json[]).filter(isRecord)
  return []
}

/** 关联证据摘要：按契约 / 图哈希匹配 `cluster_key`，只回摘要不回全文。 */
function relatedEvidence(bag: Rec, target: string): Json[] {
  const out: Json[] = []
  for (const entry of ledgerEntries(bag, 'evidence')) {
    const cluster = isRecord(entry['cluster_key']) ? entry['cluster_key'] : {}
    const contract = cluster['contract_id']
    if (contract !== target) continue
    out.push({
      id: typeof entry['id'] === 'string' ? entry['id'] : null,
      class: typeof entry['class'] === 'string' ? entry['class'] : null,
      n: typeof entry['n'] === 'number' ? entry['n'] : 0,
    })
  }
  return out
}

/** `orchestration.list`：当前图的 Scope 概览 + 契约清单 + 阈值表。 */
export function listTool(bag: Rec): Json {
  const model = readGraphModel(bag['graph'])
  if (model === null) {
    return { ok: true, graph_present: false, scopes: [], contracts: [], thresholds: {} }
  }
  const ids = graphNodes(model.graph)
  const scopes = model.nodes.map((node) => {
    const contract = nodeContractId(node)
    return {
      node_id: nodeId(node),
      contract_id: contract,
      node_index: contract === null ? -1 : ids.indexOf(contract),
      impl: nodeImpl(node),
      scope: nodeScope(node),
      autonomy: typeof node['autonomy'] === 'string' ? node['autonomy'] : null,
      links: nodeLinks(node),
    }
  })
  const contracts = model.contracts.map((contract) => ({
    contract_id: contractId(contract),
    touches_effects: contract['touches_effects'] === true,
    effects_ports: effectsPorts(contract),
    idempotent: contract['idempotent'] === true,
  }))
  return {
    ok: true,
    graph_present: true,
    graph: {
      node_count: ids.length,
      edge_count: graphEdges(model.graph).length,
      sink: graphSink(model.graph),
      derived_from: graphDerivedFrom(model.graph),
    },
    scopes,
    contracts,
    thresholds: model.thresholds,
  }
}

/** `orchestration.read`：读某条目全文（契约 / Scope / 图 / 阈值 / 证据）+ 关联证据摘要。 */
export function readTool(bag: Rec): Json {
  const kind = typeof bag['kind'] === 'string' ? bag['kind'] : ''
  const target = typeof bag['target'] === 'string' ? bag['target'] : ''
  const model = readGraphModel(bag['graph'])
  if (model === null) return { ok: false, error: { code: 'graph_missing', message: '缺图数据（bag.graph）' } }

  if (kind === 'graph') {
    return { ok: true, kind, target, entry: model.graph, related_evidence: [] }
  }
  if (kind === 'thresholds') {
    const thresholds = model.thresholds
    const entry = target.length === 0 ? thresholds : { [target]: thresholds[target] ?? null }
    return { ok: true, kind, target, entry, related_evidence: [] }
  }
  if (kind === 'contract') {
    const entry = model.contracts.find((contract) => contractId(contract) === target) ?? null
    if (entry === null) return { ok: false, error: { code: 'not_found', message: `contract ${target}` } }
    return { ok: true, kind, target, entry, related_evidence: relatedEvidence(bag, target) }
  }
  if (kind === 'scope') {
    const entry = model.nodes.find((node) => nodeId(node) === target) ?? null
    if (entry === null) return { ok: false, error: { code: 'not_found', message: `scope ${target}` } }
    return { ok: true, kind, target, entry, related_evidence: [] }
  }
  if (kind === 'evidence') {
    const entry = ledgerEntries(bag, 'evidence').find((item) => item['id'] === target) ?? null
    if (entry === null) return { ok: false, error: { code: 'not_found', message: `evidence ${target}` } }
    return { ok: true, kind, target, entry, related_evidence: [] }
  }
  return { ok: false, error: { code: 'bad_kind', message: `unknown kind ${kind}` } }
}
