// 接缝契约：`loop-policy` 产出的 evolution 写计划必须能被真实内核落账、被真实宿主投影组装。
// 插件把同回合的 trace / verdict 攒成单个补丁世代；内核负责批内 `$n` 替换与落账，
// 宿主投影负责按 base + 补丁组装出最终 body。两侧语义只在冻结层实现，测试不得就地复刻。
// 故本文件住根 tests/contract/，import 真实 packages/kernel 与 packages/host。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, writeBatches } from '../../plugins/loop-policy/test/driver.mjs'
import { H } from '../../plugins/loop-policy/execute/hash.ts'
import { evolutionBody, ledgerEntries } from '../../plugins/turn-ledger/execute/proposals.ts'
import { seedModel } from '../../plugins/loop-policy/execute/seed.ts'
import { commit, EMPTY_HEAD, H as kernelHash } from '../../packages/kernel/index.ts'
import { assembleIdentityBody } from '../../packages/host/projection/index.ts'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 预置 `evolution` 身份：base 回合初 body 作为数据世代，供内核在其上应用补丁世代。 */
function evolutionWorld(baseSeq, baseBody) {
  const defs = {}
  const identity = { id: 'evolution', schema: null, active: null, gens: [], born: { at: 0, by: 'test' } }
  if (baseSeq !== null && baseBody !== undefined) {
    const baseHash = kernelHash({ body: baseBody })
    defs[baseHash] = { body: baseBody }
    for (let index = 0; index <= baseSeq; index += 1) {
      identity.gens.push({
        seq: index,
        payload: baseHash,
        pins: {},
        sig: baseHash,
        adopted: { at: 0, by: 'test', write: baseHash },
      })
    }
    identity.active = baseHash
  }
  return { defs, ids: { evolution: identity } }
}

/** 把插件产出的 evolution batch 经真实内核落账，再用真实宿主投影组装回 body。 */
function assembleViaLayers(batch, baseSeq, baseBody) {
  const world = evolutionWorld(baseSeq, baseBody)
  const outcome = commit(
    EMPTY_HEAD,
    world,
    { id: 'evo-batch', op: 'batch', target: { expect_pos: null }, args: { ops: batch }, by: 'test' },
    1_700_000_000_000,
  )
  assert.equal(outcome.verdict.ok, true, JSON.stringify(outcome.verdict))
  const refs = {}
  for (const [hash, def] of Object.entries(world.defs)) refs[hash] = def.body
  return { body: assembleIdentityBody(world, 'evolution'), refs }
}

/** 构造候选图 + 提案 + 台账 bag。 */
function buildBag({ withDerivedFrom = true } = {}) {
  const seed = seedModel()
  const candidate = clone(seed.graph)
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
    evolution: {
      version: 1,
      trace: { tail: null, count: 0 },
      evidence: { tail: null, count: 0 },
      proposals: { tail: proposalHash === null ? null : { def: proposalHash }, count: proposalHash === null ? 0 : 1 },
      verdicts: { tail: null, count: 0 },
    },
    refs: { [graphHash]: candidate, [proposalHash]: proposal },
    runs_since_fork: 10,
  }
  return { bag, graphHash, proposal }
}

function evolutionBatchOf(value) {
  const batch = writeBatches(value).find((ops) =>
    ops.some((op) => op.op === 'add_gen' && op.args.id === 'evolution'),
  )
  assert.ok(batch, '应产 evolution 世代')
  return batch
}

test('组装：base + 补丁经真实内核与宿主投影后 == 整份写入结果', async () => {
  const { bag } = buildBag({ withDerivedFrom: false })
  const service = startService()
  try {
    const full = await service.interpret(bag)
    const fullBatch = evolutionBatchOf(full.value)
    // I13：插件写计划里的 `$n` 占位符必须由真实内核解析，测试不得就地复刻该语义。
    assert.ok(JSON.stringify(fullBatch).includes('"$n"'), '插件写计划须含内核占位符 $n')
    const fullAssembled = assembleViaLayers(fullBatch, null, undefined)
    assert.ok(fullAssembled.body !== null, '整份世代应可组装')
    assert.equal(JSON.stringify(fullAssembled.body).includes('"$n"'), false, '真实内核须解析全部 $n 占位符')

    const withGen = { ...bag.evolution, data_gen: { seq: 2, payload: 'b'.repeat(64) } }
    const patched = await service.interpret({ ...bag, evolution: withGen })
    const baseBody = evolutionBody({ evolution: withGen })
    const patchedAssembled = assembleViaLayers(evolutionBatchOf(patched.value), 2, baseBody)

    assert.deepEqual(patchedAssembled.body, fullAssembled.body, 'base + 补丁组装结果 == 整份写入结果')
    // 未改动槽（evidence / proposals）保持回合初值。
    const base = evolutionBody({ evolution: bag.evolution })
    assert.deepEqual(patchedAssembled.body.evidence, base.evidence)
    assert.deepEqual(patchedAssembled.body.proposals, base.proposals)
  } finally {
    service.close()
  }
})

test('组装：同回合两提案拒绝，两条 verdict 经 prev 链均可 ledgerEntries 到达', async () => {
  const seed = seedModel()
  const candidate = clone(seed.graph)
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
    const batch = evolutionBatchOf(result.value)
    const addGens = batch.filter((op) => op.op === 'add_gen' && op.args.id === 'evolution')
    assert.equal(addGens.length, 1, '同回合两提案只新增一个世代')
    assert.equal(addGens[0].args.base, 3)

    const assembled = assembleViaLayers(batch, 3, evolutionBody({ evolution }))
    assert.equal(assembled.body.verdicts.count, 2, '两条 verdict 都进槽')
    const ledger = { evolution: { ...assembled.body, refs: assembled.refs }, refs: assembled.refs }
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

test('组装：同回合 trace + verdict 合并，组装 body 同时含新 trace 与新 verdicts', async () => {
  const seed = seedModel()
  const candidate = clone(seed.graph)
  const graphHash = H(candidate)
  const proposal = {
    kind: 'proposal',
    id: 'pr-1',
    class: 'structure',
    evidence_ids: [],
    target: { graph: { def: graphHash }, contract_id: null, node_id: null },
    patch: { def: graphHash, graph: { def: graphHash }, writes: [] },
    by: 'evolve-loop',
    at: '2026-09-20T00:00:00.000Z',
    prev: null,
  }
  const proposalHash = H(proposal)
  const evolution = {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: { def: proposalHash }, count: 1 },
    verdicts: { tail: null, count: 0 },
    data_gen: { seq: 4, payload: 'a'.repeat(64) },
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
    refs: { [graphHash]: candidate, [proposalHash]: proposal },
  }
  const service = startService()
  try {
    const result = await service.interpret(bag)
    const batch = evolutionBatchOf(result.value)
    const assembled = assembleViaLayers(batch, 4, evolutionBody({ evolution }))
    assert.equal(assembled.body.trace.count, 1, '组装 body 含新 trace')
    assert.equal(assembled.body.verdicts.count, 1, '组装 body 含新 verdicts')
    const ledger = { evolution: { ...assembled.body, refs: assembled.refs }, refs: assembled.refs }
    assert.equal(ledgerEntries(ledger, 'trace').length, 1)
    assert.equal(ledgerEntries(ledger, 'verdicts').length, 1)
  } finally {
    service.close()
  }
})
