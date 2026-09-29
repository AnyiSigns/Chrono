// 厂商推理规则测试：中立块形状、能力表解析、回传 / 丢弃。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  capabilityToJson,
  reasoningBlock,
  replayableBlocks,
  resolveReasoningCapability,
} from '../execute/reasoning.ts'

/** 复刻 chain-contract `validateReasoningBlock` 的形状断言（不 import 契约包）。 */
function assertNeutralShape(block) {
  assert.deepEqual(Object.keys(block).sort(), [
    'encrypted',
    'form',
    'model',
    'payload',
    'provider',
    'signature',
    'tokens',
  ])
  assert.equal(
    typeof block.provider === 'string' && block.provider.length > 0,
    true,
    'provider 非空',
  )
  assert.equal(typeof block.model === 'string' && block.model.length > 0, true, 'model 非空')
  assert.ok(block.form === 'text' || block.form === 'blocks', 'form ∈ text|blocks')
  assert.equal(block.payload !== undefined, true, 'payload 必须有')
  assert.equal(typeof block.signature === 'string', true)
  assert.equal(typeof block.encrypted === 'string', true)
  assert.equal(Number.isInteger(block.tokens), true)
}

test('中立推理块：字段固定且满足本地形状校验', () => {
  const block = reasoningBlock(
    'anthropic',
    'claude-sonnet-4-6',
    'blocks',
    '先读文件',
    'sig',
    '',
    64,
  )
  assertNeutralShape(block)
  assert.deepEqual(block, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    form: 'blocks',
    payload: '先读文件',
    signature: 'sig',
    encrypted: '',
    tokens: 64,
  })
})

test('推理能力表：厂商覆盖命中；未覆盖厂商取协议默认（保守，不回传）', () => {
  assert.equal(
    resolveReasoningCapability({ provider: 'anthropic', protocol: 'anthropic-messages' })
      .replay_form,
    'thinking_block',
  )
  assert.equal(
    resolveReasoningCapability({ provider: 'anthropic', protocol: 'anthropic-messages' })
      .requires_replay_in_tool_loop,
    true,
  )
  assert.equal(
    resolveReasoningCapability({ provider: 'vendor-deepseek', protocol: 'openai-chat' })
      .replay_form,
    'reasoning_content',
  )
  assert.equal(
    resolveReasoningCapability({ provider: 'google-genai', impl: 'sdk' }).replay_form,
    'parts',
  )
  assert.equal(
    resolveReasoningCapability({ provider: 'kimi', protocol: 'openai-chat' }).replay_form,
    'reasoning_content',
  )
  const response = resolveReasoningCapability({ provider: 'openai', protocol: 'openai-responses' })
  assert.equal(response.replay_form, 'reasoning_item')
  assert.equal(response.signature_field, 'encrypted_content')
  const conservative = resolveReasoningCapability({ provider: 'zai', protocol: 'openai-chat' })
  assert.equal(conservative.replay_form, null, '未核实厂商不回传')
  const none = resolveReasoningCapability({ provider: 'whatever', protocol: 'unsupported' })
  assert.equal(none.retention, 'none')
  assert.equal(none.replay_form, null)
})

test('换模型即丢：跨模型 / 缺签名的捕获推理不可回传', () => {
  const capability = resolveReasoningCapability({
    provider: 'anthropic',
    protocol: 'anthropic-messages',
  })
  const signed = reasoningBlock('anthropic', 'claude-a', 'blocks', '想', 'sig')
  assert.equal(replayableBlocks([signed], capability, 'anthropic', 'claude-a').length, 1)
  assert.equal(
    replayableBlocks([signed], capability, 'anthropic', 'claude-b').length,
    0,
    '跨模型丢弃',
  )
  const unsigned = reasoningBlock('anthropic', 'claude-a', 'blocks', '想', '')
  assert.equal(
    replayableBlocks([unsigned], capability, 'anthropic', 'claude-a').length,
    0,
    '厂商要求签名时缺签名丢弃',
  )
})

test('capabilityToJson：字段固定可入档', () => {
  const json = capabilityToJson(resolveReasoningCapability({ provider: 'deepseek' }))
  assert.equal(json.replay_form, 'reasoning_content')
  assert.equal(json.requires_replay_in_tool_loop, true)
  assert.equal(Array.isArray(json.invalidated_by), true)
  assert.equal(typeof json.verified, 'boolean')
})
