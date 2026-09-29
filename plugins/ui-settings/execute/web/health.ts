// 编排视图纯函数（node 下可 import 单测）。
// 健康判定已下沉到本插件 execute 服务（`orchestration.health`）：本模块只把服务的结构化结果
// 归一给渲染层，不再自行计数 / 比阈值；图与 Scope 名录仍走投影尾链读取。

import { isRecord, joinMeta } from './config-model.ts'

export const HEALTH_OK = 'ok'
export const HEALTH_WARNING = 'warning'
export const HEALTH_UNHEALTHY = 'unhealthy'

/** 台账列表一次最多遍历的条目数（防病态长链）。 */
const LEDGER_LIMIT = 200

/** 取一条 `{"def":hash}` 标记指向的条目体；无标记 / 缺失 → null。 */
function refEntry(projection: any, marker: any): any {
  if (!isRecord(projection) || !isRecord(projection.refs)) return null
  if (!isRecord(marker) || typeof marker.def !== 'string') return null
  const entry = projection.refs[marker.def]
  return isRecord(entry) ? entry : null
}

/** 从尾链头沿 `prev` 逆序收集条目（含尾），最多 limit 条；防环（visited 去重）。 */
export function walkTail(projection: any, listKey: string, limit = LEDGER_LIMIT): any[] {
  if (!isRecord(projection) || !isRecord(projection.body)) return []
  const list = projection.body[listKey]
  if (!isRecord(list) || !isRecord(list.tail)) return []
  const entries: any[] = []
  const visited = new Set<string>()
  let marker: any = list.tail
  while (isRecord(marker) && typeof marker.def === 'string' && entries.length < limit) {
    if (visited.has(marker.def)) break
    visited.add(marker.def)
    const entry = refEntry(projection, marker)
    if (entry === null) break
    entries.push(entry)
    marker = isRecord(entry.prev) ? entry.prev : null
  }
  return entries
}

/**
 * 归一 `orchestration.health` 服务结果：`{ok,status,consecutive_refused,threshold,
 * threshold_source,refusal_codes,rollback,ledger}`。缺字段 / 非法值防御性回落，不抛错。
 * `ledger` 为服务侧走完的三条 tail（`verdicts` / `proposals` / `evidence`）。
 */
export function healthView(result: any): any {
  const record = isRecord(result) ? result : null
  const rawStatus = record === null ? null : record.status
  const status =
    rawStatus === HEALTH_UNHEALTHY || rawStatus === HEALTH_WARNING ? rawStatus : HEALTH_OK
  const codes: any[] = []
  if (record !== null && Array.isArray(record.refusal_codes)) {
    for (const item of record.refusal_codes) {
      if (!isRecord(item) || typeof item.code !== 'string') continue
      codes.push({ code: item.code, count: Number.isInteger(item.count) ? item.count : 0 })
    }
  }
  const rollback =
    record !== null && isRecord(record.rollback) && typeof record.rollback.payload === 'string'
      ? {
          payload: record.rollback.payload,
          seq: Number.isInteger(record.rollback.seq) ? record.rollback.seq : null,
        }
      : null
  const ledgerSource = record !== null && isRecord(record.ledger) ? record.ledger : null
  return {
    present: record !== null,
    status,
    consecutive: record !== null && Number.isInteger(record.consecutive_refused) ? record.consecutive_refused : 0,
    threshold: record !== null && Number.isInteger(record.threshold) && record.threshold > 0 ? record.threshold : null,
    thresholdSource: record !== null && record.threshold_source === 'loop-policy' ? 'loop-policy' : 'default',
    codes,
    rollback,
    ledger: ledgerSource === null ? { verdicts: [], proposals: [], evidence: [] } : ledgerLists(ledgerSource),
  }
}

/**
 * 三条台账 tail 倒序列表（verdicts / proposals / evidence，采纳与拒绝都显示）。
 * 两种来源：服务侧已走好的 `{verdicts,proposals,evidence}` 数组，或进化投影（`body` + `refs`，本模块自行走 tail）。
 */
export function ledgerLists(source: any): any {
  if (!isRecord(source)) return { verdicts: [], proposals: [], evidence: [] }
  if (Array.isArray(source.verdicts) || Array.isArray(source.proposals) || Array.isArray(source.evidence)) {
    return {
      verdicts: Array.isArray(source.verdicts) ? source.verdicts : [],
      proposals: Array.isArray(source.proposals) ? source.proposals : [],
      evidence: Array.isArray(source.evidence) ? source.evidence : [],
    }
  }
  return {
    verdicts: walkTail(source, 'verdicts'),
    proposals: walkTail(source, 'proposals'),
    evidence: walkTail(source, 'evidence'),
  }
}

/** 台账条目摘要（人读一行）：判定显 `proposal_id` + `evidence_id` 供逐级下钻。 */
export function ledgerSummary(kind: string, entry: any): any {
  if (!isRecord(entry)) return { id: '', label: '', detail: '' }
  const id = typeof entry.id === 'string' ? entry.id : ''
  const idsOf = (value: any) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [])
  if (kind === 'verdicts') {
    const result = typeof entry.result === 'string' ? entry.result : ''
    const proposals = idsOf(entry.proposal_ids)
    const evidence = idsOf(entry.evidence_ids)
    const detail = [
      proposals.length > 0 ? `proposal ${proposals.join(', ')}` : '',
      evidence.length > 0 ? `evidence ${evidence.join(', ')}` : '',
    ].filter((part) => part.length > 0).join(' · ')
    return { id, label: result, detail }
  }
  if (kind === 'proposals') {
    const label = typeof entry.class === 'string' ? entry.class : ''
    const evidence = idsOf(entry.evidence_ids)
    return { id, label, detail: evidence.length > 0 ? `evidence ${evidence.join(', ')}` : '' }
  }
  const label = typeof entry.class === 'string' ? entry.class : ''
  const cluster = isRecord(entry.cluster_key) && typeof entry.cluster_key.code === 'string' ? entry.cluster_key.code : ''
  const traces = idsOf(entry.traces?.map?.((item: any) => (isRecord(item) ? item.def : null)))
  const detail = [
    cluster,
    Number.isInteger(entry.n) ? `n ${entry.n}` : '',
    traces.length > 0 ? `trace ${traces.join(', ')}` : '',
  ].filter((part) => typeof part === 'string' && part.length > 0).join(' · ')
  return { id, label, detail }
}

/** 短哈希（世代 / 图 def 的人读展示）。 */
export function shortHash(hash: any): string {
  if (typeof hash !== 'string' || hash.length === 0) return ''
  return hash.slice(0, 8)
}

/** `{"def":hash}` 标记 → 哈希（非空串即认，与 `refEntry` 同口径）；无标记回 null。 */
function defHash(marker: any): string | null {
  return isRecord(marker) && typeof marker.def === 'string' && marker.def.length > 0 ? marker.def : null
}

/**
 * 条目容器 → 条目数组：已解析数组直接用；链式 `{tail,count}` 经 `refs`（`{hash:body}` 闭包）
 * 沿 `prev` 从尾回溯（防环、限长）。缺 `refs` / 坏引用即停在已取到的部分。
 */
function entryList(container: any, refs: any, limit = LEDGER_LIMIT): any[] {
  if (Array.isArray(container)) return container.filter(isRecord)
  if (!isRecord(container) || !isRecord(refs)) return []
  const entries: any[] = []
  const visited = new Set<string>()
  let marker: any = container.tail
  while (entries.length < limit) {
    const hash = defHash(marker)
    if (hash === null || visited.has(hash)) break
    visited.add(hash)
    const entry = refs[hash]
    if (!isRecord(entry)) break
    entries.push(entry)
    marker = isRecord(entry.prev) ? entry.prev : null
  }
  return entries
}

/** 图单值：内联 `{nodes:[…]}` 直接用；`{def:hash}` 经 `refs` 解析；不可用回 null（fail-closed）。 */
function resolveGraph(body: any, refs: any): any {
  const slot = isRecord(body) ? body.graph : null
  if (isRecord(slot) && Array.isArray(slot.nodes)) return slot
  const hash = defHash(slot)
  if (hash !== null && isRecord(refs) && isRecord(refs[hash])) return refs[hash]
  return null
}

/** 边端点 `[node_index, port]`；形态非法回 null。 */
function edgeEndpoint(value: any): [number, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [index, port] = value
  if (!Number.isInteger(index) || typeof port !== 'string') return null
  return [index, port]
}

/**
 * 图视图：`loop-policy` 身份投影的图（`graph` 单值：内联或 `{def}` 经 `refs`）→ 节点 / 边列表。
 * 节点 = `graph.nodes`（contract_id 生成序），实现信息取自 `body.nodes` 的 Scope 实例（按 contract_id 首个匹配）；
 * 边 = `graph.edges`（端点 `[node_index, port]`）。任何缺失 / 畸形形状都回空骨架，不抛。
 */
export function graphView(projection: any): any {
  const skeleton = { contractId: null, nodes: [], edges: [] }
  if (!isRecord(projection) || !isRecord(projection.body)) return skeleton
  const body = projection.body
  const refs = isRecord(projection.refs) ? projection.refs : {}
  const graph = resolveGraph(body, refs)
  if (graph === null) return skeleton
  const instances = entryList(body.nodes, refs)
  const byContract = new Map<string, any>()
  for (const instance of instances) {
    const id = typeof instance.contract_id === 'string' ? instance.contract_id : null
    if (id !== null && !byContract.has(id)) byContract.set(id, instance)
  }
  const contractIds = Array.isArray(graph.nodes) ? graph.nodes : []
  const nodes = contractIds.map((value: any, index: number) => {
    const contract_id = typeof value === 'string' ? value : ''
    const instance = byContract.get(contract_id)
    return {
      index,
      contract_id,
      node_id: isRecord(instance) && typeof instance.node_id === 'string' ? instance.node_id : '',
      impl: isRecord(instance) && typeof instance.impl === 'string' ? instance.impl : '',
    }
  })
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : []
  const edges = rawEdges.map((edge: any) => ({
    from: edgeEndpoint(isRecord(edge) ? edge.from : null),
    to: edgeEndpoint(isRecord(edge) ? edge.to : null),
    when: isRecord(edge) && typeof edge.when === 'string' ? edge.when : '',
  }))
  return { contractId: defHash(body.graph), nodes, edges }
}

/** 图节点副行（实例名 · 实现）；缺失片段由 joinMeta 过滤。 */
export function graphNodeMeta(node: any): string {
  if (!isRecord(node)) return ''
  return joinMeta([node.node_id, node.impl])
}

/** 边端点展示 `#<index>:<port>`；缺失 / 畸形回 `-`。 */
export function edgeEndpointLabel(endpoint: any): string {
  if (!Array.isArray(endpoint) || endpoint.length !== 2) return '-'
  return `#${endpoint[0]}:${endpoint[1]}`
}

/** 一条边的端点行 `#u:out -> #v:in`。 */
export function graphEdgeMeta(edge: any): string {
  if (!isRecord(edge)) return '- -> -'
  return `${edgeEndpointLabel(edge.from)} -> ${edgeEndpointLabel(edge.to)}`
}

/** 关联摘要：数组 / 映射 → 人读一行；缺失 → 空串。 */
function linksSummary(links: any): string {
  if (Array.isArray(links)) {
    const names = links
      .map((item) => (isRecord(item) ? (typeof item.id === 'string' ? item.id : item.name) : item))
      .filter((item) => typeof item === 'string' && item.length > 0)
    return names.length > 0 ? names.join(', ') : `${links.length}`
  }
  if (isRecord(links)) {
    const keys = Object.keys(links)
    return keys.length > 0 ? keys.join(', ') : ''
  }
  return ''
}

/** 作用域展示值：字符串原样（`global` 即全局）；对象取工作区名，其次 `kind`。 */
export function scopeLabel(scope: any): string {
  if (isRecord(scope)) {
    if (typeof scope.workspace_id === 'string' && scope.workspace_id.length > 0) return scope.workspace_id
    if (typeof scope.kind === 'string' && scope.kind.length > 0) return scope.kind
    return 'global'
  }
  if (typeof scope === 'string' && scope.length > 0) return scope
  return 'global'
}

/**
 * Scope 名录：智能体身份 body 的 `instances` 尾链（经 `refs` 沿 `prev` 逆序走）。
 * 条目字段 `{id, name, system_prompt, scope, prev}`；autonomy / links / success_rate 缺失时留空。
 */
export function scopeList(projection: any): any[] {
  return walkTail(projection, 'instances').map((record, index) => {
    const id = typeof record.id === 'string' ? record.id : String(index)
    return {
      index,
      id,
      contract_id: typeof record.contract_id === 'string' ? record.contract_id : id,
      persona: typeof record.name === 'string' ? record.name : '',
      scope: scopeLabel(record.scope),
      autonomy: typeof record.autonomy === 'string' ? record.autonomy : '',
      links: linksSummary(record.links),
      success_rate: typeof record.success_rate === 'number' ? record.success_rate : null,
    }
  })
}

/** 图 meta 行（合约短哈希 / 节点数 / 边数）；组件只渲染。 */
export function graphMeta(view: any, t: (code: string, vars?: any) => string): string {
  return joinMeta([
    view.contractId !== null ? `${t('settings_orch_contract')} ${shortHash(view.contractId)}` : '',
    `${t('settings_orch_nodes')} ${view.nodes.length}`,
    `${t('settings_orch_edges')} ${view.edges.length}`,
  ])
}

/** Scope meta 行（合约 / 人格 / 作用域 / 自治 / 关联 / 成功率）。 */
export function scopeMeta(scope: any, t: (code: string, vars?: any) => string): string {
  return joinMeta([
    `${t('settings_orch_contract')} ${shortHash(scope.contract_id)}`,
    `${t('settings_orch_persona')} ${scope.persona.length > 0 ? scope.persona : '-'}`,
    `${t('settings_orch_scope')} ${scope.scope === 'global' ? t('settings_orch_scope_global') : scope.scope}`,
    `${t('settings_orch_autonomy')} ${scope.autonomy.length > 0 ? scope.autonomy : '-'}`,
    scope.links.length > 0 ? `${t('settings_orch_links')} ${scope.links}` : '',
    `${t('settings_orch_success')} ${scope.success_rate === null ? '-' : `${Math.round(scope.success_rate * 100)}%`}`,
  ])
}

/** 台账条目主行（`id · label`）。 */
export function ledgerTitle(summary: any): string {
  return `${summary.id} · ${summary.label}`
}

/** 台账逐级下钻明细（判定 → proposal / evidence → trace）；无内容回 `-`。 */
export function ledgerDetailText(kind: string, entry: any): string {
  const rows: string[] = []
  const push = (label: string, values: any) => {
    if (!Array.isArray(values) || values.length === 0) return
    rows.push(`${label} ${values.join(', ')}`)
  }
  if (kind === 'verdicts') {
    push('proposal', entry.proposal_ids)
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.gate)) {
      const gate = [entry.gate.mechanical, entry.gate.reason, entry.gate.human].filter(
        (part) => typeof part === 'string' && part.length > 0,
      )
      if (gate.length > 0) rows.push(`gate ${gate.join(' · ')}`)
    }
    if (Number.isInteger(entry.adopted_gen)) rows.push(`gen ${entry.adopted_gen}`)
  } else if (kind === 'proposals') {
    push('evidence', entry.evidence_ids)
    if (isRecord(entry.patch) && typeof entry.patch.def === 'string') rows.push(`patch ${entry.patch.def}`)
  } else {
    push('trace', Array.isArray(entry.traces) ? entry.traces.map((item: any) => (isRecord(item) ? item.def : null)) : [])
    if (isRecord(entry.cluster_key) && typeof entry.cluster_key.attributable_to === 'string') {
      rows.push(`attributable_to ${entry.cluster_key.attributable_to}`)
    }
  }
  if (typeof entry.at === 'string' && entry.at.length > 0) rows.push(entry.at)
  return rows.length > 0 ? rows.join(' · ') : '-'
}
