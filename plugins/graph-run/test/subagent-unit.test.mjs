// 子代理结构化结果的纯函数级测试（协议级子代理隔离住 loop-policy 门面测试）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isStructuredCheckpoint, latestCheckpoint, toSubagentResult } from '../execute/subagent.ts'

test('子代理结构化结果不是会话检查点：kind=subagent 排除，不覆盖历史边界', () => {
  assert.equal(isStructuredCheckpoint({ kind: 'subagent', goal: 'g', findings: [{ claim: 'c' }] }), false)
  assert.equal(isStructuredCheckpoint({ kind: 'verify', text: 'v' }), false)
  assert.equal(isStructuredCheckpoint({ kind: 'segment', iter: 1 }), false)
  assert.equal(isStructuredCheckpoint({ goal: 'g' }), true)

  const result = toSubagentResult({ result: { goal: 'SUB', findings: [{ claim: 'F' }] } })
  assert.equal(result.result.kind, 'subagent')

  const bag = {
    session: {
      turns: [
        {
          turn_id: 't0',
          steps: [
            { type: 'checkpoint', turn_id: 't0', seq: 1, summary: { kind: 'subagent', goal: '子代理结果' }, covered_upto: 1 },
            { type: 'checkpoint', turn_id: 't0', seq: 2, summary: { goal: '真检查点' }, covered_upto: 2 },
          ],
        },
      ],
    },
  }
  assert.deepEqual(latestCheckpoint(bag, 't0').summary, { goal: '真检查点' })
})
