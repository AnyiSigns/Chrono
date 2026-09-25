// 包内种子图与默认阈值（兜底目标）：graph 为空 / 解析失败时回落此处。
// 种子契约十一个（含 join / subagent / evolve.propose / recall 词汇与 verify 分档）、七节点、
// 四个实质 post；加强不落在默认路径上（简单问答仍是 assemble → step → commit 三步、零额外调用）。
// 数据住数据世代；本文件只是**包内兜底**，不读投影、不 import 宿主。

import { graphNodes, readGraphModel } from './model.ts'
import type { GraphModel, Json, Rec } from './types.ts'

/** 默认阈值：字段名契约与 evolve-metrics README「阈值契约」对齐；图/演化参数亦在此。 */
export const DEFAULT_THRESHOLDS: Rec = {
  // 图与演化（loop-policy 权威）
  max_turn_iter: 64,
  max_steps: 512,
  gas: 64,
  llm_chain_max: 2,
  post_retry_max: 2,
  max_graph_diff: 8,
  min_runs_before_fork: 3,
  max_links: 4,
  graph_growth_quota: 1,
  instance_growth_quota: 1,
  shadow_rounds: 8,
  large_artifact_bytes: 65536,
  model_alias_pins: 0,
  // evolve-metrics 阈值契约（本插件不重定义语义，只提供默认值）
  failure_cluster_n: 3,
  post_failure_ratio: 0.5,
  post_failure_min: 3,
  cost_anomaly_multiple: 2.0,
  drift_margin: 0.2,
  drift_min_samples: 5,
  fold_k: 3,
  no_progress_n: 3,
  verify_failure_n: 2,
  verify_cluster_ratio: 0.6,
  min_workspaces: 2,
  trace_retention_rounds: 50,
  evidence_retention_rounds: 50,
  unhealthy_refused_streak: 3,
}

/** 全局拒绝码表（append-only；attributable_to 含 user 维）。 */
export const SEED_REFUSAL_CODES: Rec[] = [
  { code: 'pre_unsat', retriable: false, attributable_to: 'node' },
  { code: 'input_insufficient', retriable: true, attributable_to: 'graph' },
  { code: 'capability_mismatch', retriable: false, attributable_to: 'graph' },
  // 模型偶发空产出（无正文、无工具调用）：非图的能力错配，可重跑本步。
  { code: 'empty_output', retriable: true, attributable_to: 'node' },
  { code: 'budget', retriable: false, attributable_to: 'budget' },
  { code: 'undeclared_read', retriable: false, attributable_to: 'node' },
  { code: 'downstream_refusal', retriable: false, attributable_to: 'graph' },
  { code: 'redundant', retriable: false, attributable_to: 'graph' },
  { code: 'transport_failed', retriable: true, attributable_to: 'node' },
  { code: 'stale_dep', retriable: false, attributable_to: 'graph' },
  { code: 'scope_mismatch', retriable: false, attributable_to: 'graph' },
  { code: 'link_denied', retriable: false, attributable_to: 'graph' },
  { code: 'needs_approval', retriable: false, attributable_to: 'user' },
  { code: 'denied', retriable: false, attributable_to: 'user' },
]

/** 拒绝码 → 归因（全局表查不到时回落 graph）。 */
export function attributionOf(model: GraphModel, code: string): string {
  for (const entry of model.refusalCodes) {
    if (entry['code'] === code) return typeof entry['attributable_to'] === 'string' ? entry['attributable_to'] : 'graph'
  }
  return 'graph'
}

/** 拒绝码是否可重试。 */
export function retriableOf(model: GraphModel, code: string): boolean {
  for (const entry of model.refusalCodes) {
    if (entry['code'] === code) return entry['retriable'] === true
  }
  return false
}

function input(name: string, type: string, opts: Rec = {}): Rec {
  return { name, type, required: false, cardinality: 1, binding_mode: 'all', ...opts }
}

function output(name: string, type: string, opts: Rec = {}): Rec {
  return { name, type, cardinality: 1, ...opts }
}

const NO_FS: Rec = { fs: { read: 'none', write: 'none' }, net: 'none' }
const WS_FS: Rec = { fs: { read: 'workspace', write: 'workspace' }, net: 'none' }

/** 种子契约十一个。 */
export const SEED_CONTRACTS: Rec[] = [
  {
    contract_id: 'context.assemble',
    role_tag: 'assemble',
    inputs: [input('task', 'task')],
    outputs: [output('messages', 'messages'), output('params', 'model_params')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'assemble_post',
    refuses: ['pre_unsat'],
    effects: { ports: ['context'], methods: ['build'], caps: NO_FS },
    idempotent: true,
    touches_effects: false,
    can_delegate: false,
    cost: { calls: 1 },
  },
  {
    contract_id: 'agent.step',
    role_tag: 'step',
    inputs: [input('messages', 'messages', { required: true })],
    outputs: [output('message', 'message'), output('tool_calls', 'tool_calls')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'step_post',
    refuses: ['pre_unsat', 'transport_failed'],
    effects: { ports: ['model'], methods: ['chat'], caps: { fs: { read: 'none', write: 'none' }, net: 'allow' } },
    idempotent: false,
    touches_effects: true,
    can_delegate: true,
    cost: { calls: 1, tokens: 2000 },
  },
  {
    contract_id: 'tool.gate',
    role_tag: 'gate',
    inputs: [input('calls', 'tool_calls', { required: true })],
    outputs: [output('verdict', 'verdict')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: ['pre_unsat'],
    effects: { ports: ['guard'], methods: ['judge'], caps: NO_FS },
    idempotent: true,
    touches_effects: false,
    can_delegate: false,
    cost: { calls: 1 },
  },
  {
    contract_id: 'approval.wait',
    role_tag: 'approval',
    inputs: [input('request', 'verdict', { required: true })],
    outputs: [output('decision', 'verdict')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: ['pre_unsat'],
    effects: { ports: ['approval'], methods: ['enqueue'], caps: NO_FS },
    idempotent: false,
    touches_effects: false,
    can_delegate: false,
    cost: { calls: 1 },
  },
  {
    contract_id: 'tool.dispatch',
    role_tag: 'dispatch',
    // 两条入边（gate allow / approval approved）互斥 ⇒ any。
    inputs: [input('verdict', 'verdict', { required: true, binding_mode: 'any' })],
    outputs: [output('results', 'tool_results')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'dispatch_post',
    refuses: ['pre_unsat', 'transport_failed'],
    effects: { ports: ['tools'], methods: ['dispatch'], caps: WS_FS },
    idempotent: false,
    touches_effects: true,
    can_delegate: true,
    cost: { tool_calls: 1 },
  },
  {
    contract_id: 'verify',
    role_tag: 'verify',
    inputs: [input('changes', 'tool_results')],
    outputs: [output('report', 'verify_report')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'verify_post',
    refuses: ['pre_unsat'],
    effects: { ports: ['tools'], methods: ['dispatch'], caps: WS_FS },
    idempotent: false,
    touches_effects: true,
    can_delegate: false,
    cost: { tool_calls: 1 },
  },
  {
    contract_id: 'join',
    role_tag: 'join',
    inputs: [input('left', 'any'), input('right', 'any')],
    outputs: [output('merged', 'any')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: [],
    effects: { ports: [], methods: [], caps: NO_FS },
    idempotent: true,
    touches_effects: false,
    can_delegate: false,
    cost: {},
  },
  {
    contract_id: 'subagent',
    role_tag: 'subagent',
    inputs: [input('messages', 'messages', { required: true })],
    outputs: [output('message', 'message'), output('tool_calls', 'tool_calls')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'step_post',
    refuses: ['pre_unsat', 'transport_failed'],
    effects: { ports: ['model'], methods: ['chat'], caps: { fs: { read: 'none', write: 'none' }, net: 'allow' } },
    idempotent: false,
    touches_effects: true,
    can_delegate: true,
    cost: { calls: 1, tokens: 2000 },
  },
  {
    contract_id: 'evolve.propose',
    role_tag: 'propose',
    inputs: [input('task', 'task')],
    outputs: [output('proposal', 'proposal')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: ['pre_unsat'],
    effects: { ports: ['model'], methods: ['chat'], caps: { fs: { read: 'none', write: 'none' }, net: 'allow' } },
    idempotent: false,
    touches_effects: true,
    can_delegate: false,
    cost: { calls: 1, tokens: 3000 },
  },
  {
    contract_id: 'recall',
    role_tag: 'recall',
    inputs: [input('task', 'task')],
    outputs: [output('recall', 'recall')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: ['pre_unsat', 'transport_failed'],
    effects: { ports: ['retrieval'], methods: ['search'], caps: NO_FS },
    idempotent: true,
    touches_effects: true,
    can_delegate: false,
    cost: { calls: 1 },
  },
  {
    contract_id: 'turn.commit',
    role_tag: 'commit',
    inputs: [
      input('message', 'message', { binding_mode: 'any' }),
      // 拒绝端口承载 gate verdict / approval decision / 拒绝产物 ⇒ any 类型。
      input('refusal', 'any', { binding_mode: 'any' }),
      input('results', 'tool_results', { binding_mode: 'any' }),
      input('report', 'verify_report', { binding_mode: 'any' }),
    ],
    outputs: [output('plan', 'plan')],
    reads: [],
    publishes: [],
    pre: 'always',
    post: 'always',
    refuses: [],
    effects: { ports: ['session'], methods: ['commit'], caps: NO_FS },
    idempotent: false,
    touches_effects: false,
    can_delegate: false,
    cost: { calls: 1 },
  },
]

function node(nodeId: string, contractId: string, entry: Rec | null, scope: Rec, extra: Rec = {}): Rec {
  const out: Rec = {
    node_id: nodeId,
    contract_id: contractId,
    impl: 'atomic',
    bindings: {},
    autonomy: 'L0',
    scope,
    ...extra,
  }
  if (entry !== null) out['entry'] = entry
  return out
}

const GLOBAL: Rec = { kind: 'global' }

/** 种子 Scope 实例（含 join / subagent / evolve.propose / recall 的中性全局实例与 verify 分档）。 */
export const SEED_NODES: Rec[] = [
  node('as-assemble', 'context.assemble', { cap: 'context', method: 'build' }, GLOBAL),
  node('as-step', 'agent.step', { cap: 'model', method: 'chat' }, GLOBAL),
  node('as-gate', 'tool.gate', { cap: 'guard', method: 'judge' }, GLOBAL),
  node('as-approval', 'approval.wait', { cap: 'approval', method: 'enqueue' }, GLOBAL),
  node('as-dispatch', 'tool.dispatch', { cap: 'tools', method: 'dispatch' }, GLOBAL),
  node('as-verify-noop', 'verify', null, GLOBAL),
  node('as-commit', 'turn.commit', { cap: 'session', method: 'commit' }, GLOBAL),
  node('jn-global', 'join', null, GLOBAL, { bindings: { join: 'same_key_latest' } }),
  node('sa-global', 'subagent', { cap: 'model', method: 'chat' }, GLOBAL, { bindings: { agent: 'neutral' } }),
  node('ep-global', 'evolve.propose', { cap: 'model', method: 'chat' }, GLOBAL),
  node('rc-global', 'recall', { cap: 'retrieval', method: 'search' }, GLOBAL),
]

/** 图级系统提示词（行为准则 + 产品事实；禁工具标识符、只谈意图）。 */
export const SEED_PROMPTS: Rec = {
  system: {
    id: 'system',
    text:
      '你是 Chrono 的编排智能体。行为准则：先理解意图再行动；需要外部信息或落地改动时用可用能力完成，' +
      '做完给结论、不要罗列过程；遇到无法自行决定的事项就向用户提问并等待；失败要收口并说明原因。' +
      '要继续行动时必须实际调用能力，不要只描述计划或「下一步」就停；只有任务确实完成、或确需用户决定时才给结论。' +
      '产品事实：这是一个本地优先的个人智能体工作台，能力边界由当前工作区与权限档决定；' +
      '硬约束：只谈意图与结果，不输出任何具体能力标识、调用步骤或参数。',
  },
  skill_select: { id: 'skill_select', text: '按任务意图与工作区匹配选用技能；无匹配则不注入。' },
}

/** 种子图（七节点十一入边 + 五入边互斥 sink）。 */
export const SEED_GRAPH: Rec = {
  nodes: [
    'context.assemble',
    'agent.step',
    'tool.gate',
    'approval.wait',
    'tool.dispatch',
    'verify',
    'turn.commit',
  ],
  edges: [
    { from: [0, 'messages'], to: [1, 'messages'] },
    { from: [1, 'tool_calls'], to: [2, 'calls'], when: 'nonempty(tool_calls)' },
    { from: [1, 'message'], to: [6, 'message'], when: 'empty(tool_calls)' },
    { from: [2, 'verdict'], to: [4, 'verdict'], when: 'verdict_is(allow)' },
    { from: [2, 'verdict'], to: [3, 'request'], when: 'verdict_is(escalate)' },
    { from: [2, 'verdict'], to: [6, 'refusal'], when: 'verdict_is(deny)' },
    { from: [3, 'decision'], to: [4, 'verdict'], when: 'verdict_is(approved)' },
    { from: [3, 'decision'], to: [6, 'refusal'], when: 'verdict_is(denied)' },
    { from: [4, 'results'], to: [5, 'changes'], when: 'wrote_files(results)' },
    { from: [4, 'results'], to: [6, 'results'], when: 'not wrote_files(results)' },
    { from: [5, 'report'], to: [6, 'report'] },
  ],
  entry_supply: [{ type_id: 'task', role: 'task' }],
  loop: { when: 'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete', max_iter: 'max_turn_iter' },
  sink: 6,
}

/** 种子模型（六类条目 + 默认阈值）。 */
export function seedModel(): GraphModel {
  return {
    contracts: SEED_CONTRACTS,
    nodes: SEED_NODES,
    prompts: SEED_PROMPTS,
    graph: SEED_GRAPH,
    thresholds: { ...DEFAULT_THRESHOLDS },
    refusalCodes: SEED_REFUSAL_CODES,
  }
}

export interface ResolvedModel {
  model: GraphModel
  fellBack: boolean
}

/** 拒绝码表 append-only：保留图上已有条目，补进包内种子新增码（老图无需重 seed 即获新码）。 */
function mergeRefusalCodes(provided: Rec[]): Rec[] {
  if (provided.length === 0) return SEED_REFUSAL_CODES
  const seen = new Set(provided.map((entry) => entry['code']))
  const merged = [...provided]
  for (const entry of SEED_REFUSAL_CODES) {
    if (!seen.has(entry['code'])) merged.push(entry)
  }
  return merged
}

/**
 * 解析随 bag 传入的图数据；空 body / 解析失败 / 图不可执行 ⇒ 回落包内种子图。
 * 各缺类条目按类回落种子；阈值与默认值合流（缺名补默认）。
 */
export function resolveModel(raw: Json | undefined, refs: Rec): ResolvedModel {
  const provided = readGraphModel(raw, refs)
  if (provided === null || graphNodes(provided.graph).length === 0) {
    return { model: seedModel(), fellBack: true }
  }
  const contracts = provided.contracts.length > 0 ? provided.contracts : SEED_CONTRACTS
  const nodes = provided.nodes.length > 0 ? provided.nodes : SEED_NODES
  if (nodes.length === 0) return { model: seedModel(), fellBack: true }
  const ids = new Set(contracts.map((contract) => contract['contract_id']).filter((id): id is string => typeof id === 'string'))
  const usable = graphNodes(provided.graph).every((id) => ids.has(id))
  if (!usable) return { model: seedModel(), fellBack: true }
  return {
    model: {
      contracts,
      nodes,
      prompts: { ...SEED_PROMPTS, ...provided.prompts },
      graph: provided.graph,
      thresholds: { ...DEFAULT_THRESHOLDS, ...provided.thresholds },
      refusalCodes: mergeRefusalCodes(provided.refusalCodes),
    },
    fellBack: false,
  }
}
