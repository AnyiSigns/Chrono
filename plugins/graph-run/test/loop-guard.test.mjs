// 无进展空转检测（确定性纯函数）：动作 + 观察 + 状态签名、连续/周期/低新颖判定、易变字段归一。

import test from 'node:test'
import assert from 'node:assert/strict'
import { detectStall, segmentSignature, stripVolatile } from '../execute/loop-guard.ts'

test('stripVolatile：递归剔除时间戳 / 请求 ID / 耗时等易变键', () => {
  const out = stripVolatile({
    path: 'a.txt',
    timestamp: '2026-01-01T00:00:00Z',
    request_id: 'r-1',
    nested: { duration_ms: 12, value: 3, created_at: 'x' },
  })
  assert.deepEqual(out, { path: 'a.txt', nested: { value: 3 } })
})

test('segmentSignature：同动作同结果 ⇒ 同签名；结果变化（合法重试）⇒ 不同签名', () => {
  const base = {
    calls: [{ tool: 'read', args: { path: 'a.txt' } }],
    results: [{ ok: true, result: { content: 'x' } }],
    state: { todo_done: 0, verify_failed: false },
  }
  const retryDifferent = {
    calls: [{ tool: 'read', args: { path: 'a.txt' } }],
    results: [{ ok: true, result: { content: 'y' } }],
    state: { todo_done: 0, verify_failed: false },
  }
  const changedArgs = {
    calls: [{ tool: 'read', args: { path: 'b.txt' } }],
    results: [{ ok: true, result: { content: 'x' } }],
    state: { todo_done: 0, verify_failed: false },
  }
  const repeated = {
    calls: [{ tool: 'read', args: { path: 'a.txt' } }],
    results: [{ ok: true, result: { content: 'x' } }],
    state: { todo_done: 0, verify_failed: false },
  }
  assert.equal(segmentSignature(base), segmentSignature(repeated))
  assert.notEqual(segmentSignature(base), segmentSignature(retryDifferent))
  assert.notEqual(segmentSignature(base), segmentSignature(changedArgs))
})

test('segmentSignature：易变字段不影响签名（时间戳 / 请求 ID 不掩盖重复）', () => {
  const a = segmentSignature({
    calls: [{ tool: 'read', args: { path: 'a.txt', timestamp: 1 } }],
    results: [{ ok: true, result: { content: 'x', request_id: 'r1' } }],
    state: { todo_done: 0, verify_failed: false },
  })
  const b = segmentSignature({
    calls: [{ tool: 'read', args: { path: 'a.txt', timestamp: 2 } }],
    results: [{ ok: true, result: { content: 'x', request_id: 'r2' } }],
    state: { todo_done: 0, verify_failed: false },
  })
  assert.equal(a, b)
})

test('segmentSignature：签名是内容摘要，长度有界且不随结果正文体积放大', () => {
  const result = () => ({ ok: true, result: { content: 'x'.repeat(2 * 1024 * 1024) } })
  const state = { todo_done: 0, verify_failed: false }
  const a = segmentSignature({
    calls: [{ tool: 'read', args: { path: 'a.txt' } }],
    results: [result()],
    state,
  })
  const b = segmentSignature({
    calls: [{ tool: 'read', args: { path: 'a.txt' } }],
    results: [result()],
    state,
  })
  assert.equal(a.length, 64)
  assert.equal(a, b)
})

test('detectStall：连续重复达 repeatN 命中', () => {
  const verdict = detectStall(['s', 's', 's'], 3, 8, 2)
  assert.equal(verdict?.kind, 'repeat')
})

test('detectStall：A-B-A-B 短周期命中 cycle', () => {
  const verdict = detectStall(['a', 'b', 'a', 'b'], 3, 8, 2)
  assert.equal(verdict?.kind, 'cycle')
})

test('detectStall：窗口内低新颖命中；多样窗口不误报', () => {
  const low = detectStall(['a', 'b', 'a', 'a', 'b', 'a', 'b', 'b'], 3, 8, 2)
  assert.equal(low?.kind, 'low_novelty')
  const diverse = detectStall(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3, 8, 2)
  assert.equal(diverse, null)
})

test('detectStall：样本不足不判定（避免过早收口）', () => {
  assert.equal(detectStall(['a', 'a'], 3, 8, 2), null)
})
