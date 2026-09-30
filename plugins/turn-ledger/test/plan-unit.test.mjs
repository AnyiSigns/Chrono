// RoundPatches 累积器纯函数级测试：stageDef 哈希口径与 finalize 落 def。
import test from 'node:test'
import assert from 'node:assert/strict'
import { RoundPatches } from '../execute/plan.ts'
import { H } from '../execute/hash.ts'

const LEDGER = {
  version: 1,
  trace: { tail: null, count: 0 },
  evidence: { tail: null, count: 0 },
  proposals: { tail: null, count: 0 },
  verdicts: { tail: null, count: 0 },
}

function writeOps(value) {
  const ops = []
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'write' && directive.request && directive.request.args) {
      const args = directive.request.args
      if (Array.isArray(args.ops)) ops.push(...args.ops)
      else ops.push({ op: directive.request.op, args })
    }
  }
  return ops
}

test('RoundPatches.stageDef：返回哈希 == H({body})，finalize 含该 def 的 put', () => {
  const round = new RoundPatches(new Map([['evolution', { body: LEDGER, base: 0 }]]))
  const body = { workspace_id: 'w1', thread: null, input: 'hi', session: null }
  const hash = round.stageDef(body)
  assert.equal(hash, H({ body }))
  const ops = writeOps({ $directives: round.finalize() })
  assert.ok(
    ops.some((op) => op.op === 'put' && op.args.body.workspace_id === 'w1'),
    '摘要 def 应落账',
  )
})
