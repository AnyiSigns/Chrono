// 上下文工程 A 组的专项测试（协议级）：
// - 工具调用 ↔ 结果配对的三条破损路径（老化 / 预算裁剪 / 中断）；
// - 前缀稳定与工具按名排序；
// - 分节 token 明细 / 真实用量解析 / 预算来源；
// - 预算降级阶梯与「仅 P0 超窗才硬错」；
// - 跨回合连贯：上一回合读过的资源以老化记录出现在本回合组装里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, chainOf, contentOf, FIXED_ENV, startService } from './driver.mjs'

const SECTION_KEYS = [
  'system',
  'tools',
  'rules',
  'history_text',
  'tool_calls',
  'tool_results',
  'reasoning',
  'input',
  'hints',
]

function toolCallsOf(message) {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

/** 每个 tool_call 都能在同批次里找到配对结果。 */
function pairingHolds(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    for (const call of toolCallsOf(messages[index])) {
      const found = messages
        .slice(index + 1)
        .some((message) => message.role === 'tool' && message.tool_call_id === call.id)
      if (!found) return false
    }
  }
  return true
}

function assistantWithCall(id, tool) {
  return { role: 'assistant', content: '', tool_calls: [{ id, name: tool, arguments: { path: 'a' } }] }
}

// ── 跨回合连贯 ─────────────────────────────────────────────────────────────

test('跨回合连贯：上一回合的工具读以「调用逐字 + 结果老化」进入本回合组装', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = chainOf([
      { id: 'm1', role: 'user', content: '看看 foo.ts' },
      {
        id: 'm2',
        role: 'assistant',
        content: '我来读文件',
        parts: [
          { type: 'text', text: '我来读文件' },
          {
            type: 'tool',
            call_id: 'c1',
            tool: 'read',
            args: { path: 'src/foo.ts' },
            result: { content: 'export const x = 1\n'.repeat(20) },
            status: 'ok',
          },
        ],
      },
      { id: 'm3', role: 'user', content: '当前轮' },
    ])
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P', session }))
    assert.equal(value.ok, true)
    const texts = value.messages.map(contentOf)
    assert.ok(texts.includes('我来读文件'), '上一回合助手正文仍在')

    const assistant = value.messages.find((message) => toolCallsOf(message).some((call) => call.id === 'c1'))
    assert.ok(assistant, '工具调用逐字回灌')
    assert.equal(toolCallsOf(assistant)[0].name, 'read')

    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(tool, '工具结果老化记录回灌')
    const aged = JSON.parse(contentOf(tool))
    assert.equal(aged.aged, true)
    assert.equal(aged.tool, 'read')
    assert.equal(aged.path, 'src/foo.ts')
    assert.ok(typeof aged.handle === 'string' && aged.handle.startsWith('h-'))
    assert.equal(pairingHolds(value.messages), true)
  } finally {
    drv.close()
  }
})

// ── 配对三条路径 ───────────────────────────────────────────────────────────

test('配对·中断：assistant(tool_calls) 无结果时合成 interrupted 占位', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = {
      turns: [
        {
          turn_id: 't1',
          conv: 'c1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'open',
          user_message: { content: 'IN' },
          steps: [
            { type: 'step.intent', turn_id: 't1', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] },
          ],
        },
      ],
    }
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session,
        config: { model: 'm1', context_window: 2000, max_output: 100, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)
    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(tool, '缺失结果必须合成占位')
    assert.equal(contentOf(tool), JSON.stringify({ ok: false, error: 'interrupted' }))
    assert.equal(pairingHolds(value.messages), true)
  } finally {
    drv.close()
  }
})

test('配对·老化：同回合工具结果超预算先老化，配对不破', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = chainOf([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        parts: [{ type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: { content: 'z '.repeat(600) }, status: 'ok' }],
      },
    ])
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session,
        config: { model: 'm1', context_window: 300, max_output: 10, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)
    assert.ok(value.manifest.degraded.includes('age_tool_results'))
    assert.equal(pairingHolds(value.messages), true)
    const tool = value.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.ok(JSON.parse(contentOf(tool)).aged)
  } finally {
    drv.close()
  }
})

test('配对·预算裁剪：atomic 组整组进出，不裁出孤儿调用', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = chainOf([
      { id: 'm1', role: 'user', content: 'old '.repeat(400) },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        parts: [
          { type: 'tool', call_id: 'c1', tool: 'read', args: { path: 'a' }, result: { content: 'r '.repeat(50) }, status: 'ok' },
        ],
      },
      { id: 'm3', role: 'user', content: 'latest' },
    ])
    const value = await drv.build(
      baseBag({ input: 'IN', system_prompt: 'P', session, config: { model: 'm1', context_window: 140, max_output: 10 } }),
    )
    assert.equal(value.ok, true)
    const hasCall = value.messages.some((message) => toolCallsOf(message).some((call) => call.id === 'c1'))
    const hasResult = value.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'c1')
    assert.equal(hasCall, hasResult, '调用与结果必须同进同出')
    assert.equal(pairingHolds(value.messages), true)
  } finally {
    drv.close()
  }
})

// ── 历史附件不再每回合重复内联 ─────────────────────────────────────────────

test('附件分层：本轮附件原样，历史附件折叠为「文本描述 + 句柄」', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const asset = { kind: 'asset', sha256: 'a'.repeat(64), mime: 'image/png', size: 4096 }
    const session = chainOf([
      { id: 'h1', role: 'user', content: '看这张图', attachments: [{ kind: 'image', name: 'pic.png', source: asset }] },
      { id: 'h2', role: 'user', content: '当前轮' },
    ])
    const value = await drv.build(
      baseBag({
        input: {
          content: '再看一张',
          attachments: [{ kind: 'image', name: 'now.png', source: { kind: 'asset', sha256: 'b'.repeat(64), mime: 'image/png', size: 8 } }],
        },
        system_prompt: 'P',
        session,
        config: { model: 'm1', context_window: 2000, max_output: 100, modalities: { input: ['text', 'image'] } },
      }),
    )
    assert.equal(value.ok, true)
    const serialized = value.messages.map(contentOf).join('\n')
    assert.ok(serialized.includes('"aged":true'), '历史附件须折叠')
    assert.ok(serialized.includes('"attachment":"image"'), '须给出附件文本描述')
    assert.ok(serialized.includes('"handle":"h-'), '须带可还原句柄')
    assert.ok(!serialized.includes(`asset:${'a'.repeat(64)}`), '历史附件不得再内联')

    const current = value.messages[value.messages.length - 1]
    assert.ok(Array.isArray(current.content), '本轮附件仍按方言内联')
    assert.equal(JSON.stringify(current.content).includes(`asset:${'b'.repeat(64)}`), true)
    assert.equal(JSON.stringify(current.content).includes('"aged"'), false)
    assert.ok(value.manifest.degraded.includes('age_attachments'))
  } finally {
    drv.close()
  }
})

// ── 前缀稳定 / 工具排序 ────────────────────────────────────────────────────

test('前缀稳定：同 bag 反复组装逐字节一致；工具按名排序，与到达顺序无关', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const build = (tools) =>
      drv.build(baseBag({ input: 'IN', system_prompt: 'P', tools }))
    const shuffled = [{ name: 'z' }, { name: 'a' }, { name: 'm' }]
    const first = await build(shuffled)
    const second = await build(shuffled)
    assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages))
    const reversed = await build(shuffled.slice().reverse())
    assert.equal(JSON.stringify(first.messages), JSON.stringify(reversed.messages), '工具到达顺序不应影响组装')

    const toolTexts = first.messages
      .map(contentOf)
      .filter((text) => text.startsWith('{"name"') || /"name":"[zam]"/.test(text))
    const names = toolTexts.map((text) => JSON.parse(text).name)
    assert.deepEqual(names, ['a', 'm', 'z'])
    // 稳定前缀（prompt → tools）位于输入之前
    const texts = first.messages.map(contentOf)
    assert.ok(texts.indexOf('P') < texts.indexOf('IN'))
  } finally {
    drv.close()
  }
})

// ── 分节 / 用量 / 预算来源 ─────────────────────────────────────────────────

test('分节 token 明细 + 真实用量解析 + 缓存命中率 + 预算来源', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        tools: [{ name: 't1', schema: { type: 'object' } }],
        usage: { prompt_tokens: 100, cached_tokens: 50, completion_tokens: 10 },
      }),
    )
    assert.equal(value.ok, true)
    assert.deepEqual(Object.keys(value.manifest.sections).sort(), SECTION_KEYS.slice().sort())
    for (const key of SECTION_KEYS) assert.equal(typeof value.manifest.sections[key], 'number')
    assert.equal(value.manifest.budget_origin, 'profile')
    assert.equal(value.manifest.usage.prompt_tokens, 100)
    assert.equal(value.manifest.usage.cached_tokens, 50)
    assert.equal(value.manifest.usage.hit_rate, 0.5)
    assert.equal(typeof value.manifest.usage.correction_factor, 'number')
    assert.equal(value.manifest.flags.includes('profile_missing'), false)

    const missing = await drv.build(baseBag({ config: null }))
    assert.equal(missing.ok, true)
    assert.equal(missing.manifest.budget_origin, 'default')
    assert.equal(missing.manifest.flags.includes('profile_missing'), true)
  } finally {
    drv.close()
  }
})

// ── 同回合推理回灌 ─────────────────────────────────────────────────────────

test('同回合推理回灌：step.result 的中立块原样携带，payload / signature / encrypted 不改写', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const block = {
      provider: 'anthropic',
      model: 'm1',
      form: 'text',
      payload: '思考内容',
      signature: 'sig-abc',
      encrypted: 'enc-xyz',
      tokens: 7,
    }
    const session = {
      turns: [
        {
          turn_id: 't1',
          conv: 'c1',
          at: '2026-01-01T00:00:00.000Z',
          state: 'open',
          user_message: { content: 'IN' },
          steps: [
            {
              type: 'step.result',
              turn_id: 't1',
              seq: 1,
              assistant: { content: '' },
              reasoning: block,
              tool_results: [{ call_id: 'c1', ok: true, result: { content: 'x' } }],
            },
          ],
        },
      ],
    }
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session,
        config: { model: 'm1', context_window: 2000, max_output: 100, protocol: 'openai-chat' },
      }),
    )
    assert.equal(value.ok, true)
    const assistant = value.messages.find((message) => message.role === 'assistant' && message.reasoning !== undefined)
    assert.deepEqual(assistant.reasoning, block, '中立块必须原样携带')
    assert.ok(value.manifest.sections.reasoning > 0, '推理计入 reasoning 分节')
  } finally {
    drv.close()
  }
})

// ── 预算降级阶梯 ───────────────────────────────────────────────────────────

test('降级：输入超预算走截断而非失败；硬错仅在 P0（系统提示）超窗且指名元素', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const truncated = await drv.build(
      baseBag({
        input: 'i '.repeat(2000),
        system_prompt: 'P',
        config: { model: 'm1', context_window: 200, max_output: 10 },
      }),
    )
    assert.equal(truncated.ok, true, '超预算不得硬死')
    assert.ok(truncated.manifest.degraded.includes('truncate_input'))
    assert.ok(truncated.manifest.used <= truncated.manifest.budget)
    const hasMarker = truncated.messages.some((message) => contentOf(message).includes('被截断'))
    assert.equal(hasMarker, true)

    const hard = await drv.build(
      baseBag({
        system_prompt: 'a '.repeat(200),
        config: { model: 'm1', context_window: 100, max_output: 10 },
      }),
    )
    assert.equal(hard.ok, false)
    assert.equal(hard.code, 'budget_impossible')
    assert.ok(hard.message.includes('prompt'), `须指名过大元素：${hard.message}`)
  } finally {
    drv.close()
  }
})

// ── 大产物阈值经 bag.thresholds 下传 ───────────────────────────────────────

test('大产物阈值：bag.thresholds.large_artifact_bytes 生效（达阈即老化，标 age_large_artifacts）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const session = chainOf([
      {
        id: 'turn-1',
        role: 'assistant',
        content: '读文件',
        parts: [
          { type: 'text', text: '读文件' },
          {
            type: 'tool',
            call_id: 'c1',
            tool: 'read',
            args: { path: 'src/foo.ts' },
            result: { content: 'x'.repeat(200) },
            status: 'ok',
          },
        ],
      },
    ])
    const large = await drv.build(
      baseBag({ input: 'IN', system_prompt: 'P', session, thresholds: { large_artifact_bytes: 1000000 } }),
    )
    assert.equal(large.manifest.degraded.includes('age_large_artifacts'), false)
    const small = await drv.build(
      baseBag({ input: 'IN', system_prompt: 'P', session, thresholds: { large_artifact_bytes: 32 } }),
    )
    assert.ok(small.manifest.degraded.includes('age_large_artifacts'), 'bag.thresholds 应覆盖本包 policy 默认')
  } finally {
    drv.close()
  }
})
