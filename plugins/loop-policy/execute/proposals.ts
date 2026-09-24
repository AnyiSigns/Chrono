// 提案扫描与采纳（§14）：读 #43 `proposals` 未决项 → 本地机械闸 → `port.call #44 shadow` →
// `approval.wait` 产 `orchestration_change` 入 #32 → `approved` 按 `patch.writes[]` 展开 `add_gen`/`set_active` 计划；
// `denied` 落 verdicts。**只消费提案**；用户驱动提案（#45 record → propose）由此进入采纳，不再停在台账。

import { validateGraphData } from './gate.ts'
import { addGenOp, addGenRefOp, baseSeqOf, batchDirective, defHashOf, isRecord, putOp } from './plan.ts'
import type { CallEnv, GraphModel, Json, PortCaller, Rec, ServiceEvent } from './types.ts'

const MAX_CHAIN = 10000

/** #43 台账 body（接受 `{body}` 包装或 body 本身）；缺失回落四条空链。 */
export function evolutionBody(bag: Rec): Rec {
  const evolution = bag['evolution']
  if (isRecord(evolution)) {
    if (isRecord(evolution['body'])) return evolution['body'] as Rec
    if (isRecord(evolution['proposals']) || typeof evolution['version'] === 'number') {
      // 入口切片把 refs 闭包并进同一层（见 chat `ledgerSliceOf`）。body 是要**落账**的，
      // 必须剔除 refs / data_gen：否则每回合把整份闭包或投影元数据写回 evolution body。
      const body: Rec = { ...evolution }
      delete body['refs']
      delete body['data_gen']
      return body
    }
  }
  return {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: null, count: 0 },
    verdicts: { tail: null, count: 0 },
  }
}

/** 台账引用闭包：`bag.evolution.refs` 优先，其次 `bag.refs`。 */
export function ledgerRefs(bag: Rec): Rec {
  const evolution = bag['evolution']
  if (isRecord(evolution) && isRecord(evolution['refs'])) return evolution['refs'] as Rec
  if (isRecord(bag['refs'])) return bag['refs'] as Rec
  return {}
}

function slotCount(body: Rec, kind: string): number {
  const slot = body[kind]
  if (!isRecord(slot)) return 0
  const count = slot['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
}

/** 沿 `prev` 从某类 tail 回溯，返回 newest→oldest 条目。 */
export function ledgerEntries(bag: Rec, kind: string): Rec[] {
  const body = evolutionBody(bag)
  const refs = ledgerRefs(bag)
  const slot = body[kind]
  if (Array.isArray(slot)) return slot.filter(isRecord)
  if (!isRecord(slot)) return []
  const out: Rec[] = []
  let hash = defHashOf(slot['tail'])
  let guard = 0
  while (hash !== null && guard < MAX_CHAIN) {
    guard += 1
    const entry = refs[hash]
    if (!isRecord(entry)) break
    out.push(entry)
    hash = defHashOf(entry['prev'])
  }
  return out
}

/** 已裁决的 proposal_id 集合（verdict 引用）。 */
function decidedIds(bag: Rec): Set<string> {
  const decided = new Set<string>()
  for (const verdict of ledgerEntries(bag, 'verdicts')) {
    const ids = verdict['proposal_ids']
    if (!Array.isArray(ids)) continue
    for (const id of ids) if (typeof id === 'string') decided.add(id)
  }
  return decided
}

/** 候选图：`patch.graph.def` / `patch.def` 经 refs 解析。 */
export function candidateGraph(proposal: Rec, refs: Rec): Rec | null {
  const patch = isRecord(proposal['patch']) ? (proposal['patch'] as Rec) : null
  if (patch === null) return null
  const graphRef = isRecord(patch['graph']) ? patch['graph'] : patch
  const hash = defHashOf(graphRef)
  if (hash !== null && isRecord(refs[hash])) return refs[hash]
  if (isRecord(graphRef) && Array.isArray(graphRef['nodes'])) return graphRef
  return null
}

function stringList(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export interface ProposalScanInput {
  bag: Rec
  env: CallEnv
  model: GraphModel
  pins: Rec
  port: PortCaller
  run: string | null
  workspaceId: string | null
  at: string
}

export interface ProposalScanResult {
  directives: Json[]
  pending: Rec | null
  events: ServiceEvent[]
}

/** 未决提案（newest→oldest，去掉已裁决者）。 */
export function undecidedProposals(bag: Rec): Rec[] {
  const decided = decidedIds(bag)
  return ledgerEntries(bag, 'proposals').filter((proposal) => {
    const id = proposal['id']
    return typeof id === 'string' && !decided.has(id)
  })
}

interface GateResult {
  ok: boolean
  errors: Rec[]
  shadow: Rec | null
  /** #44 `shadow` 返回的落账计划（含 `put(metric_def)`）：必须并入回合计划，否则 `verdicts.gate.shadow` 指向的 def 是孤儿。 */
  shadowDirectives: Json[]
}

/** 一条提案的机械闸 + 影子回放；返回是否可入人闸、影子指标 def 引用与其落账计划。 */
async function gateProposal(input: ProposalScanInput, proposal: Rec): Promise<GateResult> {
  const refs = ledgerRefs(input.bag)
  const graph = candidateGraph(proposal, refs)
  if (graph === null) {
    return {
      ok: false,
      errors: [{ code: 'graph_missing', path: 'patch.graph', message: '提案候选图不可解析' }],
      shadow: null,
      shadowDirectives: [],
    }
  }
  const wrapper: Rec = {
    contracts: isRecord(input.bag['graph']) ? (input.bag['graph'] as Rec)['contracts'] : null,
    nodes: isRecord(input.bag['graph']) ? (input.bag['graph'] as Rec)['nodes'] : null,
    prompts: isRecord(input.bag['graph']) ? (input.bag['graph'] as Rec)['prompts'] : null,
    graph,
    thresholds: input.model.thresholds,
    refusal_codes: input.model.refusalCodes,
  }
  const active = input.model.graph
  const runs = typeof input.bag['runs_since_fork'] === 'number' ? (input.bag['runs_since_fork'] as number) : null
  const gate = validateGraphData({ graph: wrapper, pins: input.pins, active_graph: active, runs_since_fork: runs, refs })
  const errors = gate.errors as unknown as Rec[]
  if (!gate.ok) return { ok: false, errors, shadow: null, shadowDirectives: [] }

  const outcome = await input.port.call('evolve-metrics', 'shadow', {
    graph: wrapper,
    expected_effs: null,
    thresholds: input.model.thresholds,
    now: input.env.now,
  })
  let shadow: Rec | null = null
  const shadowDirectives: Json[] = []
  if (outcome.ok && isRecord(outcome.value)) {
    const metricId = outcome.value['metric_id']
    shadow = typeof metricId === 'string' ? { def: metricId } : null
    // #44 `shadow` 的指标 def 键 = H({body:metric_def})；其返回的 put 计划必须落账，影子指标才可解析。
    const returned = outcome.value['$directives']
    if (Array.isArray(returned)) for (const directive of returned as Json[]) shadowDirectives.push(directive)
  }
  return { ok: true, errors, shadow, shadowDirectives }
}

/** 构造 verdict 条目 + 台账写计划（含 evidence_ids / proposal_ids / gate / result）。 */
function verdictPlan(
  bag: Rec,
  entry: Rec,
  at: string,
): { ops: Json[]; bodyIndex: number } {
  const body = evolutionBody(bag)
  const count = slotCount(body, 'verdicts')
  const ops: Json[] = [putOp(entry)]
  const index = ops.length
  const newVerdicts: Rec = { tail: { def: { $n: 0 } }, count: count + 1 }
  const base = baseSeqOf(bag['evolution'])
  if (base === null) {
    ops.push(putOp({ ...body, version: 1, verdicts: newVerdicts }))
  } else {
    // 补丁世代：只替换 verdicts 槽（version 非 1 时补一条），不重写整份台账 body
    const patches: Json[] = []
    if (body['version'] !== 1) patches.push({ op: 'replace', path: ['version'], value: 1 })
    patches.push({ op: 'replace', path: ['verdicts'], value: newVerdicts })
    ops.push(putOp({ ops: patches }))
  }
  ops.push(addGenOp('evolution', index, {}, base ?? undefined))
  void at
  return { ops, bodyIndex: index }
}

function makeVerdict(proposalIds: string[], evidenceIds: string[], result: string, gate: Rec, at: string, id: string): Rec {
  return {
    kind: 'verdict',
    id,
    proposal_ids: proposalIds,
    evidence_ids: evidenceIds,
    result,
    gate,
    adopted_gen: null,
    at,
    prev: null,
  }
}

/**
 * 扫描未决提案：机械闸不过 → 落拒绝 verdict；通过 → 入 `orchestration_change` 人闸并**结束本 run**。
 * 一次最多入一条人闸（整批裁决单位是候选版本）。
 */
export async function scanProposals(input: ProposalScanInput): Promise<ProposalScanResult> {
  const directives: Json[] = []
  const events: ServiceEvent[] = []
  const proposals = undecidedProposals(input.bag)
  for (const proposal of proposals) {
    const id = typeof proposal['id'] === 'string' ? proposal['id'] : 'pr-?'
    const evidenceIds = stringList(proposal['evidence_ids'])
    const gated = await gateProposal(input, proposal)
    // 影子指标 def 先落账（先于引用它的队列项 / verdict），否则 `gate.shadow={def:metric_id}` 解析不到。
    for (const directive of gated.shadowDirectives) directives.push(directive)
    if (!gated.ok) {
      const verdict = makeVerdict([id], evidenceIds, 'rejected', { mechanical: 'fail', reason: gated.errors[0]?.['code'] ?? null, shadow: null, human: null }, input.at, `vd-${input.run ?? 'run'}-${id}`)
      const plan = verdictPlan(input.bag, verdict, input.at)
      directives.push(batchDirective(plan.ops))
      continue
    }
    const outcome = await input.port.call('approval', 'enqueue', {
      kind: 'orchestration_change',
      queue: isRecord(input.bag['approval']) ? (input.bag['approval'] as Rec)['queue'] : null,
      refs: isRecord(input.bag['approval']) ? (input.bag['approval'] as Rec)['refs'] : {},
      cursor: { kind: 'orchestration_change', proposal_ids: [id] },
      thread: input.env.thread,
      run: input.run,
      tier: input.bag['tier'] ?? null,
      workspace_id: input.workspaceId,
      shadow: gated.shadow,
      args_ref: { summary: `orchestration_change ${id}` },
      port: 'orchestration-admin',
    })
    if (outcome.ok) {
      const value = outcome.value
      if (isRecord(value) && Array.isArray(value['$directives'])) {
        for (const directive of value['$directives'] as Json[]) directives.push(directive)
      }
      events.push({ topic: 'orchestration.change_pending', payload: { run: input.run, thread: input.env.thread, proposal_id: id } })
      return { directives, pending: { kind: 'orchestration_change', proposal_ids: [id] }, events }
    }
    // enqueue 传输失败：不吞，落拒绝 verdict 以便可审计。
    const verdict = makeVerdict([id], evidenceIds, 'rejected', { mechanical: 'pass', reason: 'approval_unavailable', shadow: gated.shadow, human: null }, input.at, `vd-${input.run ?? 'run'}-${id}`)
    const plan = verdictPlan(input.bag, verdict, input.at)
    directives.push(batchDirective(plan.ops))
  }
  return { directives, pending: null, events }
}

/** 采纳：按 `patch.writes[]` 展开 `add_gen`（图 + 跨身份写），并落 accepted verdict。 */
export function expandAdoption(bag: Rec, proposal: Rec, pins: Rec, at: string, run: string | null): Json[] {
  const refs = ledgerRefs(bag)
  const graph = candidateGraph(proposal, refs)
  const patch = isRecord(proposal['patch']) ? (proposal['patch'] as Rec) : {}
  const graphHash = defHashOf(patch['graph']) ?? defHashOf(patch)
  const ops: Json[] = []
  if (graph !== null && graphHash !== null) {
    // 图 def 已在世界（propose 已 put）；采纳 = 对 loop-policy 自身数据世代 add_gen。
    ops.push(addGenRefOp('loop-policy', graphHash, pins))
  }
  const writes = Array.isArray(patch['writes']) ? (patch['writes'] as Json[]) : []
  for (const write of writes) {
    if (!isRecord(write)) continue
    const identity = write['identity']
    const payload = write['payload']
    const hash = defHashOf(payload)
    if (typeof identity === 'string' && identity.length > 0 && hash !== null) {
      ops.push(addGenRefOp(identity, hash, {}))
    }
  }
  const id = typeof proposal['id'] === 'string' ? proposal['id'] : 'pr-?'
  const evidenceIds = stringList(proposal['evidence_ids'])
  const verdict = makeVerdict([id], evidenceIds, 'accepted', { mechanical: 'pass', reason: null, shadow: null, human: 'approved' }, at, `vd-${run ?? 'run'}-${id}`)
  const plan = verdictPlan(bag, verdict, at)
  for (const op of plan.ops) ops.push(op)
  return [batchDirective(ops)]
}

/** 拒绝：落 rejected verdict。 */
export function expandRejection(bag: Rec, proposalIds: string[], at: string, run: string | null, reason: string): Json[] {
  const evidenceIds: string[] = []
  const byId = new Map<string, Rec>()
  for (const proposal of ledgerEntries(bag, 'proposals')) {
    const id = proposal['id']
    if (typeof id === 'string') byId.set(id, proposal)
  }
  for (const id of proposalIds) {
    const proposal = byId.get(id)
    if (proposal !== undefined) evidenceIds.push(...stringList(proposal['evidence_ids']))
  }
  const verdict = makeVerdict(proposalIds, evidenceIds, 'rejected', { mechanical: 'pass', reason, shadow: null, human: 'denied' }, at, `vd-${run ?? 'run'}-${proposalIds[0] ?? '?'}`)
  const plan = verdictPlan(bag, verdict, at)
  return [batchDirective(plan.ops)]
}
