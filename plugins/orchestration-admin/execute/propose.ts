// `orchestration.propose`：构造提案条目写计划。**只产提案、不产证据、不产写**。
// 四条硬约束（写期机械校验，不满足直接拒）：evidence_ids 必填非空 / fork-only 带 derived_from /
// 携带上次 validate 的结果哈希 / 额度受 #33 thresholds（用户显式请求不占额度）。
// 计划顺序：put(候选图 def) + put(writes[].payload def) → put(提案) + put(新 evolution body) + add_gen(evolution)。
// 跨身份 writes[] 形状按 DESIGN「跨身份采纳」：采纳阶段才由 #33 展开 add_gen(<identity>)，本插件不执行。

import { resolveLimits } from './config.ts'
import { validateBag } from './gate.ts'
import { H, canonicalJson } from './hash.ts'
import { asArray, asStringArray, graphDerivedFrom, graphNodes, readGraphModel } from './model.ts'
import { isRecord, planOf, putOp } from './plan.ts'
import { BadArgsError, ToolError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

const LIMITS = resolveLimits()

function requireString(source: Rec, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) throw new BadArgsError(`${key} required`)
  return value
}

/** 读 #43 台账 body（接受 `{body}` 包装或 body 本身）；缺失回落四条空链。 */
function evolutionBody(bag: Rec): Rec {
  const evolution = bag['evolution']
  if (isRecord(evolution)) {
    if (isRecord(evolution['body'])) return evolution['body'] as Rec
    if (isRecord(evolution['proposals']) || typeof evolution['version'] === 'number') return evolution
  }
  return {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: null, count: 0 },
    verdicts: { tail: null, count: 0 },
  }
}

function proposalsSlot(bag: Rec): Rec {
  const body = evolutionBody(bag)
  return isRecord(body['proposals']) ? (body['proposals'] as Rec) : {}
}

function proposalsTail(bag: Rec): Rec | null {
  const tail = proposalsSlot(bag)['tail']
  return isRecord(tail) && typeof tail['def'] === 'string' ? { def: tail['def'] } : null
}

function proposalsCount(bag: Rec): number {
  const count = proposalsSlot(bag)['count']
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0
}

function isoOf(now: number): string {
  return new Date(now).toISOString()
}

/** 提案 id 确定性生成（run + 序号）。 */
function proposalId(bag: Rec, env: CallEnv): string {
  const run = typeof bag['run'] === 'string' && bag['run'].length > 0 ? bag['run'] : env.run ?? 'run'
  return `pr-${run}-${proposalsCount(bag) + 1}`
}

function nowOfBag(bag: Rec, env: CallEnv): number {
  if (typeof bag['now'] === 'number' && Number.isFinite(bag['now'])) return bag['now']
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}

/** 构建跨身份 writes[]：payload def 先落，patch 里记 `{identity, payload:{def}}`。 */
function buildWrites(ops: Json[], raw: Json | undefined): Json[] {
  const out: Json[] = []
  for (const item of asArray(raw)) {
    if (!isRecord(item) || typeof item['identity'] !== 'string' || item['identity'].length === 0) {
      throw new ToolError('bad_write', 'writes[].identity required')
    }
    if (item['payload'] === undefined) throw new ToolError('bad_write', 'writes[].payload required')
    const payload = item['payload'] as Json
    ops.push(putOp(payload))
    out.push({ identity: item['identity'], payload: { def: H({ body: payload }) } })
  }
  return out
}

/**
 * `orchestration.propose`：产提案条目写计划。
 * 输入（bag）：`graph`（六类条目，`graph.graph` = 候选图）、`active_graph`、`pins`、`evolution`、
 * `runs_since_fork`、`class`、`evidence_ids`、`writes?`、`target?`、`by?`、`validate_hash`、`now` / `run`。
 */
export function proposeTool(bag: Rec, env: CallEnv): Json {
  const changeClass = requireString(bag, 'class')
  if (!LIMITS.allowedClasses.includes(changeClass)) {
    throw new ToolError('bad_change_class', changeClass)
  }

  const evidenceIds = asStringArray(bag['evidence_ids'])
  if (evidenceIds.length === 0) throw new ToolError('evidence_required', 'evidence_ids 必填且非空')

  const model = readGraphModel(bag['graph'])
  if (model === null) throw new ToolError('graph_missing', 'bag.graph')
  const candidate = model.graph
  if (graphNodes(candidate).length === 0) throw new ToolError('fork_required', '禁空白整图')
  if (graphDerivedFrom(candidate) === null) {
    throw new ToolError('fork_required', '新图必须带 derived_from')
  }

  const carried = bag['validate_hash']
  const result = validateBag(bag)
  if (typeof carried !== 'string' || carried !== result.result_hash) {
    throw new ToolError('validate_required', '必须携带同一 bag 的上次 validate 结果哈希')
  }
  if (!result.ok) {
    throw new ToolError('invalid_graph', result.errors[0]?.code ?? 'mechanical_gate')
  }

  const by = bag['by'] === 'user' ? 'user' : 'evolve-loop'
  if (by !== 'user') {
    // 额度（提案条数）：diff 上限是 validate 的演化规则 2（机械闸），已由上面的 validate 前置强制。
    const runCount = typeof bag['run_proposal_count'] === 'number' ? bag['run_proposal_count'] : 0
    if (runCount + 1 > LIMITS.maxProposalsPerRun) {
      throw new ToolError('quota_exceeded', `max_proposals_per_run=${LIMITS.maxProposalsPerRun}`)
    }
  }

  const graphHash = H({ body: candidate })
  const ops: Json[] = [putOp(candidate)]
  const writes = buildWrites(ops, bag['writes'])

  const activeGraph = isRecord(bag['active_graph']) ? bag['active_graph'] : null
  // active_graph 是 active 图的 def body（非整份 def 条目）：def 键口径 = H({body})，与 patch.def / 投影 markerHash 一致。
  const activeHash = activeGraph !== null ? H({ body: activeGraph }) : null
  const target = isRecord(bag['target'])
    ? bag['target']
    : { graph: activeHash === null ? null : { def: activeHash }, contract_id: null, node_id: null }

  const proposal: Rec = {
    kind: 'proposal',
    id: proposalId(bag, env),
    class: changeClass,
    evidence_ids: evidenceIds,
    target,
    patch: { def: graphHash, graph: { def: graphHash }, writes },
    by,
    at: isoOf(nowOfBag(bag, env)),
    prev: proposalsTail(bag),
  }
  if (Buffer.byteLength(canonicalJson(proposal), 'utf8') > LIMITS.maxProposalBytes) {
    throw new ToolError('proposal_too_large', `> ${LIMITS.maxProposalBytes} bytes`)
  }

  ops.push(putOp(proposal))
  const proposalHash = H({ body: proposal })

  const body = evolutionBody(bag)
  const newBody: Rec = {
    ...body,
    version: typeof body['version'] === 'number' ? body['version'] : 1,
    proposals: { tail: { def: proposalHash }, count: proposalsCount(bag) + 1 },
  }
  const bodyIndex = ops.length
  ops.push(putOp(newBody))
  ops.push({
    op: 'add_gen',
    args: { id: 'evolution', payload: { $n: bodyIndex }, sig: { $n: bodyIndex }, pins: {} },
  })

  return planOf(ops, {
    ok: true,
    proposal_id: proposal.id,
    class: changeClass,
    by,
    graph: graphHash,
    proposal: proposalHash,
    validate_hash: result.result_hash,
    writes: writes.length,
  })
}
