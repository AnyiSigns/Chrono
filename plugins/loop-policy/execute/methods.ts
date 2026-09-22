// 能力类 `loop-policy` 的唯一方法 `interpret`：入口 #14 入口 term eff 本方法（bag 装配归 #14）。
// 服务自驱：读图数据 → 解释器顺序推进 → 回合尾写 trace / 队列项 / 提案扫描 → 返回计划交 #14 合并上提。
// 服务不读投影、不写链、不自取时钟（now 取 env）；同输入同输出（LLM 项除外，eff_log 回灌配对下等价）。

import { interpretGraph } from './interpreter.ts'
import { expandAdoption, expandRejection, ledgerEntries, scanProposals } from './proposals.ts'
import { H } from './hash.ts'
import { asString, isRecord, isoAt, nowOf, planOf } from './plan.ts'
import { PINS } from './plugin.ts'
import { resolveModel } from './seed.ts'
import { buildTraceTail } from './tail.ts'
import { TraceRecorder } from './trace.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

export interface LoopPolicyDeps {
  port: PortCaller
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

/** `orchestration_change` 裁决续跑：approved ⇒ 按 patch.writes[] 展开采纳；denied ⇒ 落拒绝 verdict。 */
function orchestrationResume(bag: Rec, pins: Rec, resume: Rec, env: CallEnv, at: string): Json {
  const cursor = isRecord(resume['cursor']) ? (resume['cursor'] as Rec) : {}
  const proposalIds = Array.isArray(cursor['proposal_ids'])
    ? (cursor['proposal_ids'] as Json[]).filter((id): id is string => typeof id === 'string')
    : []
  const proposals = ledgerEntries(bag, 'proposals')
  const verdict = resumeVerdict(resume)
  if (verdict === 'approved' || verdict === 'accept') {
    const directives: Json[] = []
    for (const id of proposalIds) {
      const proposal = proposals.find((item) => item['id'] === id)
      if (proposal !== undefined) for (const directive of expandAdoption(bag, proposal, pins, at, env.run)) directives.push(directive)
    }
    return planOf(directives, { ok: true, kind: 'adopt', proposal_ids: proposalIds })
  }
  return planOf(expandRejection(bag, proposalIds, at, env.run, 'human_denied'), {
    ok: true,
    kind: 'reject',
    proposal_ids: proposalIds,
  })
}

/** `interpret(bag)`：一次回合的图执行 + 回合尾写。 */
async function interpret(args: Json, env: CallEnv, deps: LoopPolicyDeps): Promise<HandlerResult> {
  if (!isRecord(args)) throw new BadArgsError('bag must be an object')
  const bag = args
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
  const tail = buildTraceTail(bag, trace, result.directives, env, graphHash, at)
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
    })
    proposalDirectives = scan.directives
    events.push(...scan.events)
  }
  const all: Json[] = [...result.directives, ...tail, ...proposalDirectives]
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
  return {
    interpret: (args: Json, env: CallEnv): Promise<HandlerResult> => interpret(args, env, deps),
  }
}
