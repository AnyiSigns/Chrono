// quirks 原语测试：点路径写入与原型键防护；协议默认与厂商覆盖归一。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuirks, setByPath } from '../execute/quirks.ts'

test('setByPath：正常点路径写入', () => {
  const target = {}
  setByPath(target, 'thinkingConfig.thinkingBudget', 128)
  assert.deepEqual(target, { thinkingConfig: { thinkingBudget: 128 } })
})

test('setByPath：原型键段整体放弃，不污染原型 / 不覆写构造器', () => {
  const target = {}
  setByPath(target, '__proto__.polluted', true)
  setByPath(target, 'constructor.prototype.polluted', true)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(target, {})
})

test('normalizeQuirks：协议默认 + 厂商覆盖；protocolOverride 优先', () => {
  const defaults = normalizeQuirks(undefined, 'anthropic-messages')
  assert.equal(defaults.protocol, 'anthropic-messages')
  assert.equal(defaults.auth_style, 'header')
  assert.equal(defaults.auth_header, 'x-api-key')
  assert.equal(defaults.max_tokens_field, 'max_tokens')
  assert.equal(defaults.stream_usage, 'separate')
  assert.deepEqual(defaults.extra_headers, { 'anthropic-version': '2023-06-01' })

  const override = normalizeQuirks(
    { auth_style: 'bearer', max_tokens_field: 'max_completion_tokens' },
    'openai-chat',
  )
  assert.equal(override.auth_style, 'bearer')
  assert.equal(override.max_tokens_field, 'max_completion_tokens')
  assert.equal(override.protocol, 'openai-chat')

  // protocolOverride 覆盖 quirks.protocol 字段
  const forced = normalizeQuirks({ protocol: 'openai-chat' }, 'openai-responses')
  assert.equal(forced.protocol, 'openai-responses')
})

test('normalizeQuirks：impl=sdk 识别；缺省 protocol = openai-chat', () => {
  assert.equal(normalizeQuirks({ impl: 'sdk' }).impl, 'sdk')
  assert.equal(normalizeQuirks(undefined).protocol, 'openai-chat')
})
