// 接缝契约 5：loop-policy ↔ model-protocol。
// 共享真源：chain-contract/fixtures/node-io.json 的 `context.assemble.output.messages` /
// `model.chat` 形状，以及 fixtures/vendor-reasoning.json 的厂商推理中立块。
// 消费方向：真实 model-protocol 服务（经 plugin-sdk `startService`）消费真实消息 + 工具 schema + 推理回传形态。
// 供给方向：真实 loop-policy 解释器消费真实 model-protocol 返回的 `{text,reasoning,tool_calls,usage}` 与流式分片。
// 至少一侧为真实服务：两个方向都是真实服务（model-protocol 侧另配本地 HTTP 厂商桩，只假最外部边界）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { nodeIo, vendorReasoning } from '../../chain-contract/fixtures/index.ts'
import { startService as startModel, configFor } from '../../plugins/model-protocol/test/driver.mjs'
import { parseBody, sseEvent, sseHead, startHttpServer } from '../../plugins/model-protocol/test/fake-http.mjs'
import { startService as startLoop, defaultProviders, portError } from '../../plugins/loop-policy/test/driver.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const FAST = { max_retries: 0, backoff_ms: 1, backoff_max_ms: 2, token_bucket: { capacity: 100, refill_per_sec: 1000 } }

// model-protocol 的中性工具声明读 `argsSchema`（`adapters.ts:107`），与生产方
// `plugins/tools/execute/directory.ts` 及夹具 `node-io.json` 一致。
const TOOLS = [
  {
    name: 'fs.read',
    provider: 'tool-fs',
    description: '读文件',
    argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
  },
]

function chatConfig(serverUrl, overrides = {}) {
  return {
    ...configFor(serverUrl, {
      quirks: { ...configFor('').quirks, protocol: 'openai-chat' },
      params: { max_tokens: 64, reasoning: 'low' },
    }),
    vendor: 'deepseek',
    model: 'deepseek-reasoner',
    ...overrides,
  }
}

test('消费向：真实 model-protocol 消费真实消息 + 工具 schema + 推理回传形态', async () => {
  const handler = (req, res) => {
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { role: 'assistant' } }] })
    sseEvent(res, { choices: [{ delta: { content: 'Hel' } }] })
    sseEvent(res, { choices: [{ delta: { content: 'lo' } }] })
    sseEvent(res, { choices: [{ delta: { reasoning_content: 'think' } }] })
    sseEvent(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs.read', arguments: '{"path":"foo.ts"}' } }] } }] })
    sseEvent(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    sseEvent(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })
    sseEvent(res, '[DONE]')
    res.end()
  }
  const server = await startHttpServer(handler)
  const model = startModel()
  try {
    await model.hello()
    const fixture = clone(nodeIo['model.chat'].input)
    // 真实消息 + 上一轮带推理的 assistant 承接帧（reasoning 回传形态取自厂商中立夹具）。
    const messages = [
      ...fixture.messages,
      {
        role: 'assistant',
        content: '',
        reasoning: clone(vendorReasoning.deepseek),
        tool_calls: [{ id: 'call-0', name: 'fs.read', arguments: { path: 'foo.ts' } }],
      },
      { role: 'tool', tool_call_id: 'call-0', content: '42: return obj.value' },
    ]
    const frame = await model.call('chat', { config: chatConfig(server.url), messages, tools: TOOLS, resilience: FAST })
    assert.equal(frame.kind, 'result', JSON.stringify(frame))
    assert.equal(frame.value.ok, true, JSON.stringify(frame.value))
    assert.equal(frame.value.text, 'Hello')
    assert.equal(frame.value.reasoning, 'think')
    assert.deepEqual(frame.value.tool_calls, [{ id: 'call_1', name: 'fs.read', arguments: { path: 'foo.ts' } }])
    assert.deepEqual(frame.value.usage, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })

    // 供给侧断言：模型层确实消费了这些入参，并编成厂商线格式。
    const body = parseBody(server.requests[0])
    assert.equal(body.model, 'deepseek-reasoner')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, fixture.messages[0].content)
    // 工具 schema 编成 openai function 形状（中性 argsSchema → parameters）。
    assert.equal(body.tools[0].type, 'function')
    assert.equal(body.tools[0].function.name, 'fs.read')
    assert.deepEqual(body.tools[0].function.parameters, TOOLS[0].argsSchema)
    // 推理回传：deepseek 能力表按 reasoning_content 原样回传上一轮思考。
    const assistant = body.messages.filter((message) => message.role === 'assistant').pop()
    assert.equal(assistant.reasoning_content, vendorReasoning.deepseek.payload)
    assert.deepEqual(assistant.tool_calls, [
      { id: 'call-0', type: 'function', function: { name: 'fs.read', arguments: '{"path":"foo.ts"}' } },
    ])
    const tool = body.messages.find((message) => message.role === 'tool')
    assert.equal(tool.tool_call_id, 'call-0')
    // 流式分片：model.delta 事件按 text / reasoning 到达。
    const deltas = model.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload)
    assert.equal(deltas.filter((p) => typeof p.text === 'string').map((p) => p.text).join(''), 'Hello')
    assert.equal(deltas.filter((p) => typeof p.reasoning === 'string').map((p) => p.reasoning).join(''), 'think')
  } finally {
    model.close()
    await model.exit
    await server.close()
  }
})

test('供给向：真实 loop-policy 消费真实 model-protocol 的 text/reasoning/tool_calls/usage', async () => {
  let requestCount = 0
  const handler = (req, res) => {
    requestCount += 1
    sseHead(res)
    sseEvent(res, { choices: [{ delta: { role: 'assistant' } }] })
    if (requestCount === 1) {
      // 第一轮：带推理与工具调用的 assistant 产出。
      sseEvent(res, { choices: [{ delta: { reasoning_content: '先读文件' } }] })
      sseEvent(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'fs.read', arguments: '{"path":"foo.ts"}' } }] } }] })
      sseEvent(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      sseEvent(res, { choices: [{ delta: { content: 'done' } }] })
      sseEvent(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
    }
    sseEvent(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
    sseEvent(res, '[DONE]')
    res.end()
  }
  const server = await startHttpServer(handler)
  const model = startModel()
  const seen = []
  const dispatchCalls = []
  const loop = startLoop({
    providers: defaultProviders({
      'context.build': (args) => ({
        messages: [
          ...clone(nodeIo['context.assemble'].output.messages),
          ...(Array.isArray(args.extra_messages) ? clone(args.extra_messages) : []),
        ],
        params: { model: 'deepseek-reasoner', max_output: 64 },
        manifest: { dropped: 0 },
      }),
      'model.chat': (args, message) => {
        seen.push(args)
        return model
          .call('chat', args, message.env)
          .then((frame) => (frame.kind === 'error' ? portError(frame.error, frame.message) : frame.value))
      },
      'tools.dispatch': (args) => {
        dispatchCalls.push(args)
        return { results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'foo.ts' } })) }
      },
      'guard.judge': (args) => ({ decisions: args.calls.map((call, index) => ({ index, port: call.port ?? '', tool: call.tool ?? '', verdict: 'allow' })), summary: { allow: args.calls.length, escalate: 0, deny: 0 } }),
    }),
  })
  try {
    await model.hello()
    const result = await loop.interpret({ tier: 'auto', config: chatConfig(server.url), tools: TOOLS, resilience: FAST })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.equal(result.value.$directives.some((directive) => directive.kind === 'extern' && directive.payload?.kind === 'interpret'), true)

    // 解释器确实调用真实 model-protocol 两次：先工具调用，再拿到工具结果后收尾。
    assert.equal(seen.length, 2, `模型应被调两次：${JSON.stringify(seen.map((item) => item.messages?.length))}`)
    // 第二次调用的消息里含上一轮 assistant 工具调用与工具结果（解释器消费了 tool_calls 并回灌）。
    const second = seen[1].messages
    assert.ok(second.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)))
    assert.ok(second.some((message) => message.role === 'tool'))
    assert.equal(dispatchCalls.length, 1)
    // 用量随回帧可用：context 算出的 max_output 对齐进模型 config.params.max_tokens。
    assert.equal(seen[0].config.params.max_tokens, 64)
    // 真实 model-protocol 确被触达（反向帧证据 + 流式分片证据）。
    assert.ok(loop.portCalls.some((call) => call.port === 'model' && call.method === 'chat'))
    assert.equal(requestCount >= 2, true)
    const deltas = model.events.filter((event) => event.topic === 'model.delta').map((event) => event.payload)
    assert.ok(deltas.some((payload) => typeof payload.text === 'string'))
    assert.ok(deltas.some((payload) => typeof payload.reasoning === 'string'))
  } finally {
    loop.close()
    await loop.exit
    model.close()
    await model.exit
    await server.close()
  }
})
