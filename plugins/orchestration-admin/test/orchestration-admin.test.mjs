// `orchestration-admin` 服务协议级测试（node --test）：自实现最小协议驱动，覆盖
// list / read 只读、validate 六不变量 + 四规则逐类违反、propose 四硬约束与计划形状、
// describe 四要素、invoke 派发；并断言服务不发 eff / 不产证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { H } from '../execute/hash.ts'
import {
  bag,
  clone,
  contracts,
  forkBag,
  graph,
  nodes,
  pins,
  thresholds,
} from './fixtures.mjs'
// 红线断言（包形状）；本包 test 脚本按文件显式列出，故在此引入使其随 npm test 执行。
import './package.test.mjs'

function errorsOf(value) {
  return value.errors.map((error) => error.code)
}

/** 变体：把某个契约的 effects.ports / entry.cap 改掉。 */
function withContract(overrides, contractId, mutate) {
  const list = overrides.contracts ?? contracts()
  const target = list.find((contract) => contract.contract_id === contractId)
  mutate(target)
  return { ...overrides, contracts: list }
}

function withNode(overrides, nodeId, mutate) {
  const list = overrides.nodes ?? nodes()
  const target = list.find((node) => node.node_id === nodeId)
  mutate(target)
  return { ...overrides, nodes: list }
}

async function callValue(drv, port, method, args) {
  const message = await drv.call(port, method, args)
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

// ── 握手 / 控制 / 自退出 ────────────────────────────────────────────────────

test('hello 回 manifest：双能力类与方法声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'orchestration-admin')
    assert.deepEqual(manifest.implements, ['orchestration', 'orchestration-admin'])
    assert.deepEqual(manifest.methods.orchestration, ['list', 'read', 'validate', 'propose'])
    assert.deepEqual(manifest.methods['orchestration-admin'], ['describe', 'invoke'])
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('probe → pong / drain → bye / stdin EOF 自退出', async () => {
  const drv = startService()
  await drv.hello()
  assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
  assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  await drv.exit
})

// ── list / read（只读） ─────────────────────────────────────────────────────

test('list：回 Scope 概览 + 契约清单 + 阈值表，且不发 eff / 无写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await callValue(drv, 'orchestration', 'list', forkBag())
    assert.equal(value.graph_present, true)
    assert.equal(value.graph.node_count, 3)
    assert.equal(value.graph.sink, 2)
    assert.equal(value.scopes.length, 5)
    const step = value.scopes.find((scope) => scope.contract_id === 'step')
    assert.equal(step.node_index, 1)
    assert.equal(step.impl, 'atomic')
    assert.equal(step.scope.kind, 'global')
    assert.ok(value.contracts.some((contract) => contract.contract_id === 'join'))
    assert.equal(value.thresholds.llm_chain_max, 2)
    assert.equal(value.$directives, undefined)
    assert.equal(drv.portCalls.length, 0, 'list 不得发反向调用')
    assert.equal(drv.events.length, 0, 'list 不得发事件')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('read：按 kind + target 读契约 / 图全文，附关联证据摘要', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const contract = await callValue(drv, 'orchestration', 'read', {
      ...forkBag(),
      kind: 'contract',
      target: 'step',
    })
    assert.equal(contract.entry.contract_id, 'step')
    const graphEntry = await callValue(drv, 'orchestration', 'read', {
      ...forkBag(),
      kind: 'graph',
      target: '',
    })
    assert.equal(graphEntry.entry.sink, 2)
    const missing = await drv.call('orchestration', 'read', {
      ...forkBag(),
      kind: 'contract',
      target: 'nope',
    })
    assert.equal(missing.kind, 'result')
    assert.equal(missing.value.ok, false)
    assert.equal(missing.value.error.code, 'not_found')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── validate：合法图 + 结果哈希稳定 ─────────────────────────────────────────

test('validate：合法 fork 图通过，结果哈希稳定', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const input = forkBag()
    const first = await callValue(drv, 'orchestration', 'validate', input)
    const second = await callValue(drv, 'orchestration', 'validate', input)
    assert.equal(first.ok, true, JSON.stringify(first.errors))
    assert.deepEqual(first.errors, [])
    assert.match(first.result_hash, /^[0-9a-f]{64}$/)
    assert.equal(first.result_hash, second.result_hash)
    assert.equal(drv.portCalls.length, 0, 'validate 不得 eff #33')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── validate：六条不变量逐类违反 ────────────────────────────────────────────

test('validate：缺兜底首节点 → missing_fallback_entry', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = contracts()
    for (const contract of base) contract.touches_effects = true
    const value = await callValue(drv, 'orchestration', 'validate', bag({ contracts: base }))
    assert.ok(errorsOf(value).includes('missing_fallback_entry'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：缺 join / subagent 契约 → missing_join_contract / missing_subagent_contract', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const noJoin = contracts().filter((contract) => contract.contract_id !== 'join')
    const joinValue = await callValue(drv, 'orchestration', 'validate', bag({ contracts: noJoin }))
    assert.ok(errorsOf(joinValue).includes('missing_join_contract'))
    const noSub = contracts().filter((contract) => contract.contract_id !== 'subagent')
    const subValue = await callValue(drv, 'orchestration', 'validate', bag({ contracts: noSub }))
    assert.ok(errorsOf(subValue).includes('missing_subagent_contract'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：高危端口无 guard→approval 段 → approval_bypass', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const overrides = withContract({}, 'commit', (contract) => {
      contract.effects.ports = ['exec']
    })
    const overrides2 = withNode(overrides, 'nd-commit', (node) => {
      node.entry = { cap: 'exec', method: 'run' }
    })
    const input = bag({ ...overrides2, pins: { ...pins(), exec: 'sandbox' } })
    const value = await callValue(drv, 'orchestration', 'validate', input)
    assert.ok(errorsOf(value).includes('approval_bypass'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：三 LLM 串联 → llm_chain_max', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = contracts()
    const step = base.find((contract) => contract.contract_id === 'step')
    for (const id of ['step2', 'step3']) {
      const cloneStep = clone(step)
      cloneStep.contract_id = id
      cloneStep.inputs = [{ name: 'message', type: 'message', required: true, cardinality: 1, binding_mode: 'all' }]
      base.push(cloneStep)
    }
    const nodeList = nodes()
    const stepNode = nodeList.find((node) => node.contract_id === 'step')
    for (const id of ['step2', 'step3']) {
      const cloneNode = clone(stepNode)
      cloneNode.node_id = `nd-${id}`
      cloneNode.contract_id = id
      nodeList.push(cloneNode)
    }
    const chain = {
      nodes: ['assemble', 'step', 'step2', 'step3', 'commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'messages'] },
        { from: [1, 'message'], to: [2, 'message'] },
        { from: [2, 'message'], to: [3, 'message'] },
        { from: [3, 'message'], to: [4, 'message'] },
      ],
      entry_supply: [{ type_id: 'task' }],
      loop: { when: 'always', max_iter: 'max_turn_iter' },
      sink: 4,
      derived_from: null,
    }
    const value = await callValue(
      drv,
      'orchestration',
      'validate',
      bag({ contracts: base, nodes: nodeList, graphBody: chain }),
    )
    assert.ok(errorsOf(value).includes('llm_chain_max'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：图内契约无 global 实例 → last_global_instance', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const nodeList = nodes()
    for (const node of nodeList) {
      if (['assemble', 'step', 'commit'].includes(node.contract_id)) node.scope = { kind: 'workspace', workspace_id: 'w1' }
    }
    const value = await callValue(drv, 'orchestration', 'validate', bag({ nodes: nodeList }))
    assert.ok(errorsOf(value).includes('last_global_instance'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：端口 ⊄ pins → port_not_pinned', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const reduced = pins()
    delete reduced.model
    const value = await callValue(drv, 'orchestration', 'validate', bag({ pins: reduced }))
    assert.ok(errorsOf(value).includes('port_not_pinned'))
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── validate：闭合 / 类型 / 四演化规则 ──────────────────────────────────────

test('validate：环 / required 未连 / 边越界 → cycle / unconnected_input / edge_ref', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const cyclic = graph(null)
    cyclic.edges.push({ from: [1, 'message'], to: [0, 'messages'] })
    const cycleValue = await callValue(drv, 'orchestration', 'validate', bag({ graphBody: cyclic }))
    assert.ok(errorsOf(cycleValue).includes('cycle'))

    const disconnected = graph(null)
    disconnected.edges = [{ from: [1, 'message'], to: [2, 'message'] }]
    const unconnected = await callValue(drv, 'orchestration', 'validate', bag({ graphBody: disconnected }))
    assert.ok(errorsOf(unconnected).includes('unconnected_input'))

    const outOfRange = graph(null)
    outOfRange.edges.push({ from: [0, 'messages'], to: [9, 'messages'] })
    const edgeValue = await callValue(drv, 'orchestration', 'validate', bag({ graphBody: outOfRange }))
    assert.ok(errorsOf(edgeValue).includes('edge_ref'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：publish 偏序 / 类型不兼容', async () => {
  const drv = startService()
  try {
    await drv.hello()
    // 两条并行分支各自发布同一 shared 键 ⇒ 无拓扑偏序
    const base = contracts()
    const step = base.find((contract) => contract.contract_id === 'step')
    step.publishes = ['shared:x']
    const step2 = clone(step)
    step2.contract_id = 'step2'
    base.push(step2)
    const nodeList = nodes()
    const stepNode = nodeList.find((node) => node.contract_id === 'step')
    const stepNode2 = clone(stepNode)
    stepNode2.node_id = 'nd-step2'
    stepNode2.contract_id = 'step2'
    nodeList.push(stepNode2)
    const parallel = {
      nodes: ['assemble', 'step', 'step2', 'commit'],
      edges: [
        { from: [0, 'messages'], to: [1, 'messages'] },
        { from: [0, 'messages'], to: [2, 'messages'] },
        { from: [1, 'message'], to: [3, 'message'] },
        { from: [2, 'message'], to: [3, 'message'] },
      ],
      entry_supply: [{ type_id: 'task' }],
      loop: { when: 'always', max_iter: 'max_turn_iter' },
      sink: 3,
      derived_from: null,
    }
    const publish = await callValue(
      drv,
      'orchestration',
      'validate',
      bag({ contracts: base, nodes: nodeList, graphBody: parallel }),
    )
    assert.ok(errorsOf(publish).includes('publish_order'))

    // 类型不兼容：commit 的输入类型与 step 输出不同
    const typed = withContract({}, 'commit', (contract) => {
      contract.inputs[0].type = 'text'
    })
    const mismatch = await callValue(drv, 'orchestration', 'validate', bag(typed))
    assert.ok(errorsOf(mismatch).includes('type_mismatch'))
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate：fork-only / diff 上限 / min_runs_before_fork', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const noFork = await callValue(drv, 'orchestration', 'validate', bag({ graphBody: graph(null) }))
    assert.ok(errorsOf(noFork).includes('fork_only'))

    const active = { nodes: [], edges: [], sink: 0 }
    const candidate = graph(H(active))
    const diffValue = await callValue(
      drv,
      'orchestration',
      'validate',
      bag({ graphBody: candidate, activeGraph: active, thresholds: thresholds({ max_graph_diff: 0 }) }),
    )
    assert.ok(errorsOf(diffValue).includes('diff_exceeded'))

    const runsValue = await callValue(
      drv,
      'orchestration',
      'validate',
      forkBag({ runsSinceFork: 1, thresholds: thresholds({ min_runs_before_fork: 3 }) }),
    )
    assert.ok(errorsOf(runsValue).includes('min_runs_before_fork'))
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── propose：四硬约束 ───────────────────────────────────────────────────────

test('propose：合法提案产计划（先 put def 再 add_gen），且不含证据', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = forkBag()
    const validated = await callValue(drv, 'orchestration', 'validate', base)
    const input = {
      ...base,
      class: 'structure',
      evidence_ids: ['ev-1'],
      validate_hash: validated.result_hash,
      writes: [{ identity: 'agents', payload: { note: 'persona' } }],
    }
    const plan = await callValue(drv, 'orchestration', 'propose', input)
    assert.equal(plan.$directives[0].kind, 'write')
    const ops = plan.$directives[0].request.args.ops
    assert.equal(ops[0].op, 'put') // 候选图 def 先落
    assert.equal(ops[1].op, 'put') // 跨身份 payload def
    // put 形状：def 内容必须包在 `body`（与内核 put 形状 / 投影 `def.body` 口径一致）。
    assert.deepEqual(ops[0].args.body, base.graph.graph)
    assert.deepEqual(ops[1].args.body, { note: 'persona' })
    const proposalOp = ops.find((op) => op.args && op.args.body && op.args.body.kind === 'proposal')
    assert.ok(proposalOp, '缺 proposal 条目')
    assert.equal(proposalOp.args.body.class, 'structure')
    assert.deepEqual(proposalOp.args.body.evidence_ids, ['ev-1'])
    assert.equal(proposalOp.args.body.patch.def, H({ body: base.graph.graph }))
    // target.graph.def 是 active 图 def 的键：口径 = H({body:active_graph})，与 patch.def / 投影 markerHash 一致。
    assert.equal(proposalOp.args.body.target.graph.def, H({ body: base.active_graph }))
    assert.equal(proposalOp.args.body.patch.writes[0].identity, 'agents')
    assert.equal(proposalOp.args.body.patch.writes[0].payload.def, H({ body: { note: 'persona' } }))
    assert.equal(ops[ops.length - 1].op, 'add_gen')
    assert.equal(ops[ops.length - 1].args.id, 'evolution')
    assert.equal(ops.filter((op) => op.op === 'add_gen').length, 1, '只对 #43 台账 add_gen')
    // 分签红线：输出里只有 proposal 条目，不含 evidence。
    assert.equal(ops.some((op) => op.args && op.args.body && op.args.body.kind === 'evidence'), false)
    // 落同一 tail：新 evolution body 的 proposals.tail 指向新提案、count+1。
    assert.equal(proposalOp.args.body.prev, null)
    const bodyOp = ops.find((op) => op.args && op.args.body && op.args.body.proposals && op.args.body.proposals.tail)
    assert.equal(bodyOp.args.body.proposals.tail.def, H({ body: proposalOp.args.body }))
    assert.equal(bodyOp.args.body.proposals.count, 1)
    assert.equal(plan.$directives[1].kind, 'extern')
    assert.equal(plan.$directives[1].payload.ok, true)
  } finally {
    drv.close()
    await drv.exit
  }
})

test('propose：用户请求（by=user）走同一 tail、同一门禁，不占条数额度', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = forkBag()
    const validated = await callValue(drv, 'orchestration', 'validate', base)
    const plan = await callValue(drv, 'orchestration', 'propose', {
      ...base,
      class: 'binding',
      evidence_ids: ['ev-user'],
      by: 'user',
      run_proposal_count: 99,
      validate_hash: validated.result_hash,
    })
    const ops = plan.$directives[0].request.args.ops
    const proposal = ops.find((op) => op.args && op.args.body && op.args.body.kind === 'proposal')
    assert.equal(proposal.args.body.by, 'user')
    assert.equal(plan.$directives[1].payload.by, 'user')
    assert.equal(ops[ops.length - 1].args.id, 'evolution')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('propose：缺证据 / 缺 validate 哈希 / 哈希不符 / 空白整图 / 变更类非法 / 超额 各拒', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const base = forkBag()
    const validated = await callValue(drv, 'orchestration', 'validate', base)
    const good = {
      ...base,
      class: 'structure',
      evidence_ids: ['ev-1'],
      validate_hash: validated.result_hash,
    }

    const noEvidence = await drv.call('orchestration', 'propose', { ...good, evidence_ids: [] })
    assert.equal(noEvidence.kind, 'error')
    assert.equal(noEvidence.code, 'evidence_required')

    const noHash = await drv.call('orchestration', 'propose', { ...good, validate_hash: undefined })
    assert.equal(noHash.code, 'validate_required')

    const badHash = await drv.call('orchestration', 'propose', { ...good, validate_hash: 'f'.repeat(64) })
    assert.equal(badHash.code, 'validate_required')

    const blank = await drv.call('orchestration', 'propose', {
      ...good,
      graph: { ...base.graph, graph: { ...graph(H(base.active_graph)), nodes: [] } },
    })
    assert.equal(blank.code, 'fork_required')

    const badClass = await drv.call('orchestration', 'propose', { ...good, class: 'nope' })
    assert.equal(badClass.code, 'bad_change_class')

    const quota = await drv.call('orchestration', 'propose', { ...good, run_proposal_count: 4 })
    assert.equal(quota.code, 'quota_exceeded')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── describe / invoke ───────────────────────────────────────────────────────

test('describe：四工具 + 描述四要素 + render（solid）+ caps 含 fs.read / net 字符串', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await callValue(drv, 'orchestration-admin', 'describe', {})
    assert.deepEqual(
      value.tools.map((tool) => tool.name),
      ['orchestration.list', 'orchestration.read', 'orchestration.validate', 'orchestration.propose'],
    )
    for (const tool of value.tools) {
      for (const field of ['intent', 'when_to_use', 'param_semantics', 'boundaries']) {
        assert.ok(tool[field] !== undefined, `${tool.name} 缺 ${field}`)
      }
      for (const key of tool.argsSchema.required ?? []) {
        assert.ok(tool.param_semantics[key] !== undefined, `${tool.name} param_semantics 缺 ${key}`)
      }
      assert.equal(tool.render.form, 'card')
      assert.equal(tool.render.label, 'orchestration')
      assert.equal(tool.render.tone, 'solid')
      assert.equal(typeof tool.caps.fs.read, 'string')
      assert.equal(typeof tool.caps.net, 'string')
    }
    assert.equal(value.tools.find((tool) => tool.name === 'orchestration.propose').idempotent, false)
    assert.equal(value.tools.find((tool) => tool.name === 'orchestration.propose').render.detail.kind, 'diff')
  } finally {
    drv.close()
    await drv.exit
  }
})

test('invoke：按工具名派发到 orchestration.*；未知工具 unknown_tool', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const listed = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.list',
      args: forkBag(),
    })
    assert.equal(listed.ok, true)
    assert.equal(listed.result.graph.node_count, 3)

    const unknown = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.nope',
      args: {},
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_tool')

    const base = forkBag()
    const validated = await callValue(drv, 'orchestration', 'validate', base)
    const proposed = await callValue(drv, 'orchestration-admin', 'invoke', {
      tool: 'orchestration.propose',
      args: { ...base, class: 'binding', evidence_ids: ['ev-9'], validate_hash: validated.result_hash },
    })
    assert.equal(proposed.ok, true)
    assert.equal(proposed.result.$directives[0].request.op, 'batch')
  } finally {
    drv.close()
    await drv.exit
  }
})

// ── 结构化错误 ─────────────────────────────────────────────────────────────

test('未知能力 / 方法 / 非对象 args → 结构化错误，不崩进程', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const badPort = await drv.call('nope', 'list', {})
    assert.equal(badPort.code, 'unresolved_cap')
    const badMethod = await drv.call('orchestration', 'nope', {})
    assert.equal(badMethod.code, 'unknown_method')
    const badArgs = await drv.call('orchestration', 'list', 'not-an-object')
    assert.equal(badArgs.code, 'bad_args')
    const ok = await callValue(drv, 'orchestration', 'list', forkBag())
    assert.equal(ok.ok, true)
  } finally {
    drv.close()
    await drv.exit
  }
})
