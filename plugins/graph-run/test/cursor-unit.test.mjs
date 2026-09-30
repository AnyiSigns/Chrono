// 跨 run 续跑游标的纯函数级测试：作答回灌只替换 question 项，保留同批其它真实结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import { patchQuestionAnswer } from '../execute/cursor.ts'

test('patchQuestionAnswer：派发后游标只替换 question 项，保留同批其它真实结果', () => {
  const iter = {
    outputs: new Map([
      [
        4,
        {
          results: [
            { call_id: 'e1', ok: true, result: { marker: 'edit-real' } },
            { call_id: 'q1', ok: true, result: { status: 'pending' } },
          ],
        },
      ],
    ]),
    inputs: new Map(),
    executed: new Set(),
  }
  patchQuestionAnswer(iter, 4, 'q1', { answers: [{ id: 'x', answer: 'yes' }] }, [])
  const results = iter.outputs.get(4).results
  assert.deepEqual(results[0].result, { marker: 'edit-real' }, '非 question 项真实结果应保留')
  assert.deepEqual(results[1].result, { answers: [{ id: 'x', answer: 'yes' }] })
  assert.ok(iter.executed.has(4))
})
