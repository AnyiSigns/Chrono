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

test('推理能力表：档案 > SDK > 协议默认 > 保守；无厂商中心表', () => {
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
  // openai 不设厂商覆盖：同一厂商随协议分叉（chat 通用尝试回传 / responses 回传加密项）。
  assert.equal(
    resolveReasoningCapability({ provider: 'openai', protocol: 'openai-chat' }).replay_form,
    'reasoning_content',
  )
  // 各内置厂商的精确规则改由厂商模板声明后经 profile 注入；无中心厂商表。
  const generic = resolveReasoningCapability({ provider: 'unlisted-vendor', protocol: 'openai-chat' })
  assert.equal(generic.replay_form, 'reasoning_content', '通用 OpenAI 兼容尝试回传，由自适应降级兜底')
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
  // 厂商精确定义经模板声明走 profile 槽注入（不再有中心厂商表）。
  const json = capabilityToJson(
    resolveReasoningCapability({
      profile: {
        retention: 'turn',
        requires_replay_in_tool_loop: true,
        signature_field: null,
        replay_form: 'reasoning_content',
        invalidated_by: ['model_change', 'prefix_change', 'thinking_param_change'],
        verified: true,
      },
    }),
  )
  assert.equal(json.replay_form, 'reasoning_content')
  assert.equal(json.requires_replay_in_tool_loop, true)
  assert.equal(Array.isArray(json.invalidated_by), true)
  assert.equal(typeof json.verified, 'boolean')
})
