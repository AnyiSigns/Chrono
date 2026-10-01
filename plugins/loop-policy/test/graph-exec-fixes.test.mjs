// 本轮图执行修复的协议级测试：G1 拓扑序 / G2 composite 展开 / G5 分支互斥与 not-taken /
// G6 运行期轻量闭合 / G7 optional 输入 / G8 grant 维度合并 / G9 步序号与 sink 位置 / 中立推理持久化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, writeOps } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'

const LEDGER = {
  version: 1,
  trace: { tail: null, count: 0 },
  evidence: { tail: null, count: 0 },
  proposals: { tail: null, count: 0 },
  verdicts: { tail: null, count: 0 },
}

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function traceEntry(value) {
  return writeOps(value).find((op) => op.op === 'put' && op.args.body.kind === 'trace')
}

function contract(id, { inputs = [], outputs = [], pre = 'always', post = 'always' } = {}) {
  return {
    contract_id: id,
    role_tag: id,
    inputs,
    outputs,
    reads: [],
    publishes: [],
    pre,
    post,
    refuses: [],
    effects: { ports: [], methods: [] },
    idempotent: true,
    touches_effects: false,
    can_delegate: false,
    cost: {},
  }
}

function port(name, { type = 'any', required = false, binding = 'all' } = {}) {
  return { name, type, required, cardinality: 1, binding_mode: binding }
}

function outport(name, type = 'any') {
  return { name, type, cardinality: 1 }
}

function instance(nodeId, contractId, extra = {}) {
  return { node_id: nodeId, contract_id: contractId, impl: 'atomic', bindings: {}, autonomy: 'L0', scope: { kind: 'global' }, ...extra }
}

function wrapper({ contracts = [], nodes = [], graph, thresholds = {} }) {
  const seed = seedModel()
  return {
    contracts: [...seed.contracts, ...contracts],
    nodes: [...seed.nodes, ...nodes],
    prompts: seed.prompts,
    graph,
    thresholds: { ...seed.thresholds, ...thresholds },
    refusal_codes: seed.refusalCodes,
  }
}

// ── G1 拓扑序 ───────────────────────────────────────────────────────────────

test('G1：节点数组非拓扑序（高下标源 → 低下标目标）仍按拓扑序全跑', async () => {
  const graph = {
    nodes: ['context.assemble', 'join', 'join', 'turn.commit'],
    edges: [
      { from: [0, 'messages'], to: [2, 'left'] },
      { from: [2, 'merged'], to: [1, 'right'] },
      { from: [1, 'merged'], to: [3, 'message'] },
    ],
    entry_supply: [{ type_id: 'task', role: 'task' }],
    loop: { when: '' },
    sink: 3,
  }
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph: wrapper({ graph }) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    const chosen = new Map(summary.instances.map((entry) => [entry[0], entry[1]]))
    assert.ok(chosen.has(2), '高下标源节点（join@2）必须执行')
    assert.ok(chosen.has(1), '低下标目标节点（join@1，源在其后）也必须执行')
    assert.equal(chosen.get(1), 'jn-global')
  } finally {
    service.close()
  }
})

// ── G6 运行期轻量闭合 ────────────────────────────────────────────────────────

test('G6：边越界 / 环 / required 输入未连 ⇒ 结构化拒绝，不静默误执行', async () => {
  const cases = [
    {
      name: 'edge_ref',
      graph: { nodes: ['context.assemble'], edges: [{ from: [0, 'messages'], to: [9, 'messages'] }], loop: { when: '' }, sink: 0 },
      code: 'edge_ref',
    },
    {
      name: 'cycle',
      graph: {
        nodes: ['context.assemble', 'join'],
        edges: [
          { from: [0, 'messages'], to: [1, 'left'] },
          { from: [1, 'merged'], to: [0, 'task'] },
        ],
        loop: { when: '' },
        sink: 1,
      },
      code: 'cycle',
    },
    {
      name: 'unconnected_input',
      graph: {
        nodes: ['context.assemble', 'subagent'],
        edges: [{ from: [0, 'messages'], to: [1, 'task'] }],
        loop: { when: '' },
        sink: 1,
      },
      code: 'unconnected_input',
    },
  ]
  for (const item of cases) {
    const service = startService()
    try {
      const result = await service.interpret({ turn_id: 't1', graph: wrapper({ graph: item.graph }) })
      const summary = summaryOf(result.value)
      assert.equal(summary.ended, 'refused', `${item.name}: ${JSON.stringify(summary)}`)
      assert.equal(summary.refused_at.code, item.code, `${item.name} 应为 ${item.code}`)
      assert.equal(summary.refused_at.attributable_to, 'graph')
    } finally {
      service.close()
    }
  }
})

// ── G5 分支互斥 + 真实 branch_not_taken ──────────────────────────────────────

test('G5：any 端口多条触发边只取声明序首个，其余确定性记为 branch_not_taken（含明细）', async () => {
  const fanin = contract('fanin', { inputs: [port('x', { binding: 'any' })], outputs: [outport('out')] })
  const build = () =>
    wrapper({
      contracts: [fanin],
      nodes: [instance('fanin-g', 'fanin')],
      graph: {
        nodes: ['context.assemble', 'join', 'join', 'fanin', 'turn.commit'],
        edges: [
          { from: [0, 'messages'], to: [1, 'left'] },
          { from: [0, 'params'], to: [2, 'left'] },
          { from: [1, 'merged'], to: [3, 'x'] },
          { from: [2, 'merged'], to: [3, 'x'] },
          { from: [3, 'out'], to: [4, 'message'] },
        ],
        loop: { when: '' },
        sink: 4,
      },
    })
  const first = startService()
  let summaryA
  let countA
  try {
    const result = await first.interpret({ turn_id: 't1', evolution: LEDGER, graph: build() })
    summaryA = summaryOf(result.value)
    assert.equal(summaryA.ended, 'done', JSON.stringify(summaryA))
    const entry = traceEntry(result.value).args.body
    const defeated = entry.branches_not_taken
    assert.deepEqual(
      defeated,
      [{ branch: '2:merged->3:x', node_index: 3, reason: 'any_defeated' }],
      '声明序首条被取，第二条记 defeated',
    )
    countA = summaryA.branch_not_taken
    assert.equal(typeof countA, 'number')
  } finally {
    first.close()
  }
  const second = startService()
  try {
    const result = await second.interpret({ turn_id: 't1', evolution: LEDGER, graph: build() })
    assert.equal(summaryOf(result.value).branch_not_taken, countA, 'branch_not_taken 必须确定性可复放')
  } finally {
    second.close()
  }
})

test('G5：同一输出端口两条互斥条件边同时触发 ⇒ redundant 拒绝（不激活两个下游）', async () => {
  const graph = {
    nodes: ['context.assemble', 'join', 'join', 'join', 'turn.commit'],
    edges: [
      { from: [0, 'messages'], to: [1, 'left'] },
      { from: [0, 'params'], to: [1, 'right'] },
      { from: [1, 'merged'], to: [2, 'left'], when: 'nonempty(merged)' },
      { from: [1, 'merged'], to: [3, 'left'], when: 'nonempty(merged)' },
      { from: [2, 'merged'], to: [4, 'message'] },
      { from: [3, 'merged'], to: [4, 'refusal'] },
    ],
    entry_supply: [{ type_id: 'task', role: 'task' }],
    loop: { when: '' },
    sink: 4,
  }
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', evolution: LEDGER, graph: wrapper({ graph }) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused', JSON.stringify(summary))
    assert.equal(summary.refused_at.code, 'redundant')
    assert.equal(summary.refused_at.node_index, 1)
    const chosen = new Set(summary.instances.map((entry) => entry[0]))
    assert.equal(chosen.has(2) && chosen.has(3), false, '过度触发的分支下游不得被激活')
  } finally {
    service.close()
  }
})

// ── G7 optional 输入 ─────────────────────────────────────────────────────────

test('G7：optional all 端口零触发（源已评估而未走）仍激活；required 同形则跳过', async () => {
  const optional = contract('opt.contract', { inputs: [port('x', { required: false })], outputs: [outport('out')] })
  const required = contract('req.contract', { inputs: [port('x', { required: true })], outputs: [outport('out')] })
  const build = (contractId, nodeId) =>
    wrapper({
      contracts: [optional, required],
      nodes: [instance(nodeId, contractId)],
      graph: {
        nodes: ['context.assemble', 'join', contractId, 'turn.commit'],
        edges: [
          { from: [0, 'messages'], to: [1, 'left'] },
          { from: [0, 'params'], to: [1, 'right'] },
          { from: [1, 'merged'], to: [2, 'x'], when: 'empty(merged)' },
          { from: [2, 'out'], to: [3, 'message'] },
        ],
        loop: { when: '' },
        sink: 3,
      },
    })
  const opt = startService()
  try {
    const result = await opt.interpret({ turn_id: 't1', graph: build('opt.contract', 'opt-node') })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.ok(new Map(summary.instances.map((e) => [e[0], e[1]])).has(2), 'optional 零触发仍应执行本节点')
  } finally {
    opt.close()
  }
  const req = startService()
  try {
    const result = await req.interpret({ turn_id: 't1', graph: build('req.contract', 'req-node') })
    const summary = summaryOf(result.value)
    assert.equal(new Map(summary.instances.map((e) => [e[0], e[1]])).has(2), false, 'required 零触发必须跳过')
  } finally {
    req.close()
  }
})

// ── G8 grant 维度合并 ────────────────────────────────────────────────────────

function approvalGrantProviders() {
  return {
    'model.chat': () => ({
      ok: true,
      text: '',
      tool_calls: [
        { id: 'c1', name: 'edit', args: { path: 'a.txt' } },
        { id: 'c2', name: 'fetch', args: {} },
      ],
      usage: {},
    }),
    'guard.judge': () => ({
      decisions: [
        { index: 0, port: 'tool', tool: 'edit', verdict: 'escalate', reason: 'outside_workspace', rule: 'a.txt' },
        { index: 1, port: 'tool', tool: 'fetch', verdict: 'escalate', reason: 'net_outside_tier', rule: 'limited' },
      ],
      summary: { allow: 0, escalate: 2, deny: 0 },
    }),
    'tool-dispatch.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: {} })) }),
  }
}

async function approvalGrantOf(providers) {
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({ turn_id: 't1' })
    cursor = first.portCalls.find((call) => call.method === 'enqueue')?.args?.cursor
    assert.ok(cursor, '审批挂起应落游标')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    await second.interpret({ turn_id: 't1', resume: { cursor, thread: 't1', payload: { verdict: 'approved' } } })
    const dispatchCall = second.portCalls.find((call) => call.port === 'tool-dispatch' && call.method === 'dispatch')
    return dispatchCall?.args?.grant ?? null
  } finally {
    second.close()
  }
}

test('G8：fs+net 混合升级 ⇒ grant 同时含 fs 与 net（首个升级非 net 也不丢 net）', async () => {
  const grant = await approvalGrantOf(approvalGrantProviders())
  assert.ok(grant, '批准后应签发 grant')
  assert.equal(grant.call_id, 'c1', '绑定决策序首个升级 call')
  assert.deepEqual(grant.fs, { write: 'full' }, 'edit 写档并集进 grant')
  assert.deepEqual(grant.paths, ['a.txt'])
  assert.equal(grant.net, 'limited', '首个升级项非 net，仍合并 net 维度')
  assert.equal(grant.op, 'write')
})

test('G8：net-only 升级 ⇒ op:exec + net', async () => {
  const providers = {
    'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'n1', name: 'fetch', args: {} }], usage: {} }),
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'fetch', verdict: 'escalate', reason: 'net_outside_tier', rule: 'all' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tool-dispatch.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: {} })) }),
  }
  const grant = await approvalGrantOf(providers)
  assert.ok(grant)
  assert.equal(grant.op, 'exec', 'net-only 无 fs op 映射时补 exec')
  assert.equal(grant.net, 'all')
  assert.equal(grant.fs, undefined)
})

// ── G9 步序号 + sink 位置 ────────────────────────────────────────────────────

test('G9：sink 不在最后时，步记录 (type,seq) 仍唯一（单调分配不撞键）', async () => {
  let step = 0
  const providers = {
    'model.chat': () => {
      step += 1
      if (step > 1) return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'tool-dispatch.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
  }
  const graph = {
    nodes: ['context.assemble', 'agent.step', 'tool.gate', 'tool.dispatch', 'turn.commit', 'join'],
    edges: [
      { from: [0, 'messages'], to: [1, 'messages'] },
      { from: [1, 'tool_calls'], to: [2, 'calls'], when: 'nonempty(tool_calls)' },
      { from: [1, 'message'], to: [4, 'message'], when: 'empty(tool_calls)' },
      { from: [2, 'verdict'], to: [3, 'verdict'], when: 'verdict_is(allow)' },
      { from: [3, 'results'], to: [4, 'results'], when: 'not wrote_files(results)' },
      { from: [3, 'results'], to: [5, 'left'], when: 'wrote_files(results)' },
      { from: [5, 'merged'], to: [4, 'report'] },
    ],
    entry_supply: [{ type_id: 'task', role: 'task' }],
    loop: { when: 'dispatched_tools_and_not_question_pending_or_verify_failed_or_todo_incomplete', max_iter: 'max_turn_iter' },
    sink: 4,
  }
  const service = startService({
    providers: {
      ...providers,
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1', tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }], graph: wrapper({ graph }) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    const records = service.portCalls
      .filter((call) => call.port === 'session' && call.method === 'step_append')
      .map((call) => call.args)
    assert.ok(records.length >= 3, '工具回合应落多条步记录')
    const keys = records.map((record) => `${record.type}:${record.seq}`)
    assert.equal(new Set(keys).size, keys.length, `步记录键必须唯一：${JSON.stringify(keys)}`)
  } finally {
    service.close()
  }
})

// ── item 8：中立推理持久化 ───────────────────────────────────────────────────

test('8：模型带 reasoning_blocks ⇒ step.result 持久化厂商中立 reasoning（展示 parts 不变）', async () => {
  const block = { provider: 'vendor', model: 'm1', form: 'text', payload: 'NEUTRAL-REASONING' }
  let step = 0
  const service = startService({
    providers: {
      'model.chat': () => {
        step += 1
        if (step > 1) return { ok: true, text: 'done', tool_calls: [], reasoning: 'display-2', reasoning_blocks: [block], usage: {} }
        return {
          ok: true,
          text: '先查',
          reasoning: 'display-1',
          reasoning_blocks: [block],
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt', old: 'x', new: 'y' } }],
          usage: {},
        }
      },
      'tool-dispatch.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(summaryOf(result.value).ended, 'done')
    const records = service.portCalls.filter((call) => call.port === 'session' && call.method === 'step_append').map((call) => call.args)
    const withResults = records.find((record) => record.type === 'step.result' && Array.isArray(record.tool_results) && record.tool_results.length > 0)
    assert.ok(withResults, '工具派发步应落盘')
    assert.deepEqual(withResults.reasoning, block, '中立推理块须随 step.result 持久化')
    // 展示侧仍取 display reasoning：增量落盘下推理段可能在其前的承接步里，跨步拼接取之。
    const display = records
      .filter((record) => record.type === 'step.result')
      .flatMap((record) => record.assistant?.parts ?? [])
      .find((part) => part.type === 'reasoning')
    assert.equal(display.text, 'display-1')
  } finally {
    service.close()
  }
})

test('8：纯文本回合的收口步也带中立推理块', async () => {
  const block = { provider: 'vendor', model: 'm1', form: 'text', payload: 'PLAIN-REASONING' }
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '答', reasoning: 'display', reasoning_blocks: [block], tool_calls: [], usage: {} }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1' })
    assert.equal(summaryOf(result.value).ended, 'done')
    const records = service.portCalls.filter((call) => call.port === 'session' && call.method === 'step_append').map((call) => call.args)
    const final = records.filter((record) => record.type === 'step.result').at(-1)
    assert.deepEqual(final.reasoning, block)
  } finally {
    service.close()
  }
})

// ── G2 composite 子图运行期展开 ──────────────────────────────────────────────

function compositeContract() {
  return contract('comp', { inputs: [port('messages', { type: 'messages' })], outputs: [outport('messages', 'messages')] })
}

function compositeNode() {
  return instance('cp-comp', 'comp', {
    impl: 'composite',
    subgraph: {
      nodes: ['context.assemble'],
      edges: [],
      entry_supply: [{ type_id: 'task', role: 'task' }],
      loop: { when: '' },
      sink: 0,
    },
  })
}

function compositeGraph() {
  return wrapper({
    contracts: [compositeContract()],
    nodes: [compositeNode()],
    graph: {
      nodes: ['context.assemble', 'comp', 'turn.commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'messages'] },
        { from: [1, 'messages'], to: [2, 'results'] },
      ],
      loop: { when: '' },
      sink: 2,
    },
  })
}

test('G2：单层 composite 展开 ⇒ 子图 sink 产出映射回声明 outputs，子图步带 parent_index', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', evolution: LEDGER, graph: compositeGraph() })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    // 子图节点步带 parent_index=1（composite 节点下标），保持可还原。
    const nested = summary.instances.filter((entry) => entry[2] === 1)
    assert.ok(nested.length >= 1, `应有带 parent_index 的子图步：${JSON.stringify(summary.instances)}`)
    const entry = traceEntry(result.value).args.body
    const nestedStep = entry.steps.find((step) => step.parent_index === 1)
    assert.ok(nestedStep, 'trace 步应带 parent_index')
    assert.equal(nestedStep.contract_id, 'context.assemble')
    // 映射结果经 commit.results 落盘（单输出缺名 ⇒ 整体包裹后投影 messages）。
    const records = service.portCalls.filter((call) => call.port === 'session' && call.method === 'step_append').map((call) => call.args)
    const final = records.filter((record) => record.type === 'step.result').at(-1)
    assert.deepEqual(final.tool_results, [{ role: 'user', content: 'hello' }], 'composite 输出消息应经映射写入收口步')
  } finally {
    service.close()
  }
})

test('G2：composite 展开确定性复放（同输入同 trace）', async () => {
  const run = async () => {
    const service = startService()
    try {
      const result = await service.interpret({ turn_id: 't1', evolution: LEDGER, graph: compositeGraph() })
      return traceEntry(result.value).args.body
    } finally {
      service.close()
    }
  }
  const a = await run()
  const b = await run()
  assert.deepEqual(a, b)
})

test('G2：composite 内嵌套 composite ⇒ 递归展开（外层→内层→原子），深度上限内成功', async () => {
  const inner = contract('comp.inner', { outputs: [outport('messages', 'messages')] })
  const outer = contract('comp.outer', { outputs: [outport('messages', 'messages')] })
  const nodes = [
    instance('cp-inner', 'comp.inner', {
      impl: 'composite',
      subgraph: { nodes: ['context.assemble'], edges: [], entry_supply: [{ type_id: 'task' }], loop: { when: '' }, sink: 0 },
    }),
    instance('cp-outer', 'comp.outer', {
      impl: 'composite',
      subgraph: { nodes: ['comp.inner'], edges: [], entry_supply: [{ type_id: 'task' }], loop: { when: '' }, sink: 0 },
    }),
  ]
  const graph = wrapper({
    contracts: [inner, outer],
    nodes,
    graph: {
      nodes: ['comp.outer', 'turn.commit'],
      edges: [{ from: [0, 'messages'], to: [1, 'results'] }],
      loop: { when: '' },
      sink: 1,
    },
  })
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', evolution: LEDGER, graph })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    const contracts = new Set(traceEntry(result.value).args.body.steps.map((step) => step.contract_id))
    assert.ok(contracts.has('comp.inner') && contracts.has('context.assemble'), '嵌套两层均须展开')
  } finally {
    service.close()
  }
})

test('G2：子图内拒绝 ⇒ 归因为 composite 节点（parent_index），code 原样传播', async () => {
  const needsInput = contract('needs.input', { inputs: [], outputs: [outport('out')], pre: 'inputs_ready' })
  const failComp = contract('fail.comp', { outputs: [outport('out')] })
  const graph = wrapper({
    contracts: [needsInput, failComp],
    nodes: [
      instance('needs-node', 'needs.input'),
      instance('cp-fail', 'fail.comp', {
        impl: 'composite',
        subgraph: { nodes: ['needs.input'], edges: [], entry_supply: [{ type_id: 'task' }], loop: { when: '' }, sink: 0 },
      }),
    ],
    graph: { nodes: ['fail.comp', 'turn.commit'], edges: [{ from: [0, 'out'], to: [1, 'results'] }], loop: { when: '' }, sink: 1 },
  })
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', evolution: LEDGER, graph })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused', JSON.stringify(summary))
    assert.equal(summary.refused_at.code, 'pre_unsat', '子图拒绝码原样传播')
    assert.equal(summary.refused_at.parent_index, 0, '拒绝归因到 composite 节点')
  } finally {
    service.close()
  }
})

test('G2：深度上限（max_subgraph_depth=1）⇒ 嵌套 composite 拒绝 max_recur', async () => {
  const inner = contract('deep.inner', { outputs: [outport('out')] })
  const outer = contract('deep.outer', { outputs: [outport('out')] })
  const graph = wrapper({
    contracts: [inner, outer],
    nodes: [
      instance('cp-deep-inner', 'deep.inner', {
        impl: 'composite',
        subgraph: { nodes: ['context.assemble'], edges: [], entry_supply: [{ type_id: 'task' }], loop: { when: '' }, sink: 0 },
      }),
      instance('cp-deep-outer', 'deep.outer', {
        impl: 'composite',
        subgraph: { nodes: ['deep.inner'], edges: [], entry_supply: [{ type_id: 'task' }], loop: { when: '' }, sink: 0 },
      }),
    ],
    graph: { nodes: ['deep.outer', 'turn.commit'], edges: [{ from: [0, 'out'], to: [1, 'results'] }], loop: { when: '' }, sink: 1 },
    thresholds: { max_subgraph_depth: 1 },
  })
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused', JSON.stringify(summary))
    assert.equal(summary.refused_at.code, 'max_recur')
  } finally {
    service.close()
  }
})

test('G2：gas 预算耗尽 ⇒ subgraph_incomplete（budget）', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', graph: compositeGraphWith({ gas: 0 }) })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused', JSON.stringify(summary))
    assert.equal(summary.refused_at.code, 'subgraph_incomplete')
    assert.equal(summary.outcome.attributableTo, 'budget')
  } finally {
    service.close()
  }
})

function compositeGraphWith(thresholds) {
  const graph = wrapper({
    contracts: [compositeContract()],
    nodes: [compositeNode()],
    graph: {
      nodes: ['context.assemble', 'comp', 'turn.commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'messages'] },
        { from: [1, 'messages'], to: [2, 'results'] },
      ],
      loop: { when: '' },
      sink: 2,
    },
    thresholds,
  })
  return graph
}
