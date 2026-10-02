// turn-ledger 协议级冒烟：hello / settle（trace 同世代 batch）/ decide（采纳写回 loop-policy body）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { H } from '../execute/hash.ts'
import { startService } from './driver.mjs'

const EMPTY_LEDGER = {
  version: 1,
  trace: { tail: null, count: 0 },
  evidence: { tail: null, count: 0 },
  proposals: { tail: null, count: 0 },
  verdicts: { tail: null, count: 0 },
}

const MODEL = { graph: { nodes: [] }, thresholds: {}, refusalCodes: [] }

/** 收集 batch / extra 里的全部子操作。 */
function opsOf(directives) {
  const ops = []
  for (const directive of directives ?? []) {
    if (directive.kind === 'write' && directive.request?.args) {
      const args = directive.request.args
      if (Array.isArray(args.ops)) ops.push(...args.ops)
      else ops.push({ op: directive.request.op, args })
    }
  }
  return ops
}

test('hello 回 manifest（turn-ledger 方法面 / needs）', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.identity, 'turn-ledger')
    assert.deepEqual(manifest.methods['turn-ledger'], ['settle', 'decide'])
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('settle：trace 条目与槽位更新合并为单世代 batch', async () => {
  const drv = startService()
  try {
    const trace = {
      steps: [{ node_index: 0, iter: 1, contract_id: 'agent.step' }],
      eff_log: [],
      refused_at: null,
      branch_not_taken: 0,
      branches_not_taken: [],
      link_taken: [],
      outcome: 'done',
    }
    const result = await drv.call('settle', {
      bag: { evolution: EMPTY_LEDGER },
      model: MODEL,
      trace,
      directives: [],
      graph_hash: null,
      scan: false,
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const ops = opsOf(result.value.batch)
    const tracePut = ops.find((op) => op.op === 'put' && op.args.body.kind === 'trace')
    assert.ok(tracePut, '应写 trace 条目')
    assert.equal(tracePut.args.body.steps.length, 1)
    const addGen = ops.find((op) => op.op === 'add_gen' && op.args.id === 'evolution')
    assert.ok(addGen, '应 add_gen evolution')
    assert.equal(result.value.extra.length, 0)
  } finally {
    drv.close()
  }
})

test('decide：approved ⇒ add_gen(loop-policy) + accepted verdict', async () => {
  const drv = startService()
  try {
    const candidate = { nodes: ['agent.step'], edges: [], sink: 0 }
    const graphHash = H(candidate)
    const proposal = {
      kind: 'proposal',
      id: 'pr-1',
      evidence_ids: ['ev-1'],
      patch: { graph: { def: graphHash }, writes: [] },
      prev: null,
    }
    const proposalHash = H(proposal)
    const bag = {
      evolution: {
        ...EMPTY_LEDGER,
        proposals: { tail: { def: proposalHash }, count: 1 },
      },
      refs: { [graphHash]: candidate, [proposalHash]: proposal },
    }
    const result = await drv.call('decide', {
      bag,
      resume: {
        cursor: { kind: 'orchestration_change', proposal_ids: ['pr-1'] },
        payload: { verdict: 'approved' },
      },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.equal(result.value.summary.kind, 'adopt')
    const ops = opsOf(result.value.batch)
    const addGen = ops.find((op) => op.op === 'add_gen' && op.args.id === 'loop-policy')
    assert.ok(addGen, '采纳应写回 loop-policy body')
    assert.deepEqual(addGen.args.payload, { def: graphHash })
    const verdictPut = ops.find((op) => op.op === 'put' && op.args.body.kind === 'verdict')
    assert.equal(verdictPut.args.body.result, 'accepted')
  } finally {
    drv.close()
  }
})
