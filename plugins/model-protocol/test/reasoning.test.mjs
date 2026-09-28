// 厂商推理规则测试：中立块形状、能力表、回传 / 丢弃、缓存命中 token、显式缓存断点、
// 以及 Gemini 多轮工具使用的请求编形。协议请求体断言走本地 HTTP 桩；SDK 请求体直接调适配器（伪模块注入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatBag, startService } from './driver.mjs'
import { jsonResponse, parseBody, sseEvent, sseHead, startHttpServer } from './fake-http.mjs'
import { getAdapter } from '../execute/adapters.ts'
import { StreamAccumulator } from '../execute/stream.ts'
import {
  reasoningBlock,
  replayableBlocks,
  resolveReasoningCapability,
} from '../execute/reasoning.ts'
import { normalizeQuirks } from '../execute/quirks.ts'
import { googleChat } from '../execute/sdk-google.ts'

const FAST = { max_retries: 0, backoff_ms: 5, token_bucket: { capacity: 100, refill_per_sec: 1000 } }

function quirksFor(protocol, extra = {}) {
  return {
    impl: 'protocol',
    protocol,
    auth_style: 'bearer',
    system_role: 'system',
    reasoning_field: null,
    reasoning_map: {},
    reasoning_response_field: null,
    max_tokens_field: protocol === 'anthropic-messages' ? 'max_tokens' : 'max_tokens',
    models_path: '/models',
    stream_usage: 'final_chunk',
    extra_headers: {},
    ...extra,
  }
}

async function withService(options, run) {
  const driver = startService(options)
  try {
    await driver.hello()
    return await run(driver)
  } finally {
    driver.close()
    await driver.exit
  }
}

async function withServer(handler, run) {
  const server = await startHttpServer(handler)
  try {
    return await run(server)
  } finally {
    await server.close()
  }
}

/** 复刻 chain-contract `validateReasoningBlock` 的形状断言（不 import 契约包）。 */
function assertNeutralShape(block) {
  assert.deepEqual(
    Object.keys(block).sort(),
    ['encrypted', 'form', 'model', 'payload', 'provider', 'signature', 'tokens'],
  )
  assert.equal(typeof block.provider === 'string' && block.provider.length > 0, true, 'provider 非空')
  assert.equal(typeof block.model === 'string' && block.model.length > 0, true, 'model 非空')
  assert.ok(block.form === 'text' || block.form === 'blocks', 'form ∈ text|blocks')
  assert.equal(block.payload !== undefined, true, 'payload 必须有')
  assert.equal(typeof block.signature === 'string', true)
  assert.equal(typeof block.encrypted === 'string', true)
  assert.equal(Number.isInteger(block.tokens), true)
}

// ── 中立块与能力表 ─────────────────────────────────────────────────────────

test('中立推理块：字段固定且满足本地形状校验', () => {
  const block = reasoningBlock('anthropic', 'claude-sonnet-4-6', 'blocks', '先读文件', 'sig', '', 64)
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
  assert.equal(resolveReasoningCapability({ provider: 'anthropic', protocol: 'anthropic-messages' }).replay_form, 'thinking_block')
  assert.equal(resolveReasoningCapability({ provider: 'anthropic', protocol: 'anthropic-messages' }).requires_replay_in_tool_loop, true)
  assert.equal(resolveReasoningCapability({ provider: 'vendor-deepseek', protocol: 'openai-chat' }).replay_form, 'reasoning_content')
  assert.equal(resolveReasoningCapability({ provider: 'google-genai', impl: 'sdk' }).replay_form, 'parts')
  assert.equal(resolveReasoningCapability({ provider: 'kimi', protocol: 'openai-chat' }).replay_form, 'reasoning_content')
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
  const capability = resolveReasoningCapability({ provider: 'anthropic', protocol: 'anthropic-messages' })
  const signed = reasoningBlock('anthropic', 'claude-a', 'blocks', '想', 'sig')
  assert.equal(replayableBlocks([signed], capability, 'anthropic', 'claude-a').length, 1)
  assert.equal(replayableBlocks([signed], capability, 'anthropic', 'claude-b').length, 0, '跨模型丢弃')
  const unsigned = reasoningBlock('anthropic', 'claude-a', 'blocks', '想', '')
  assert.equal(replayableBlocks([unsigned], capability, 'anthropic', 'claude-a').length, 0, '厂商要求签名时缺签名丢弃')
})

// ── 适配器：全响应 / 流式对称 + 缓存 token ─────────────────────────────────

test('openai-responses：parseFull 与流式终止分片对称解析推理（含加密内容）', () => {
  const adapter = getAdapter('openai-responses', normalizeQuirks(undefined, 'openai-responses'), { provider: 'openai', model: 'gpt-5.6' })
  const payload = {
    output: [
      { type: 'reasoning', summary: [{ text: '先读文件' }], encrypted_content: 'enc-1' },
      { type: 'message', content: [{ type: 'output_text', text: '答' }] },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
  }
  const full = adapter.parseFull(payload)
  assert.equal(full.reasoning, '先读文件')
  assert.equal(full.text, '答')
  assert.equal(full.reasoning_blocks.length, 1)
  assert.equal(full.reasoning_blocks[0].encrypted, 'enc-1')
  assert.equal(full.reasoning_blocks[0].signature, '', '加密内容只落 encrypted 字段')

  const acc = new StreamAccumulator()
  adapter.handleStreamData(JSON.stringify({ type: 'response.completed', response: payload }), acc)
  assert.equal(acc.reasoningBlocksValue.length, 1)
  assert.deepEqual(acc.reasoningBlocksValue[0], full.reasoning_blocks[0], '流式与全响应解析一致')
})

test('usage：缓存命中 token 归一，且既有字段名不变', () => {
  const chat = getAdapter('openai-chat', normalizeQuirks(undefined, 'openai-chat'), { provider: 'deepseek', model: 'deepseek-reasoner' })
  const openai = chat.parseFull({
    choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 }, prompt_cache_hit_tokens: 6 },
  })
  assert.equal(openai.usage.prompt_tokens, 10)
  assert.equal(openai.usage.completion_tokens, 2)
  assert.equal(openai.usage.total_tokens, 12)
  assert.equal(openai.usage.cached_tokens, 4)
  assert.equal(openai.usage.prompt_cache_hit_tokens, 6)

  const anthropic = getAdapter('anthropic-messages', normalizeQuirks(undefined, 'anthropic-messages'), { provider: 'anthropic', model: 'claude' })
  const parsed = anthropic.parseFull({
    content: [{ type: 'text', text: 'x' }],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 7 },
  })
  assert.equal(parsed.usage.cache_read_input_tokens, 3)
  assert.equal(parsed.usage.cache_creation_input_tokens, 7)
})

// ── 思考请求参数：由能力表决定发送 ─────────────────────────────────────────

test('reasoning 参数：anthropic / responses 默认线格式发送；能力表 retention=none 时不发', async () => {
  const anthropicHandler = (req, res) => anthropicOk(res)
  await withServer(anthropicHandler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, {
        config: { model: 'claude-test', params: { max_tokens: 64, reasoning: 'low' }, quirks: normalizeQuirks(undefined, 'anthropic-messages') },
        resilience: FAST,
      })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      assert.deepEqual(parseBody(server.requests[0]).thinking, { type: 'enabled', budget_tokens: 1024 })
    })
  })

  const responsesHandler = (req, res) => {
    sseHead(res)
    sseEvent(res, { type: 'response.output_text.delta', delta: 'ok' })
    sseEvent(res, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })
    res.end()
  }
  await withServer(responsesHandler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, {
        config: { model: 'gpt-test', params: { reasoning: 'high' }, quirks: normalizeQuirks(undefined, 'openai-responses') },
        resilience: FAST,
      })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      assert.deepEqual(parseBody(server.requests[0]).reasoning, { effort: 'high' })
    })
  })
})

test('reasoning 参数：调用方给出 retention=none 的能力表时一律不发', async () => {
  const handler = (req, res) => anthropicOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, {
        config: {
          model: 'claude-test',
          params: { max_tokens: 64, reasoning: 'low' },
          quirks: normalizeQuirks(undefined, 'anthropic-messages'),
          reasoning_capability: {
            retention: 'none',
            requires_replay_in_tool_loop: false,
            signature_field: null,
            replay_form: null,
            invalidated_by: ['model_change'],
            verified: true,
          },
        },
        resilience: FAST,
      })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      assert.equal(parseBody(server.requests[0]).thinking, undefined)
    })
  })
})

// ── Anthropic：带签名 thinking + tools 回传 / 换模型丢弃 ────────────────────

function anthropicOk(res) {
  sseHead(res)
  sseEvent(res, { type: 'message_start', message: { usage: { input_tokens: 1 } } })
  sseEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
  sseEvent(res, { type: 'message_stop' })
  res.end()
}

const ANTHROPIC_MESSAGES = [
  { role: 'user', content: '算一下' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'toolu_1', name: 'calc', arguments: { n: 2 } }],
    reasoning: { provider: 'anthropic', model: 'claude-test', form: 'blocks', payload: 'hmm', signature: 'sig-1', encrypted: '', tokens: 0 },
  },
]

function anthropicBag(serverUrl, messages, model = 'claude-test') {
  return chatBag(serverUrl, {
    config: {
      vendor: 'anthropic',
      model,
      params: { max_tokens: 64 },
      quirks: quirksFor('anthropic-messages'),
    },
    messages,
    resilience: FAST,
  })
}

test('anthropic：带签名的 thinking 块与 tool_use 同时回传', async () => {
  const handler = (req, res) => anthropicOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', anthropicBag(server.url, ANTHROPIC_MESSAGES))
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      const assistant = body.messages.find((message) => message.role === 'assistant')
      assert.deepEqual(assistant.content, [
        { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'calc', input: { n: 2 } },
      ])
    })
  })
})

test('anthropic：换模型后捕获的 thinking 块被丢弃（签名绑定产出模型）', async () => {
  const handler = (req, res) => anthropicOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', anthropicBag(server.url, ANTHROPIC_MESSAGES, 'claude-other'))
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      const assistant = body.messages.find((message) => message.role === 'assistant')
      assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'toolu_1', name: 'calc', input: { n: 2 } }])
    })
  })
})

// ── DeepSeek：思考模式带 tools 的 reasoning_content 回传 / 换模型丢弃 ────────

function openAiOk(res) {
  sseHead(res)
  sseEvent(res, { choices: [{ delta: { content: 'ok' } }] })
  sseEvent(res, '[DONE]')
  res.end()
}

const DEEPSEEK_MESSAGES = [
  { role: 'user', content: '查一下' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
    reasoning: { provider: 'deepseek', model: 'deepseek-reasoner', form: 'text', payload: 'think', signature: '', encrypted: '', tokens: 0 },
  },
  { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
]

function deepseekBag(serverUrl, model = 'deepseek-reasoner') {
  return chatBag(serverUrl, {
    config: {
      vendor: 'deepseek',
      model,
      params: { max_tokens: 64 },
      quirks: quirksFor('openai-chat'),
    },
    messages: DEEPSEEK_MESSAGES,
    resilience: FAST,
  })
}

test('deepseek：思考模式带 tools 时 reasoning_content 原样回传', async () => {
  const handler = (req, res) => openAiOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', deepseekBag(server.url))
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      const assistant = body.messages.find((message) => message.role === 'assistant')
      assert.equal(assistant.reasoning_content, 'think')
      assert.deepEqual(assistant.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])
      const tool = body.messages.find((message) => message.role === 'tool')
      assert.equal(tool.tool_call_id, 'c1')
    })
  })
})

test('deepseek：换模型后 reasoning_content 被丢弃', async () => {
  const handler = (req, res) => openAiOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('chat', deepseekBag(server.url, 'deepseek-other'))
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      const assistant = body.messages.find((message) => message.role === 'assistant')
      assert.equal(assistant.reasoning_content, undefined)
    })
  })
})

// ── OpenAI Responses：推理项往返 ────────────────────────────────────────────

test('openai-responses：捕获的加密推理按推理项回传进 input', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { type: 'response.output_text.delta', delta: 'ok' })
    sseEvent(res, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } })
    res.end()
  }
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const messages = [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: 'hi',
          reasoning: { provider: 'openai', model: 'gpt-5.6', form: 'text', payload: '', signature: '', encrypted: 'enc-1', tokens: 0 },
        },
      ]
      const bag = chatBag(server.url, {
        config: { vendor: 'openai', model: 'gpt-5.6', params: {}, quirks: quirksFor('openai-responses') },
        messages,
        resilience: FAST,
      })
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      assert.ok(body.input.some((item) => item.type === 'reasoning' && item.encrypted_content === 'enc-1'))
    })
  })
})

// ── 显式缓存断点 ───────────────────────────────────────────────────────────

test('缓存断点：anthropic 在 system / tools / 指定消息末尾标 cache_control', async () => {
  const handler = (req, res) => anthropicOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = anthropicBag(server.url, [{ role: 'user', content: 'hello' }])
      bag.tools = [{ name: 'lookup', description: 'd', argsSchema: { type: 'object' } }]
      bag.cache = { system: true, tools: true, breakpoints: [0] }
      bag.messages = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hello' }]
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      const body = parseBody(server.requests[0])
      assert.deepEqual(body.system, [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }])
      assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' })
      assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' })
    })
  })
})

test('缓存断点：openai-chat 把前缀 key 编成 prompt_cache_key', async () => {
  const handler = (req, res) => openAiOk(res)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const bag = chatBag(server.url, { config: { quirks: quirksFor('openai-chat') }, resilience: FAST })
      bag.cache = { key: 'stable-prefix-1' }
      const result = await driver.call('chat', bag)
      assert.equal(result.value.ok, true)
      assert.equal(parseBody(server.requests[0]).prompt_cache_key, 'stable-prefix-1')
    })
  })
})

// ── Gemini：多轮工具使用 + thought signature ────────────────────────────────

test('google-sdk：多轮工具使用编成 functionCall / functionResponse，并捕获 thought signature', async () => {
  const previousModule = process.env.CHRONO_MODEL_SDK_MODULE
  const previousScenario = process.env.FAKE_GOOGLE_TOOL_TURN
  process.env.CHRONO_MODEL_SDK_MODULE = new URL('./fake-google-sdk.mjs', import.meta.url).href
  process.env.FAKE_GOOGLE_TOOL_TURN = '1'
  try {
    const messages = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', name: 'lookup', arguments: { q: 'x' } }],
        reasoning: { provider: 'google-genai', model: 'gemini-3', form: 'blocks', payload: 'think', signature: 'sig-1', encrypted: '', tokens: 0 },
      },
      { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    ]
    const output = await googleChat(
      {
        sdk_package: '@google/genai',
        api_key: 'k',
        provider: 'google-genai',
        model: 'gemini-3',
        messages,
        params: {},
        quirks: normalizeQuirks(undefined, 'openai-chat'),
        capability: resolveReasoningCapability({ provider: 'google-genai', impl: 'sdk' }),
      },
      () => {},
    )
    const contents = globalThis.__fakeGoogleLastParams.contents
    assert.deepEqual(contents[0], { role: 'user', parts: [{ text: 'hello' }] })
    assert.deepEqual(contents[1], {
      role: 'model',
      parts: [
        { text: 'think', thought: true },
        { functionCall: { name: 'lookup', args: { q: 'x' } }, thoughtSignature: 'sig-1' },
      ],
    })
    assert.deepEqual(contents[2], { role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { ok: true } } }] })

    assert.equal(output.reasoning, 'think')
    assert.deepEqual(output.tool_calls, [{ id: null, name: 'lookup', arguments: { q: 'x' } }])
    assert.equal(output.reasoning_blocks.length, 1)
    assertNeutralShape(output.reasoning_blocks[0])
    assert.equal(output.reasoning_blocks[0].signature, 'sig-1')
    assert.equal(output.reasoning_blocks[0].form, 'blocks')
  } finally {
    if (previousModule === undefined) delete process.env.CHRONO_MODEL_SDK_MODULE
    else process.env.CHRONO_MODEL_SDK_MODULE = previousModule
    if (previousScenario === undefined) delete process.env.FAKE_GOOGLE_TOOL_TURN
    else process.env.FAKE_GOOGLE_TOOL_TURN = previousScenario
  }
})

// ── profile：能力表落模型档案 ───────────────────────────────────────────────

test('profile：把推理能力表写进所选模型元数据', async () => {
  const source = { deepseek: { models: { 'deepseek-reasoner': { limit: { context: 64000, output: 8000 }, reasoning: true } } } }
  const handler = (req, res) => jsonResponse(res, 200, source)
  await withServer(handler, async (server) => {
    await withService({}, async (driver) => {
      const result = await driver.call('profile', {
        vendor: 'vendor-deepseek',
        ids: ['deepseek-reasoner'],
        vendors: { 'vendor-deepseek': { sdk: 'deepseek', default_reasoning: ['low', 'high'] } },
        source_url: server.url,
        resilience: FAST,
      })
      assert.equal(result.value.ok, true)
      const model = result.value.models['deepseek-reasoner']
      assert.equal(model.reasoning_capability.replay_form, 'reasoning_content')
      assert.equal(model.reasoning_capability.requires_replay_in_tool_loop, true)
    })
  })
})
