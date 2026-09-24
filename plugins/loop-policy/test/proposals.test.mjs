// 提案扫描与采纳（§14）：机械闸 → shadow → approval → 采纳 / 拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, writeOps, writeBatches, assembleEvolutionBatch } from './driver.mjs'
import { H } from '../execute/hash.ts'
import { evolutionBody, ledgerEntries } from '../execute/proposals.ts'
import { seedModel } from '../execute/seed.ts'

test('evolutionBody：剔除入口切片并入的 refs（防每回合把闭包写回台账）', () => {
  const body = evolutionBody({
    evolution: {
      version: 1,
      trace: { tail: null, count: 0 },
      evidence: { tail: null, count: 0 },
      proposals: { tail: null, count: 0 },
      verdicts: { tail: null, count: 0 },
      refs: { ['a'.repeat(64)]: { kind: 'evidence' } },
    },
  })
  assert.equal(body['refs'], undefined)
  assert.equal(body['version'], 1)
  assert.deepEqual(body['trace'], { tail: null, count: 0 })
})

function ledgerBody(proposalHash, verdictCount = 0) {
  return {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: proposalHash === null ? null : { def: proposalHash }, count: proposalHash === null ? 0 : 1 },
    verdicts: { tail: null, count: verdictCount },
  }
}

/** 构造候选图 + 提案 + 台账 bag。 */
function buildBag({ withDerivedFrom = true } = {}) {
  const seed = seedModel()
  const candidate = JSON.parse(JSON.stringify(seed.graph))
  if (withDerivedFrom) candidate.derived_from = H(seed.graph)
  const graphHash = H(candidate)
  const proposal = {
    kind: 'proposal',
    id: 'pr-run-1-1',
    class: 'structure',
    evidence_ids: ['ev-1'],
    target: { graph: { def: graphHash }, contract_id: null, node_id: null },
    patch: { def: graphHash, graph: { def: graphHash }, writes: [] },
    by: 'evolve-loop',
    at: '2026-09-20T00:00:00.000Z',
    prev: null,
  }
  const proposalHash = H(proposal)
  const bag = {
    graph: {
      contracts: seed.contracts,
      nodes: seed.nodes,
      prompts: seed.prompts,
      graph: seed.graph,
      thresholds: seed.thresholds,
      refusal_codes: seed.refusalCodes,
    },
    pins: {
      session: 'session',
      model: 'model-protocol',
      context: 'context-window',
      retrieval: 'memory-retrieval',
      guard: 'guard',
      approval: 'approval',
      tools: 'tools',
      router: 'router',
      'evolve-metrics': 'evolve-metrics',
    },
    evolution: ledgerBody(proposalHash),
    refs: { [graphHash]: candidate, [proposalHash]: proposal },
    runs_since_fork: 10,
  }
  return { bag, graphHash, proposal }
}

test('提案扫描：机械闸通过 → shadow → orchestration_change 入人闸', async () => {
  const { bag, graphHash } = buildBag()
  const service = startService({
    providers: {
      'evolve-metrics.shadow': () => ({ status: 'pass', metric_id: 'metric-1' }),
    },
  })
  try {
    const result = await service.interpret(bag)
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const enqueue = service.portCalls.find((call) => call.port === 'approval' && call.method === 'enqueue')
    assert.ok(enqueue, '应入审批队列')
    assert.equal(enqueue.args.kind, 'orchestration_change')
    assert.equal(enqueue.args.cursor.kind, 'orchestration_change')
    assert.deepEqual(enqueue.args.cursor.proposal_ids, ['pr-run-1-1'])
    assert.deepEqual(enqueue.args.shadow, { def: 'metric-1' })
    assert.equal(enqueue.args.port, 'orchestration-admin')
    assert.match(graphHash, /^[0-9a-f]{64}$/)
  } finally {
    service.close()
  }
})

test('提案扫描：机械闸不过（无 derived_from）→ 落拒绝 verdict、不入人闸', async () => {
  const { bag } = buildBag({ withDerivedFrom: false })
  const service = startService()
  try {
    const result = await service.interpret(bag)
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.ok(!service.portCalls.some((call) => call.method === 'enqueue'), '不应入人闸')
    const verdict = writeOps(result.value).find((op) => op.op === 'put' && op.args.body.kind === 'verdict')
    assert.ok(verdict, '应落 verdict')
    assert.equal(verdict.args.body.result, 'rejected')
    assert.equal(verdict.args.body.gate.mechanical, 'fail')
    assert.equal(verdict.args.body.gate.reason, 'fork_only')
  } finally {
    service.close()
  }
})

test('补丁世代：同回合 trace + verdict 合并为单世代，组装结果 == 整份写入结果', async () => {
  const { bag } = buildBag({ withDerivedFrom: false })
  const service = startService()
  try {
    const full = await service.interpret(bag)
    const fullBatch = writeBatches(full.value).find((ops) => ops.some((op) => op.op === 'add_gen' && op.args.id === 'evolution'))
    assert.ok(fullBatch, '整份世代应产 evolution add_gen')
    const fullAssembled = assembleEvolutionBatch(fullBatch, evolutionBody({ evolution: bag.evolution }))
    assert.ok(fullAssembled.addGen, '整份世代应有 add_gen')
    assert.equal(fullAssembled.addGen.args.base, undefined, '无数据世代写整份')
    const fullBody = fullAssembled.body

    const withGen = { ...bag.evolution, data_gen: { seq: 2, payload: 'b'.repeat(64) } }
    const patched = await service.interpret({ ...bag, evolution: withGen })
    const ops = writeOps(patched.value)
    const patchPut = ops.find(
      (op) => op.op === 'put' && op.args.body?.ops?.some((patch) => patch.path?.[0] === 'verdicts'),
    )
    assert.ok(patchPut, '补丁世代应写补丁 def')
    const addGen = ops.filter((op) => op.op === 'add_gen' && op.args.id === 'evolution')
    assert.equal(addGen.length, 1, '同回合该身份只新增一个世代')
    assert.equal(addGen[0].args.base, 2, 'base 指向回合初数据世代')

    const baseBody = evolutionBody({ evolution: withGen })
    const base = evolutionBody({ evolution: bag.evolution })
    const patchedBatch = writeBatches(patched.value).find((batch) => batch.some((op) => op.op === 'add_gen' && op.args.id === 'evolution'))
    const assembled = assembleEvolutionBatch(patchedBatch, baseBody)
    assert.deepEqual(assembled.body, fullBody, 'base + 补丁组装结果 == 整份写入结果')
    // 补丁同时覆盖本回合改动的两个槽；未改动槽（evidence / proposals）保持回合初值。
    assert.deepEqual(patchPut.args.body.ops.map((patch) => patch.path[0]), ['trace', 'verdicts'])
    assert.deepEqual(assembled.body.evidence, base.evidence)
    assert.deepEqual(assembled.body.proposals, base.proposals)
  } finally {
    service.close()
  }
})

test('同回合两提案拒绝：两条 verdict 经 prev 链均可 ledgerEntries 到达、只新增一个世代', async () => {
  const seed = seedModel()
  const candidate = JSON.parse(JSON.stringify(seed.graph))
  const graphHash = H(candidate)
  const proposalOf = (id, prev) => ({
    kind: 'proposal',
    id,
    class: 'structure',
    evidence_ids: [],
    target: { graph: { def: graphHash }, contract_id: null, node_id: null },
    patch: { def: graphHash, graph: { def: graphHash }, writes: [] },
    by: 'evolve-loop',
    at: '2026-09-20T00:00:00.000Z',
    prev,
  })
  const first = proposalOf('pr-a', null)
  const firstHash = H(first)
  const second = proposalOf('pr-b', { def: firstHash })
  const secondHash = H(second)
  const evolution = {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: { def: secondHash }, count: 2 },
    verdicts: { tail: null, count: 0 },
    data_gen: { seq: 3, payload: 'c'.repeat(64) },
  }
  const bag = {
    graph: {
      contracts: seed.contracts,
      nodes: seed.nodes,
      prompts: seed.prompts,
      graph: seed.graph,
      thresholds: seed.thresholds,
      refusal_codes: seed.refusalCodes,
    },
    evolution,
    refs: { [graphHash]: candidate, [firstHash]: first, [secondHash]: second },
  }
  const service = startService()
  try {
    const result = await service.interpret(bag)
    const batch = writeBatches(result.value).find((ops) => ops.some((op) => op.op === 'add_gen' && op.args.id === 'evolution'))
    assert.ok(batch, '应产 evolution 世代')
    const addGens = batch.filter((op) => op.op === 'add_gen' && op.args.id === 'evolution')
    assert.equal(addGens.length, 1, '同回合两提案只新增一个世代')
    assert.equal(addGens[0].args.base, 3)
    const assembled = assembleEvolutionBatch(batch, evolutionBody({ evolution }))
    assert.equal(assembled.body.verdicts.count, 2, '两条 verdict 都进槽')
    // 用组装后的 body + 同批 defs 作闭包，验证 prev 链两条都可到达。
    const ledger = { evolution: { ...assembled.body, refs: assembled.defs }, refs: assembled.defs }
    const verdicts = ledgerEntries(ledger, 'verdicts')
    assert.equal(verdicts.length, 2, '两条 verdict 均经 prev 链可达')
    const ids = new Set(verdicts.flatMap((verdict) => verdict.proposal_ids ?? []))
    assert.deepEqual([...ids].sort(), ['pr-a', 'pr-b'])
    assert.equal(verdicts[0].prev.def, H({ body: verdicts[1] }), 'prev 指向上一登记 verdict')
    assert.equal(verdicts[1].prev, null, '首条 prev 回落到回合初 tail(null)')
  } finally {
    service.close()
  }
})

test('提案扫描：shadow 返回的 $directives 并入落账计划，指标 def 可解析（非孤儿）', async () => {
  const { bag } = buildBag()
  const metricDef = { kind: 'shadow_metric', status: 'pass', expected: 0, matched: 0 }
  const metricId = H({ body: metricDef })
  const service = startService({
    providers: {
      'evolve-metrics.shadow': () => ({
        status: 'pass',
        metric_id: metricId,
        $directives: [
          { kind: 'write', request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: metricDef } }] } } },
        ],
      }),
    },
  })
  try {
    const result = await service.interpret(bag)
    const enqueue = service.portCalls.find((call) => call.port === 'approval' && call.method === 'enqueue')
    assert.equal(enqueue.args.shadow.def, metricId, '队列项应引用 shadow 指标 def')
    const ops = writeOps(result.value)
    const put = ops.find((op) => op.op === 'put' && op.args.body.kind === 'shadow_metric')
    assert.ok(put, `shadow 计划应并入落账计划：${JSON.stringify(ops)}`)
    assert.equal(H({ body: put.args.body }), metricId, 'metric_id 必须等于同批 put 的 def 键')
  } finally {
    service.close()
  }
})
test('采纳续跑：approved ⇒ add_gen(loop-policy) + accepted verdict', async () => {
  const { bag, graphHash } = buildBag()
  const service = startService()
  try {
    const result = await service.interpret({
      ...bag,
      resume: { cursor: { kind: 'orchestration_change', proposal_ids: ['pr-run-1-1'] }, thread: 't1', payload: { verdict: 'approved' } },
    })
    const ops = writeOps(result.value)
    const addGen = ops.find((op) => op.op === 'add_gen' && op.args.id === 'loop-policy')
    assert.ok(addGen, '应 add_gen loop-policy')
    assert.deepEqual(addGen.args.payload, { def: graphHash })
    const verdict = ops.find((op) => op.op === 'put' && op.args.body.kind === 'verdict')
    assert.equal(verdict.args.body.result, 'accepted')
    assert.equal(verdict.args.body.gate.human, 'approved')
  } finally {
    service.close()
  }
})

test('采纳续跑：denied ⇒ rejected verdict', async () => {
  const { bag } = buildBag()
  const service = startService()
  try {
    const result = await service.interpret({
      ...bag,
      resume: { cursor: { kind: 'orchestration_change', proposal_ids: ['pr-run-1-1'] }, thread: 't1', payload: { verdict: 'denied' } },
    })
    const ops = writeOps(result.value)
    assert.ok(!ops.some((op) => op.op === 'add_gen' && op.args.id === 'loop-policy'))
    const verdict = ops.find((op) => op.op === 'put' && op.args.body.kind === 'verdict')
    assert.equal(verdict.args.body.result, 'rejected')
    assert.equal(verdict.args.body.gate.human, 'denied')
  } finally {
    service.close()
  }
})
