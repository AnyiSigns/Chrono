// 结局构造：拒绝码 → 结局层码 / 归因 的机械映射。
// 重点：模型侧错误码必须归因 `model`（不再回落 `graph`），且下游业务码原样留在 `cause`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refusedOutcome } from '../execute/outcome.ts'

test('模型侧错误归因 model；通用包装进 downstream_refusal', () => {
  const bad = refusedOutcome('model_bad_request', null, false, null)
  assert.equal(bad.kind, 'refused')
  assert.equal(bad.code, 'downstream_refusal')
  assert.equal(bad.attributableTo, 'model')
  assert.equal(bad.cause.code, 'model_bad_request')

  const rate = refusedOutcome('model_rate_limited', null, true, null)
  assert.equal(rate.code, 'downstream_refusal')
  assert.equal(rate.attributableTo, 'model')
  assert.equal(rate.retryable, true)
})

test('已是结局码的模型码沿用原码（model_timeout）；未知码按 fallback 兜底', () => {
  const timeout = refusedOutcome('model_timeout', 'slow', false, null)
  assert.equal(timeout.code, 'model_timeout')
  assert.equal(timeout.attributableTo, 'model')

  const unknown = refusedOutcome('some_unknown', null, false, null)
  assert.equal(unknown.code, 'downstream_refusal')
  assert.equal(unknown.attributableTo, 'graph')
})
