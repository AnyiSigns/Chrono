// trace / eff_log / refused_at / branch_not_taken 的协议级测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, writeOps } from './driver.mjs'

const LEDGER = {
  version: 1,
  trace: { tail: null, count: 0 },
  evidence: { tail: null, count: 0 },
  proposals: { tail: null, count: 0 },
  verdicts: { tail: null, count: 0 },
}

function traceEntry(value) {
  return writeOps(value).find((op) => op.op === 'put' && op.args.body.kind === 'trace')
}

function evolutionPut(value) {
  return writeOps(value).find((op) => op.op === 'put' && op.args.body.trace !== undefined && op.args.body.version !== undefined)
}

test('无工具路径写 trace：steps / eff_log / outcome=done', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ evolution: LEDGER })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const entry = traceEntry(result.value)
    assert.ok(entry, '应写 trace 条目')
    assert.equal(entry.args.body.kind, 'trace')
    assert.equal(entry.args.body.outcome, 'done')
    assert.equal(entry.args.body.steps.length, 3, 'assemble / step / commit')
    assert.ok(entry.args.body.eff_log.length >= 3)
    for (const eff of entry.args.body.eff_log) {
      assert.match(eff.args_hash, /^[0-9a-f]{64}$/)
      assert.match(eff.result_hash, /^[0-9a-f]{64}$/)
      assert.ok(['ok', 'error', 'transport_failed', 'cancelled'].includes(eff.outcome))
    }
    const body = evolutionPut(result.value)
    assert.equal(body.args.body.trace.count, 1)
    assert.deepEqual(body.args.body.trace.tail, { def: { $n: 0 } })
  } finally {
    service.close()
  }
})

test('拒绝路径：refused_at 可还原（node_index / iter / code / 归因）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: '', args: {} }], usage: {} }),
    },
  })
  try {
    const result = await service.interpret({ evolution: LEDGER })
    const entry = traceEntry(result.value)
    assert.equal(entry.args.body.outcome, 'refused')
    assert.equal(entry.args.body.refused_at.node_index, 1)
    assert.equal(entry.args.body.refused_at.iter, 1)
    assert.equal(entry.args.body.refused_at.code, 'capability_mismatch')
    assert.equal(entry.args.body.refused_at.attributable_to, 'graph')
    assert.equal(entry.args.body.steps[1].verdict, 'fail')
    assert.equal(entry.args.body.steps[1].post_failed, 'malformed_tool_call')
    assert.ok(entry.args.body.branch_not_taken > 0, '未求值分支记聚合计数')
  } finally {
    service.close()
  }
})

test('无 #43 台账时不产 trace 写', async () => {
  const service = startService()
  try {
    const result = await service.interpret({})
    assert.equal(traceEntry(result.value), undefined)
  } finally {
    service.close()
  }
})
