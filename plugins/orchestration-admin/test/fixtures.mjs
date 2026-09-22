// 测试夹具：一份机械闸可通过的最小图（六类条目 + pins），以及按不变量逐条破坏的变体。
// derived_from 用本包 execute/hash.ts 的 H（与 validate 同口径）算出，保证 fork-only 规则成立。
import { H } from '../execute/hash.ts'

export const clone = (value) => JSON.parse(JSON.stringify(value))

export function contracts() {
  return [
    {
      contract_id: 'assemble',
      role_tag: 'assemble',
      inputs: [],
      outputs: [{ name: 'messages', type: 'messages' }],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: ['context'], methods: [], caps: {} },
      idempotent: true,
      touches_effects: false,
      can_delegate: false,
      cost: {},
    },
    {
      contract_id: 'step',
      role_tag: 'step',
      inputs: [{ name: 'messages', type: 'messages', required: true, cardinality: 1, binding_mode: 'all' }],
      outputs: [
        { name: 'message', type: 'message' },
        { name: 'tool_calls', type: 'tool_calls' },
      ],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: ['model'], methods: [], caps: {} },
      idempotent: false,
      touches_effects: true,
      can_delegate: false,
      cost: {},
    },
    {
      contract_id: 'commit',
      role_tag: 'commit',
      inputs: [{ name: 'message', type: 'message', required: true, cardinality: 1, binding_mode: 'all' }],
      outputs: [],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: ['session'], methods: [], caps: {} },
      idempotent: false,
      touches_effects: false,
      can_delegate: false,
      cost: {},
    },
    {
      contract_id: 'join',
      role_tag: 'join',
      inputs: [],
      outputs: [],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: [], methods: [], caps: {} },
      idempotent: true,
      touches_effects: false,
      can_delegate: false,
      cost: {},
    },
    {
      contract_id: 'subagent',
      role_tag: 'subagent',
      inputs: [{ name: 'task', type: 'task', required: true, cardinality: 1, binding_mode: 'all' }],
      outputs: [{ name: 'message', type: 'message' }],
      reads: [],
      publishes: [],
      pre: 'always',
      post: 'always',
      refuses: [],
      effects: { ports: ['model'], methods: [], caps: {} },
      idempotent: false,
      touches_effects: true,
      can_delegate: true,
      cost: {},
    },
  ]
}

export function nodes() {
  return [
    {
      node_id: 'nd-assemble',
      contract_id: 'assemble',
      impl: 'atomic',
      entry: { cap: 'context', method: 'build' },
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    },
    {
      node_id: 'nd-step',
      contract_id: 'step',
      impl: 'atomic',
      entry: { cap: 'model', method: 'chat' },
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    },
    {
      node_id: 'nd-commit',
      contract_id: 'commit',
      impl: 'atomic',
      entry: { cap: 'session', method: 'commit' },
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    },
    {
      node_id: 'nd-join',
      contract_id: 'join',
      impl: 'atomic',
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    },
    {
      node_id: 'nd-subagent',
      contract_id: 'subagent',
      impl: 'atomic',
      entry: { cap: 'model', method: 'chat' },
      bindings: {},
      autonomy: 'L0',
      scope: { kind: 'global' },
    },
  ]
}

export function graph(derivedFrom = null) {
  return {
    nodes: ['assemble', 'step', 'commit'],
    edges: [
      { from: [0, 'messages'], to: [1, 'messages'] },
      { from: [1, 'message'], to: [2, 'message'] },
    ],
    entry_supply: [{ type_id: 'task' }],
    loop: { when: 'always', max_iter: 'max_turn_iter' },
    sink: 2,
    derived_from: derivedFrom,
  }
}

export function pins() {
  return {
    model: 'model-protocol',
    context: 'context-window',
    session: 'session',
    guard: 'guard',
    approval: 'approval',
    tools: 'tools',
  }
}

export function thresholds(overrides = {}) {
  return { llm_chain_max: 2, max_graph_diff: 8, min_runs_before_fork: 3, ...overrides }
}

/** 组装一个 bag；`graphBody` 默认是 derived_from=null 的图。 */
export function bag(overrides = {}) {
  return {
    graph: {
      contracts: overrides.contracts ?? contracts(),
      nodes: overrides.nodes ?? nodes(),
      prompts: [],
      graph: overrides.graphBody ?? graph(null),
      thresholds: overrides.thresholds ?? thresholds(),
      refusal_codes: [],
    },
    pins: overrides.pins ?? pins(),
    active_graph: overrides.activeGraph ?? null,
    runs_since_fork: overrides.runsSinceFork ?? null,
    evolution: overrides.evolution ?? {
      version: 1,
      trace: { tail: null, count: 0 },
      evidence: { tail: null, count: 0 },
      proposals: { tail: null, count: 0 },
      verdicts: { tail: null, count: 0 },
    },
    now: overrides.now ?? 1_700_000_000_000,
    run: overrides.run ?? 'run-1',
    ...(overrides.extra ?? {}),
  }
}

/** 合法 fork：候选图 derived_from = H(active)，active 与候选结构相同（diff=0）。 */
export function forkBag(overrides = {}) {
  const active = overrides.activeGraph ?? graph(null)
  const candidate = overrides.graphBody ?? graph(H(active))
  return bag({ ...overrides, activeGraph: active, graphBody: candidate })
}

/** 边表引用：`graph.edges` 的规范键（测试断言用）。 */
export function edgeKeys(g) {
  return g.edges.map((edge) => `${edge.from[0]}:${edge.from[1]}->${edge.to[0]}:${edge.to[1]}`)
}
