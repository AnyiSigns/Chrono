// 能力类 `loop-policy` 的两个方法：`interpret`（入口 #14 eff 本方法，门面装配 bag 并编排）与
// `cancel`（转发取消意图给 graph-run）。图执行的重量级逻辑归 `graph-run`，回合尾 trace / 提案账本归
// `turn-ledger`；本插件保留原身份与公开方法名（消费方零改动），退化为薄门面：
// 水合引用闭包 → 契约版本边界 → （裁决续跑 | 图执行）→ 回合尾账本 → 会话收口。

import { H } from './hash.ts'
import { asString, isRecord, isoAt, nowOf, planOf } from './plan.ts'
import { graphSink } from './model.ts'
import {
  evalPostRule,
  evalPreRule,
  evalWhenRule,
  hasPostRule,
  hasPreRule,
  hasWhenRule,
  ruleCtxFromWire,
} from './loop-rule.ts'
import { afterStep, beforeSettle, noteInput, promoteInput } from './turn-hook.ts'
import { PINS } from './plugin.ts'
import { checkContractVersion } from './contract/index.ts'
import { attributionOf, resolveModel, retriableOf } from './seed.ts'
import { cancelledOutcome, committedOutcome, refusedOutcome } from './outcome.ts'
import { accumulateDirectives, accumulatedDirectives, clearTrace } from './segment-trace.ts'
import { BadArgsError, ServiceError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, PortCaller, Rec } from './types.ts'

/** 段 / 回合终态标记：段边界为 `stepping`（计划含续跑 eval，不是回合终态、不收口）。 */
const SEGMENT_ENDED = 'stepping'

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

/** 契约版本边界：主版本不匹配 ⇒ 立即拒绝（不派发执行、不写 trace、不扫描），给契约结构化结局。 */
async function contractVersionRefusal(
  bag: Rec,
  model: ReturnType<typeof resolveModel>['model'],
  fellBack: boolean,
  graphHash: string,
  turnId: string | null,
  outcome: Json,
  deps: LoopPolicyDeps,
): Promise<Json> {
  const summary: Rec = {
    ok: false,
    kind: 'interpret',
    iters: 1,
    steps: 0,
    pending: null,
    fell_back: fellBack,
    graph: graphHash,
    ended: 'refused',
    lifecycle: 'settled',
    progress: { iter: 1, node_index: null, contract_id: null },
    refused_at: {
      node_index: graphSink(model.graph),
      iter: 1,
      code: 'contract_version_mismatch',
      attributable_to: 'owner',
    },
    branch_not_taken: 0,
    instances: [],
    contract_version: asString(bag['contract_version']),
  }
  if (turnId !== null) {
    summary['turn_id'] = turnId
    const settled = await deps.port.call('session', 'turn_settle', { turn_id: turnId, outcome })
    summary['outcome'] = outcome
    summary['settled'] = settled.ok && isRecord(settled.value) && settled.value['ok'] === true
  }
  return planOf([], summary)
}

/** `orchestration_change` 裁决续跑：委派 `turn-ledger.decide`（采纳写回 loop-policy body / 拒绝 verdict）。 */
async function orchestrationResume(
  bag: Rec,
  pins: Rec,
  resume: Rec,
  at: string,
  deps: LoopPolicyDeps,
): Promise<Json> {
  const outcome = await deps.port.call('turn-ledger', 'decide', { bag, pins, resume, at })
  if (!outcome.ok) throw new ServiceError('ledger_unavailable', outcome.message)
  const value = isRecord(outcome.value) ? (outcome.value as Rec) : {}
  const batch = Array.isArray(value['batch']) ? (value['batch'] as Json[]) : []
  const summary = isRecord(value['summary'])
    ? (value['summary'] as Json)
    : { ok: true, kind: 'reject', proposal_ids: [] }
  return planOf(batch, summary)
}

interface GraphRunValue {
  directives: Json[]
  pending: Rec | null
  summary: Rec
  ended: string
  lifecycle: string
  progress: Json
  stopReason: string | null
  trace: Rec
}

/** 归一 graph-run.run 的回值（形态非法按内部错误，不静默误执行）。 */
function graphRunValueOf(value: Json): GraphRunValue {
  const raw = isRecord(value) ? value : null
  if (raw === null) throw new ServiceError('graph_run_bad_result', 'graph-run.run returned non-object')
  return {
    directives: Array.isArray(raw['directives']) ? (raw['directives'] as Json[]) : [],
    pending: isRecord(raw['pending']) ? (raw['pending'] as Rec) : null,
    summary: isRecord(raw['summary']) ? (raw['summary'] as Rec) : {},
    ended: asString(raw['ended']) ?? 'done',
    lifecycle: asString(raw['lifecycle']) ?? 'settled',
    progress: raw['progress'] ?? null,
    stopReason: asString(raw['stop_reason']),
    trace: isRecord(raw['trace']) ? (raw['trace'] as Rec) : {},
  }
}

/** `interpret(bag)`：门面编排一段回合的图执行 + 回合尾账本 + 会话收口。 */
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
  const turnId = asString(bag['turn_id'])
  const graphHash = H(model.graph)
  let ended: string | null = null

  try {
    // 契约边界：bag 带 `contract_version` 时主版本必须一致，未知主版本立即拒绝并给结构化结局；
    // 缺失视为未标注版本（兼容接受），是否记录由 `summary.contract_version` 决定。
    if (bag['contract_version'] !== undefined && bag['contract_version'] !== null) {
      const version = checkContractVersion(bag['contract_version'])
      if (!version.ok) {
        ended = 'refused'
        return {
          value: await contractVersionRefusal(
            bag,
            model,
            resolved.fellBack,
            graphHash,
            turnId,
            version.outcome as unknown as Json,
            deps,
          ),
          events: [],
        }
      }
    }

    if (
      resume !== null &&
      isRecord(resume['cursor']) &&
      resume['cursor']['kind'] === 'orchestration_change'
    ) {
      return { value: await orchestrationResume(bag, pins, resume, at, deps), events: [] }
    }

    // 执行一段：图执行引擎归 graph-run（模型解析归本门面，随 args 传入）。
    const ran = await deps.port.call('graph-run', 'run', { bag, model, pins, resume, refs })
    if (!ran.ok) throw new ServiceError('graph_run_unavailable', ran.message)
    const result = graphRunValueOf(ran.value)
    ended = result.ended
    const stepping = ended === SEGMENT_ENDED
    const trace = result.trace

    const all: Json[] = [...result.directives]
    if (stepping) {
      // 段终态：不落 trace 账本，只登记本段计划供 settle 出摘要。
      accumulateDirectives(turnId, result.directives)
    } else {
      const ledger = await deps.port.call('turn-ledger', 'settle', {
        bag,
        model,
        pins,
        trace,
        directives: accumulatedDirectives(turnId, result.directives),
        graph_hash: graphHash,
        scan: result.pending === null,
        at,
      })
      if (!ledger.ok) throw new ServiceError('ledger_unavailable', ledger.message)
      const ledgerValue = isRecord(ledger.value) ? (ledger.value as Rec) : {}
      const extra = Array.isArray(ledgerValue['extra']) ? (ledgerValue['extra'] as Json[]) : []
      const batch = Array.isArray(ledgerValue['batch']) ? (ledgerValue['batch'] as Json[]) : []
      all.push(...extra, ...batch)
    }

    const steps = Array.isArray(trace['steps']) ? (trace['steps'] as Json[]) : []
    const refusedAt = isRecord(trace['refused_at']) ? (trace['refused_at'] as Rec) : null
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
      refused_at: refusedAt,
      branch_not_taken: typeof trace['branch_not_taken'] === 'number' ? trace['branch_not_taken'] : 0,
      // 子图节点与父图共用 node_index 空间：带 parent_index（第三位）以保持可还原；父图节点保持二元组。
      instances: steps.map((step) =>
        isRecord(step) && step['parent_index'] !== undefined
          ? [step['node_index'], step['chosen_instance'], step['parent_index']]
          : [isRecord(step) ? step['node_index'] : null, isRecord(step) ? step['chosen_instance'] : null],
      ),
    }
    // 契约版本事实留痕：未标注（缺失）时为 null，消费方据此区分「未标注」与「已标注且兼容」。
    summary['contract_version'] = asString(bag['contract_version'])
    // 转换点 C：回合终态由属主 CAS 落定；`awaiting` / `stepping` 是段终态，不收口。
    if (turnId !== null) {
      summary['turn_id'] = turnId
      if (result.pending === null && !stepping) {
        const refusedCode = refusedAt !== null ? asString(refusedAt['code']) : null
        const fallbackAttr = refusedCode !== null ? attributionOf(model, refusedCode) : null
        const outcome =
          result.ended === 'refused'
            ? refusedOutcome(
                refusedCode ?? 'downstream_refusal',
                null,
                refusedCode !== null && retriableOf(model, refusedCode),
                fallbackAttr,
              )
            : result.ended === 'cancelled'
              ? cancelledOutcome()
              : committedOutcome(result.stopReason)
        const settled = await deps.port.call('session', 'turn_settle', { turn_id: turnId, outcome })
        summary['outcome'] = outcome
        summary['settled'] = settled.ok && isRecord(settled.value) && settled.value['ok'] === true
      }
    }
    return { value: planOf(all, summary), events: [] }
  } finally {
    // 段终态（stepping）：保留计划累积，让 settle 时一次出摘要；graph-run 侧同样保留 trace / 取消标志。
    if (ended !== SEGMENT_ENDED) clearTrace(turnId)
  }
}

/** `cancel(turn_id)`：转发取消意图给 graph-run（运行中的 run 在派发边界查、命中即停）；幂等。 */
async function cancel(args: Json, deps: LoopPolicyDeps): Promise<HandlerResult> {
  if (!isRecord(args)) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const turnId = asString(args['turn_id'])
  if (turnId === null) return { value: { ok: false, reason: 'bad_args' }, events: [] }
  const forwarded = await deps.port.call('graph-run', 'cancel', { turn_id: turnId })
  return {
    value: {
      ok: true,
      turn_id: turnId,
      cancelled: true,
      forwarded: forwarded.ok && isRecord(forwarded.value) && forwarded.value['cancelled'] === true,
    },
    events: [],
  }
}

/** `loop-rule` 名发现：`probe` 只回是否认领，不解释上下文。 */
function ruleNameProbe(args: Json, has: (name: string) => boolean): Rec {
  const input = isRecord(args) ? args : {}
  const name = asString(input['name']) ?? ''
  return { known: has(name) }
}

/** `loop-rule.when`：按名求值；未认领回 `{known:false}`，认领但畸形回 `{known:true, ok:false}`。 */
function whenRule(args: Json): Json {
  const input = isRecord(args) ? args : {}
  const name = asString(input['name']) ?? ''
  if (input['probe'] === true) return ruleNameProbe(input, hasWhenRule)
  if (!hasWhenRule(name)) return { known: false }
  const result = evalWhenRule(
    name,
    asString(input['args']) ?? '',
    ruleCtxFromWire(input['ctx']),
    typeof input['source_node'] === 'number' ? input['source_node'] : 0,
  )
  return { known: true, ok: result.ok, value: result.value, reason: result.reason ?? null }
}

/** `loop-rule.pre`：按名求值；未认领回 `{known:false}`。 */
function preRule(args: Json): Json {
  const input = isRecord(args) ? args : {}
  const name = asString(input['name']) ?? ''
  if (input['probe'] === true) return ruleNameProbe(input, hasPreRule)
  if (!hasPreRule(name)) return { known: false }
  const result = evalPreRule(name, ruleCtxFromWire(input['ctx']))
  return { known: true, ok: result.ok, reason: result.reason ?? null }
}

/** `loop-rule.post`：按名求值；未认领回 `{known:false}`。 */
function postRule(args: Json): Json {
  const input = isRecord(args) ? args : {}
  const name = asString(input['name']) ?? ''
  if (input['probe'] === true) return ruleNameProbe(input, hasPostRule)
  if (!hasPostRule(name)) return { known: false }
  const result = evalPostRule(name, ruleCtxFromWire(input['ctx']))
  return { known: true, ok: result.ok, reason: result.reason ?? null }
}

/** 构造方法表（依赖注入：反向调用通道由 main 提供）。 */
export function createHandlers(deps: LoopPolicyDeps): Record<string, Handler> {
  const hydrator = makeHydrator(deps.port)
  const fixed = (value: Json): HandlerResult => ({ value, events: [] })
  return {
    interpret: (args: Json, env: CallEnv): Promise<HandlerResult> =>
      interpret(args, env, deps, hydrator),
    cancel: (args: Json): Promise<HandlerResult> => cancel(args, deps),
    // 队列写口：回合/输入/队列词汇归本门面，session 保留持久存储。
    'note-input': (args: Json): Promise<HandlerResult> =>
      noteInput(args, { port: deps.port }).then(fixed),
    'promote-input': (args: Json): Promise<HandlerResult> =>
      promoteInput(args, { port: deps.port }).then(fixed),
    when: (args: Json): Promise<HandlerResult> => Promise.resolve(fixed(whenRule(args))),
    pre: (args: Json): Promise<HandlerResult> => Promise.resolve(fixed(preRule(args))),
    post: (args: Json): Promise<HandlerResult> => Promise.resolve(fixed(postRule(args))),
    // 固定点钩子：before-assemble / after-settle 默认无增量；after-step 给空转文案；before-settle 探排队输入。
    'before-assemble': (): Promise<HandlerResult> => Promise.resolve(fixed({ delta: {} })),
    'after-step': (args: Json): Promise<HandlerResult> => Promise.resolve(fixed(afterStep(args))),
    'before-settle': (args: Json): Promise<HandlerResult> =>
      beforeSettle(args, { port: deps.port }).then(fixed),
    'after-settle': (): Promise<HandlerResult> => Promise.resolve(fixed({ delta: {} })),
  }
}
