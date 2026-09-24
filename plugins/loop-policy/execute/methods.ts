// 能力类 `loop-policy` 的唯一方法 `interpret`：入口 #14 入口 term eff 本方法（bag 装配归 #14）。
// 服务自驱：读图数据 → 解释器顺序推进 → 回合尾写 trace / 队列项 / 提案扫描 → 返回计划交 #14 合并上提。
// 服务不读投影、不写链、不自取时钟（now 取 env）；同输入同输出（LLM 项除外，eff_log 回灌配对下等价）。

import { interpretGraph } from './interpreter.ts'
import { evolutionBody, expandAdoption, expandRejection, ledgerEntries, scanProposals } from './proposals.ts'
import { H } from './hash.ts'
import { asString, baseSeqOf, isRecord, isoAt, nowOf, planOf, RoundPatches } from './plan.ts'
import { PINS } from './plugin.ts'
import { createRefHydrator } from './refs.ts'
import type { DefReader, RefHydrator } from './refs.ts'
import { resolveModel } from './seed.ts'
import { buildTraceTail } from './tail.ts'
import { TraceRecorder } from './trace.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

export interface LoopPolicyDeps {
  port: PortCaller
  /** 宿主只读解析通道（`host.def.read`）；缺省时只接受已解析的 refs 对象（单测便利）。 */
  host?: PortCaller
}

/** bag 里承载引用闭包的容器键 → 其 refs 所属身份（用于越权门禁）。 */
const REF_CONTAINERS: ReadonlyArray<readonly [string, string]> = [
  ['evolution', 'evolution'],
  ['evidence', 'evolution'],
  ['graph', 'loop-policy'],
  ['graph_refs', 'loop-policy'],
  ['approval', 'approval'],
  ['question', 'question'],
  ['session', 'session'],
]

/**
 * bag 里各容器 refs（哈希列表）按需解析成闭包；已是对象则原样。
 * `graph_refs` 直接挂在 bag 上（旧形状），其余为容器内的 `refs` 字段。
 */
async function hydrateBag(bag: Rec, hydrator: RefHydrator): Promise<Rec> {
  const out: Rec = { ...bag }
  for (const [key, identity] of REF_CONTAINERS) {
    if (key === 'graph_refs') {
      const refs = out[key]
      if (Array.isArray(refs) || isRecord(refs)) out[key] = await hydrator.hydrate(identity, refs)
      continue
    }
    const container = out[key]
    if (!isRecord(container)) continue
    const refs = container['refs']
    if (!Array.isArray(refs) && !isRecord(refs)) continue
    out[key] = { ...container, refs: await hydrator.hydrate(identity, refs) }
  }
  return out
}

function refsOf(bag: Rec): Rec {
  if (isRecord(bag['refs'])) return bag['refs'] as Rec
  if (isRecord(bag['graph_refs'])) return bag['graph_refs'] as Rec
  const graph = bag['graph']
  if (isRecord(graph) && isRecord(graph['refs'])) return graph['refs'] as Rec
  return {}
}

/** 续跑依据：`{cursor, thread, payload}`；也接受 cursor 直接作 resume。 */
function parseResume(bag: Rec): Rec | null {
  const resume = bag['resume']
  if (!isRecord(resume)) return null
  if (isRecord(resume['cursor'])) return resume
  if (typeof resume['kind'] === 'string') return { cursor: resume, thread: bag['thread'] ?? null }
  return resume
}

function resumeVerdict(resume: Rec): string | null {
  const payload = isRecord(resume['payload']) ? (resume['payload'] as Rec) : resume
  return asString(payload['verdict']) ?? asString(payload['decision'])
}

/** 回合累积器：evolution 回合初 body + 最近数据世代下标。 */
function newRound(bag: Rec): RoundPatches {
  return new RoundPatches(
    new Map([['evolution', { body: evolutionBody(bag), base: baseSeqOf(bag['evolution']) }]]),
  )
}

/** `orchestration_change` 裁决续跑：approved ⇒ 按 patch.writes[] 登记采纳；denied ⇒ 登记拒绝 verdict。 */
function orchestrationResume(bag: Rec, pins: Rec, resume: Rec, env: CallEnv, at: string): Json {
  const cursor = isRecord(resume['cursor']) ? (resume['cursor'] as Rec) : {}
  const proposalIds = Array.isArray(cursor['proposal_ids'])
    ? (cursor['proposal_ids'] as Json[]).filter((id): id is string => typeof id === 'string')
    : []
  const proposals = ledgerEntries(bag, 'proposals')
  const verdict = resumeVerdict(resume)
  const round = newRound(bag)
  if (verdict === 'approved' || verdict === 'accept') {
    for (const id of proposalIds) {
      const proposal = proposals.find((item) => item['id'] === id)
      if (proposal !== undefined) expandAdoption(bag, proposal, pins, at, env.run, round)
    }
    return planOf(round.finalize(), { ok: true, kind: 'adopt', proposal_ids: proposalIds })
  }
  expandRejection(bag, proposalIds, at, env.run, 'human_denied', round)
  return planOf(round.finalize(), {
    ok: true,
    kind: 'reject',
    proposal_ids: proposalIds,
  })
}

/** `interpret(bag)`：一次回合的图执行 + 回合尾写。 */
async function interpret(
  args: Json,
  env: CallEnv,
  deps: LoopPolicyDeps,
  hydrator: RefHydrator,
): Promise<HandlerResult> {
  if (!isRecord(args)) throw new BadArgsError('bag must be an object')
  const bag = await hydrateBag(args, hydrator)
  const refs = refsOf(bag)
  const resolved = resolveModel(bag['graph'], refs)
  const model = resolved.model
  const pins = isRecord(bag['pins']) ? (bag['pins'] as Rec) : PINS
  const at = isoAt(nowOf(env, bag))
  const resume = parseResume(bag)
  const events: HandlerResult['events'] = []

  if (resume !== null && isRecord(resume['cursor']) && resume['cursor']['kind'] === 'orchestration_change') {
    return { value: orchestrationResume(bag, pins, resume, env, at), events }
  }

  const trace = new TraceRecorder()
  const result = await interpretGraph({ bag, env, model, pins, port: deps.port, trace, resume })
  events.push(...result.events)
  const graphHash = H(model.graph)
  const round = newRound(bag)
  buildTraceTail(bag, trace, result.directives, env, graphHash, at, round)
  let proposalDirectives: Json[] = []
  if (result.pending === null) {
    const scan = await scanProposals({
      bag,
      env,
      model,
      pins,
      port: deps.port,
      run: env.run,
      workspaceId: asString(bag['workspace_id']),
      at,
      round,
    })
    proposalDirectives = scan.directives
    events.push(...scan.events)
  }
  // 同回合的 trace / verdicts 合并为一个 evolution 世代；影子指标等其它写仍在各自批次。
  const all: Json[] = [...result.directives, ...proposalDirectives, ...round.finalize()]
  const summary: Rec = {
    ...result.summary,
    fell_back: resolved.fellBack,
    graph: graphHash,
    ended: result.ended,
    refused_at: trace.refusedAt,
    branch_not_taken: trace.branchNotTaken,
    instances: trace.steps.map((step) => [step['node_index'], step['chosen_instance']]),
  }
  return { value: planOf(all, summary), events }
}

/** 构造方法表（依赖注入：反向调用通道由 main 提供）。 */
export function createHandlers(deps: LoopPolicyDeps): Record<string, Handler> {
  const read: DefReader = async (identity, hashes) => {
    if (deps.host === undefined) return null
    const outcome = await deps.host.call('host', 'def.read', { identity, hashes })
    if (!outcome.ok) return null
    return isRecord(outcome.value) ? outcome.value : null
  }
  const hydrator = createRefHydrator(read)
  return {
    interpret: (args: Json, env: CallEnv): Promise<HandlerResult> =>
      interpret(args, env, deps, hydrator),
  }
}
