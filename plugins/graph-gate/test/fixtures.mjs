// graph-gate 测试本地夹具：一份最小可执行图模型（与生产种子图同形：七节点 / 十一入边 / 五入边互斥 sink），
// 供闭合 / 类型 / publish 偏序 / 端口 ⊆ pins / 六不变量 / 四演化规则的正反例复用。
// 刻意内联（不 import 其它插件）：插件间不得直连；真实跨插件集成由根 tests/contract 覆盖。

const NO_FS = { fs: { read: 'none', write: 'none' }, net: 'none' }
const WS_FS = { fs: { read: 'workspace', write: 'workspace' }, net: 'none' }
const MODEL_NET = { fs: { read: 'none', write: 'none' }, net: 'allow' }

function input(name, type, opts = {}) {
  return { name, type, required: false, cardinality: 1, binding_mode: 'all', ...opts }
}

function output(name, type) {
  return { name, type, cardinality: 1 }
}

const CONTRACTS = [
  {
    contract_id: 'context.assemble',
    inputs: [input('task', 'task')],
    outputs: [output('messages', 'messages'), output('params', 'model_params')],
    publishes: [],
    effects: { ports: ['context'], methods: ['build'], caps: NO_FS },
    touches_effects: false,
  },
  {
    contract_id: 'agent.step',
    inputs: [input('messages', 'messages', { required: true })],
    outputs: [output('message', 'message'), output('tool_calls', 'tool_calls')],
    publishes: [],
    effects: { ports: ['model'], methods: ['chat'], caps: MODEL_NET },
    touches_effects: true,
  },
  {
    contract_id: 'tool.gate',
    inputs: [input('calls', 'tool_calls', { required: true })],
    outputs: [output('verdict', 'verdict')],
    publishes: [],
    effects: { ports: ['guard'], methods: ['judge'], caps: NO_FS },
    touches_effects: false,
  },
  {
    contract_id: 'approval.wait',
    inputs: [input('request', 'verdict', { required: true })],
    outputs: [output('decision', 'verdict')],
    publishes: [],
    effects: { ports: ['approval'], methods: ['enqueue'], caps: NO_FS },
    touches_effects: false,
  },
  {
    contract_id: 'tool.dispatch',
    inputs: [input('verdict', 'verdict', { required: true, binding_mode: 'any' })],
    outputs: [output('results', 'tool_results')],
    publishes: [],
    effects: { ports: ['tools'], methods: ['dispatch'], caps: WS_FS },
    touches_effects: true,
  },
  {
    contract_id: 'verify',
    inputs: [input('changes', 'tool_results')],
    outputs: [output('report', 'verify_report')],
    publishes: [],
    effects: { ports: ['tools'], methods: ['dispatch'], caps: WS_FS },
    touches_effects: true,
  },
  {
    contract_id: 'join',
    inputs: [input('left', 'any'), input('right', 'any')],
    outputs: [output('merged', 'any')],
    publishes: [],
    effects: { ports: [], methods: [], caps: NO_FS },
    touches_effects: false,
  },
  {
    contract_id: 'subagent',
    inputs: [input('messages', 'messages', { required: true }), input('task', 'task')],
    outputs: [output('message', 'message'), output('tool_calls', 'tool_calls')],
    publishes: [],
    effects: { ports: ['model'], methods: ['chat'], caps: MODEL_NET },
    touches_effects: true,
  },
  {
    contract_id: 'evolve.propose',
    inputs: [input('task', 'task')],
    outputs: [output('proposal', 'proposal')],
    publishes: [],
    effects: { ports: ['model'], methods: ['chat'], caps: MODEL_NET },
    touches_effects: true,
  },
  {
    contract_id: 'turn.commit',
    inputs: [
      input('message', 'message', { binding_mode: 'any' }),
      input('refusal', 'any', { binding_mode: 'any' }),
      input('results', 'tool_results', { binding_mode: 'any' }),
      input('report', 'verify_report', { binding_mode: 'any' }),
    ],
    outputs: [output('plan', 'plan')],
    publishes: [],
    effects: { ports: ['session'], methods: ['step_append'], caps: NO_FS },
    touches_effects: false,
  },
]

function node(nodeId, contractId, entry, scope, extra = {}) {
  const out = {
    node_id: nodeId,
    contract_id: contractId,
    impl: 'atomic',
    bindings: {},
    autonomy: 'L0',
    scope,
    ...extra,
  }
  if (entry !== null) out.entry = entry
  return out
}

const GLOBAL = { kind: 'global' }

const NODES = [
  node('as-assemble', 'context.assemble', { cap: 'context', method: 'build' }, GLOBAL),
  node('as-step', 'agent.step', { cap: 'model', method: 'chat' }, GLOBAL),
  node('as-gate', 'tool.gate', { cap: 'guard', method: 'judge' }, GLOBAL),
  node('as-approval', 'approval.wait', { cap: 'approval', method: 'enqueue' }, GLOBAL),
  node('as-dispatch', 'tool.dispatch', { cap: 'tools', method: 'dispatch' }, GLOBAL),
  node('as-verify-noop', 'verify', null, GLOBAL),
  node('as-commit', 'turn.commit', { cap: 'session', method: 'step_append' }, GLOBAL),
  node('jn-global', 'join', null, GLOBAL, { bindings: { join: 'same_key_latest' } }),
  node('sa-global', 'subagent', { cap: 'model', method: 'chat' }, GLOBAL, {
    bindings: { agent: 'neutral' },
  }),
  node('ep-global', 'evolve.propose', { cap: 'model', method: 'chat' }, GLOBAL),
]

const GRAPH = {
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
  loop: {
    when: 'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete',
    max_iter: 'max_turn_iter',
  },
  sink: 6,
}

const THRESHOLDS = { llm_chain_max: 2, max_graph_diff: 8, min_runs_before_fork: 3 }

/** 种子模型：每次返回全新深拷贝，避免用例间相互污染。 */
export function seedModel() {
  return {
    contracts: JSON.parse(JSON.stringify(CONTRACTS)),
    nodes: JSON.parse(JSON.stringify(NODES)),
    prompts: {},
    graph: JSON.parse(JSON.stringify(GRAPH)),
    thresholds: { ...THRESHOLDS },
    refusalCodes: [],
  }
}
