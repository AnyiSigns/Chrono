// 回合展示段折叠单测：同一 call_id 跨承接帧（挂起步 + 作答步 / 段重建）去重，避免历史里重复工具卡。
import test from 'node:test'
import assert from 'node:assert/strict'

import { displayParts } from '../execute/commit-parts.ts'

test('displayParts：同一 call_id 去重，保留首个 render，合入最终结果', () => {
  const tools = [{ name: 'question', render: { form: 'card', label: 'question' } }]
  const timeline = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'q1', name: 'question', arguments: { questions: [] } }] },
    { role: 'tool', content: JSON.stringify({ call_id: 'q1', ok: true, result: { status: 'pending' } }) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'q1', name: 'question', arguments: { questions: [] } }] },
    { role: 'tool', content: JSON.stringify({ call_id: 'q1', ok: true, result: { answers: [{ question_id: 'x', selected: ['A'] }] } }) },
  ]
  const parts = displayParts(timeline, null, tools)
  const cards = parts.filter((part) => part.type === 'tool')
  assert.equal(cards.length, 1, '同一 call 只应有一张工具卡')
  assert.equal(cards[0].render.label, 'question')
  assert.deepEqual(cards[0].result, { answers: [{ question_id: 'x', selected: ['A'] }] })
  assert.equal(cards[0].status, 'ok')
})

test('displayParts：不同 call_id 各自成段，顺序按首个承接帧', () => {
  const timeline = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'edit', arguments: {} }, { id: 'b', name: 'read', arguments: {} }] },
    { role: 'tool', content: JSON.stringify({ call_id: 'b', ok: true, result: {} }) },
    { role: 'tool', content: JSON.stringify({ call_id: 'a', ok: true, result: {} }) },
  ]
  const parts = displayParts(timeline, null, [])
  assert.deepEqual(parts.map((part) => part.call_id), ['a', 'b'])
})
