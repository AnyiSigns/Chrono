// 结构化错误原语测试：Retry-After 解析（不自取时间）与 HTTP 状态归类。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHttpStatus, parseRetryAfter } from '../execute/errors.ts'

test('parseRetryAfter：秒数形式', () => {
  assert.equal(parseRetryAfter({ 'retry-after': '2' }, 123), 2000)
  assert.equal(parseRetryAfter({ 'retry-after': '0' }, 123), 0)
})

test('parseRetryAfter：HTTP 日期形式按传入 now 计算', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)
  const date = new Date(now + 5000).toUTCString()
  assert.equal(parseRetryAfter({ 'retry-after': date }, now), 5000)
})

test('parseRetryAfter：缺失 / 非法 → null', () => {
  assert.equal(parseRetryAfter({}, 0), null)
  assert.equal(parseRetryAfter({ 'retry-after': 'soon' }, 0), null)
})

test('classifyHttpStatus：401 不重试；429 可重试并带 retryAfterMs', () => {
  assert.equal(classifyHttpStatus(401, null).retryable, false)
  const limited = classifyHttpStatus(429, 1500)
  assert.equal(limited.retryable, true)
  assert.equal(limited.retryAfterMs, 1500)
})
