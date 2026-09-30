// evolutionBody 纯函数级测试：剔除入口切片并入的 refs（防每回合把闭包写回台账）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { evolutionBody } from '../execute/proposals.ts'

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
