// 能力类 `loop-policy` 的唯一方法 `interpret`：入口 #14 入口 term eff 本方法（bag 装配归 #14）。
// 服务自驱：读图数据 → 解释器顺序推进 → 回合尾写 trace / 队列项 / 提案扫描 → 返回计划交 #14 合并上提。
// 服务不读投影、不写链、不自取时钟（now 取 env）；同输入同输出（LLM 项除外，eff_log 回灌配对下等价）。

import { interpretGraph } from './interpreter.ts'
import { clearCancel, requestCancel } from './cancel.ts'
import {
  evolutionBody,
  expandAdoption,
  expandRejection,
  ledgerEntries,
  scanProposals,
} from './proposals.ts'
import { H } from './hash.ts'
import { asString, baseSeqOf, isRecord, isoAt, nowOf, planOf, RoundPatches } from './plan.ts'
import { PINS } from './plugin.ts'
import { cancelledOutcome, committedOutcome, refusedOutcome } from './outcome.ts'
import { SEGMENT_ENDED } from './lifecycle.ts'
import { attributionOf, resolveModel, retriableOf } from './seed.ts'
import {
  accumulateDirectives,
  accumulatedDirectives,
  clearTrace,
  traceFor,
} from './segment-trace.ts'
import { buildTraceTail } from './tail.ts'
import { BadArgsError, ServiceError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

export interface LoopPolicyDeps {
  port: PortCaller
  /** 宿主注入的有效 pins（声明 `pins` ∪ one-needs）；bag 内场景覆盖优先于它。 */
  pins?: Rec
}

/** 引用水合端口（`ref-hydrate.hydrate`）：按身份把 bag 内 refs 解析成闭包；失败按拆分前语义映射 def_unavailable。 */
export interface RefHydrator {
  hydrate(identity: string, refs: Json): Promise<Rec>
}

/** 构造水合端口：反向调 `ref-hydrate.hydrate`；已是对象 / 非数组短路（不打无谓往返）。 */
export function makeHydrator(port: PortCaller): RefHydrator {
  return {
    hydrate: async (identity, refs) => {
      if (isRecord(refs)) return refs
      if (!Array.isArray(refs)) return {}
      const outcome = await port.call('ref-hydrate', 'hydrate', { identity, refs })
      if (!outcome.ok) throw new ServiceError('def_unavailable', outcome.message)
      return isRecord(outcome.value) ? outcome.value : {}
    },
  }
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
  const pins = isRecord(bag['pins']) ? (bag['pins'] as Rec) : (deps.pins ?? PINS)
  const at = isoAt(nowOf(env, bag))
  const resume = parseResume(bag)
  const events: HandlerResult['events'] = []
  const turnId = asString(bag['turn_id'])
  let ended: string | null = null

  try {
    if (
      resume !== null &&
      isRecord(resume['cursor']) &&
      resume['cursor']['kind'] === 'orchestration_change'
    ) {
      return { value: orchestrationResume(bag, pins, resume, env, at), events }
    }

    // 段间 trace 累积：同一回合的多次 interpret 共用一个记录器，settle 时一次写（每回合一个 evolution 世代）。
    const trace = traceFor(turnId)
    const result = await interpretGraph({
      bag,
      env,
      model,
      pins,
      port: deps.port,
      trace,
      resume,
      refs,
    })
    ended = result.ended
    events.push(...result.events)
    const graphHash = H(model.graph)
    const round = newRound(bag)
    const stepping = result.ended === SEGMENT_ENDED
    if (stepping) {
      // 段终态：不落 trace / 不改 evolution，只登记本段计划供 settle 出摘要。
      accumulateDirectives(turnId, result.directives)
    } else {
      buildTraceTail(
        bag,
        trace,
        accumulatedDirectives(turnId, result.directives),
        env,
        graphHash,
        at,
        round,
      )
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
        events.push(...scan.events)
        for (const directive of scan.directives) {
          result.directives.push(directive)
        }
      }
    }
    // 同回合的 trace / verdicts 合并为一个 evolution 世代；影子指标等其它写仍在各自批次。
    const all: Json[] = [...result.directives, ...round.finalize()]
    const summary: Rec = {
      ...result.summary,
      // 段终态摘要不占用 `interpret` 这一终态摘要标识：同 run 后续段的终态摘要才是回执用的那条。
      kind: stepping ? SEGMENT_ENDED : 'interpret',
      fell_back: resolved.fellBack,
      graph: graphHash,
      ended: result.ended,
      // 解释器生命周期（封闭枚举）与图内进度（数据）：换图不改枚举，UI 按 contract_id 映射当前动作。
      lifecycle: result.lifecycle,
      progress: result.progress,
      refused_at: trace.refusedAt,
      branch_not_taken: trace.branchNotTaken,
      // 子图节点与父图共用 node_index 空间：带 parent_index（第三位）以保持可还原；父图节点保持二元组。
      instances: trace.steps.map((step) =>
        step['parent_index'] !== undefined
          ? [step['node_index'], step['chosen_instance'], step['parent_index']]
          : [step['node_index'], step['chosen_instance']],
      ),
    }
    // 契约版本事实留痕：未标注（缺失）时为 null，消费方据此区分「未标注」与「已标注且兼容」。
    summary['contract_version'] = asString(bag['contract_version'])
    // 转换点 C：回合终态由属主 CAS 落定；`awaiting` / `stepping` 是段终态，不收口。
    if (turnId !== null) {
      summary['turn_id'] = turnId
      if (result.pending === null && !stepping) {
        const refusedCode = trace.refusedAt !== null ? asString(trace.refusedAt['code']) : null
        const fallbackAttr = refusedCode !== null ? attributionOf(model, refusedCode) : null
        const outcome =
          result.ended === 'refused'
            ? (result.refusedOutcome ??
              refusedOutcome(
                refusedCode ?? 'downstream_refusal',
                null,
                refusedCode !== null && retriableOf(model, refusedCode),
                fallbackAttr,
              ))
            : result.ended === 'cancelled'
              ? cancelledOutcome()
              : committedOutcome(result.stopReason)
        const settled = await deps.port.call('session', 'turn_settle', { turn_id: turnId, outcome })
        summary['outcome'] = outcome
        summary['settled'] = settled.ok && isRecord(settled.value) && settled.value['ok'] === true
      }
    }
    return { value: planOf(all, summary), events }
  } finally {
    // 段终态（stepping）：保留取消标志与 trace 累积，让下一段入口仍能看见取消、settle 时一次写出。
    if (ended !== SEGMENT_ENDED) {
      clearTrace(turnId)
      clearCancel(turnId)
    }
  }
}

/** `cancel(turn_id)`：置内存标志，运行中的 interpret 在派发边界查、命中即停；幂等。 */
function cancel(args: Json): HandlerResult {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  if (turnId === null) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  requestCancel(turnId)
  return { value: { ok: true, turn_id: turnId, cancelled: true }, events: [] }
}

/** 构造方法表（依赖注入：反向调用通道由 main 提供）。 */
export function createHandlers(deps: LoopPolicyDeps): Record<string, Handler> {
  const hydrator = makeHydrator(deps.port)
  return {
    interpret: (args: Json, env: CallEnv): Promise<HandlerResult> =>
      interpret(args, env, deps, hydrator),
    cancel: (args: Json): Promise<HandlerResult> => Promise.resolve(cancel(args)),
  }
}
