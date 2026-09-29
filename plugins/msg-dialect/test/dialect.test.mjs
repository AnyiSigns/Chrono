// 方言编解码测试：请求编形（HTTP / SDK）/ 整包解析 / 工具编形 / 鉴权 / 资产内联 handler。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAuthToUrl,
  buildRequest,
  encodeTools,
  normalizeQuirks,
  parseFull,
} from '../execute/dialect.ts'
import { createHandlers } from '../execute/methods.ts'

const SHA = 'a'.repeat(64)

test('build（openai-chat）：请求编形（model / messages / max_tokens / reasoning 档位 / auth / stream）', () => {
  const built = buildRequest({
    quirks: normalizeQuirks(undefined, 'openai-chat'),
    provider: 'openai',
    base_url: 'https://x.invalid/v1',
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
    params: { temperature: 0.5, max_tokens: 32, reasoning: 'low' },
    secret: 'sk-1',
    stream: true,
  })
  assert.equal(built.kind, 'http')
  assert.equal(built.protocol, 'openai-chat')
  assert.equal(built.url, 'https://x.invalid/v1/chat/completions')
  assert.equal(built.headers.authorization, 'Bearer sk-1')
  assert.equal(built.body.model, 'gpt-test')
  assert.equal(built.body.messages[0].role, 'system')
  assert.equal(built.body.max_tokens, 32)
  assert.equal(built.body.temperature, 0.5)
  assert.equal(built.body.reasoning_effort, 'low')
  assert.equal(built.body.stream, true)
  assert.deepEqual(built.body.stream_options, { include_usage: true })
})

test('build（anthropic）：system 顶层 / max_tokens 缺省 / x-api-key', () => {
  const built = buildRequest({
    quirks: normalizeQuirks(undefined, 'anthropic-messages'),
    provider: 'anthropic',
    base_url: 'https://api.anthropic.com',
    model: 'claude',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    secret: 'ak',
    stream: false,
  })
  assert.equal(built.url, 'https://api.anthropic.com/messages')
  assert.equal(built.headers['x-api-key'], 'ak')
  assert.equal(built.body.system, 'sys')
  assert.equal(built.body.max_tokens, 4096)
  assert.equal(built.body.stream, false)
})

test('build（sdk）：回 SDK 参数（model / contents / config）', () => {
  const built = buildRequest({
    quirks: {
      ...normalizeQuirks(undefined, 'openai-chat'),
      impl: 'sdk',
      sdk_package: '@google/genai',
    },
    provider: 'google-genai',
    model: 'gemini',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ],
    params: { max_tokens: 12, reasoning: 'low' },
  })
  assert.equal(built.kind, 'sdk')
  assert.equal(built.protocol, 'sdk')
  assert.equal(built.params.model, 'gemini')
  assert.equal(
    built.params.config.maxOutputTokens,
    undefined,
    'max_tokens_field 取协议默认 max_tokens',
  )
  assert.equal(built.params.config.max_tokens, 12)
  assert.equal(built.params.config.systemInstruction, 'be terse')
})

test('parse-full（openai-chat）：整包解析含推理块与 usage 缓存字段', () => {
  const out = parseFull({
    quirks: normalizeQuirks(undefined, 'openai-chat'),
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    json: {
      choices: [{ message: { content: 'x', reasoning_content: 'r' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    },
  })
  assert.equal(out.text, 'x')
  assert.equal(out.reasoning, 'r')
  assert.equal(out.usage.total_tokens, 3)
  assert.equal(out.usage.cached_tokens, 4)
  assert.equal(out.stop_reason, 'stop')
  assert.equal(out.reasoning_blocks[0].form, 'text')
})

test('parse-full（anthropic）：thinking / tool_use 对称解析', () => {
  const out = parseFull({
    quirks: normalizeQuirks(undefined, 'anthropic-messages'),
    provider: 'anthropic',
    model: 'claude',
    json: {
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: '答' },
        { type: 'tool_use', id: 't1', name: 'calc', input: { n: 2 } },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
      stop_reason: 'tool_use',
    },
  })
  assert.equal(out.text, '答')
  assert.equal(out.reasoning, 'hmm')
  assert.deepEqual(out.tool_calls, [{ id: 't1', name: 'calc', arguments: { n: 2 } }])
  assert.equal(out.usage.total_tokens, 5)
  assert.equal(out.stop_reason, 'tool_use')
  assert.equal(out.reasoning_blocks[0].signature, 'sig')
})

test('encode-tools：中性声明按协议编形；缺 name 丢弃；原生透传', () => {
  const tools = [
    { name: 'a', description: 'd', argsSchema: { type: 'object' } },
    { description: 'no name' },
    { type: 'web_search' },
  ]
  const openai = encodeTools(tools, 'openai-chat')
  assert.deepEqual(openai, [
    { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object' } } },
    { type: 'web_search' },
  ])
  const anthropic = encodeTools(tools, 'anthropic-messages')
  assert.deepEqual(anthropic[0], { name: 'a', input_schema: { type: 'object' }, description: 'd' })
})

test('apply-auth：bearer / header / query 三形态', () => {
  const bearer = applyAuthToUrl('https://x/y', normalizeQuirks(undefined, 'openai-chat'), 'sk')
  assert.deepEqual(bearer.headers.authorization, 'Bearer sk')
  const header = applyAuthToUrl(
    'https://x/y',
    normalizeQuirks(undefined, 'anthropic-messages'),
    'ak',
  )
  assert.equal(header.headers['x-api-key'], 'ak')
  const query = applyAuthToUrl(
    'https://x/y',
    { ...normalizeQuirks(undefined, 'openai-chat'), auth_style: 'query' },
    'q k',
  )
  assert.equal(query.url, 'https://x/y?key=q%20k')
})

test('build：未知协议抛 model_unsupported', () => {
  assert.throws(
    () =>
      buildRequest({
        quirks: { ...normalizeQuirks(undefined, 'openai-chat'), protocol: 'nope' },
        provider: 'p',
        model: 'm',
        messages: [],
      }),
    (err) => err.code === 'model_unsupported',
  )
})

test('inline-assets handler：经 host 取字节内联', async () => {
  const host = {
    async call(port, method, args) {
      assert.equal(port, 'host')
      assert.equal(method, 'asset.get')
      assert.equal(args.sha256, SHA)
      return { ok: true, value: { mime: 'image/png', bytes: 'aGVsbG8=' } }
    },
  }
  const handlers = createHandlers({ host })
  const result = await handlers['inline-assets'](
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `asset:${SHA}` } }] },
      ],
      protocol: 'openai-chat',
    },
    {},
    {},
  )
  assert.deepEqual(result.value.messages[0].content[0], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aGVsbG8=' },
  })
})
