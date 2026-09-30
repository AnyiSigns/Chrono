// 单元级测试：policy 解析、前缀和、规范化键、计数缓存、老化 / 配对 / 预算阶梯。
// 纯函数直调时经 `setLocalCountProvider` 注入进程内 v1 计数（生产服务走反向批量 count，不设此来源）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countText } from './fakes.mjs'

process.env.CHRONO_PLUGIN_STATE = ''

const { setLocalCountProvider } = await import('../execute/tokens.ts')
setLocalCountProvider((text) => countText(text))

const { parsePolicy, defaultPolicy, loadPolicy } = await import('../execute/policy.ts')
const {
  prefixSums,
  rangeSum,
  computeDedupKey,
  computeContentKey,
  computeTokenKey,
  normalizeText,
  countParts,
  cachedDedupKey,
  cacheSizes,
  CACHE_MAX_ENTRIES,
} = await import('../execute/text.ts')
const { canonicalize } = await import('../execute/normalize.ts')
const { allocate } = await import('../execute/budget.ts')
const { parseRawParts, messageParts } = await import('../execute/history.ts')
const { projectContext } = await import('../execute/project.ts')
const { turnMetadata } = await import('../execute/views.ts')
const { ageResultText, interruptedResult } = await import('../execute/aging.ts')
const { repairPairing, missingResults } = await import('../execute/pairing.ts')

test('parts 宽松解析：推理块跨回合丢弃；工具卡提升为可回灌调用', () => {
  const parsed = parseRawParts([
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '正文' },
    {
      type: 'tool',
      call_id: 'c1',
      tool: 'read',
      args: { path: 'a' },
      render: { form: 'line' },
      result: { ok: true },
      status: 'ok',
    },
  ])
  assert.deepEqual(parsed.parts, [{ type: 'text', text: '正文' }])
  assert.equal(parsed.hasToolCall, true)
  assert.deepEqual(parsed.toolParts, [
    { callId: 'c1', tool: 'read', args: { path: 'a' }, result: { ok: true }, status: 'ok' },
  ])
  // 只剩展示 part 且 content 为空 → 空 parts（不留空消息）
  assert.deepEqual(
    messageParts({ content: '', parts: [{ type: 'reasoning', text: 'x' }] }).parts,
    [],
  )
  // content 非空仍回落正文
  assert.deepEqual(messageParts({ content: 'hi' }).parts, [{ type: 'text', text: 'hi' }])
})

test('policy：缺键回落默认；非法顶层抛错', () => {
  const parsed = parsePolicy({ version: 2, budget: { margin_ratio: 0.1 } })
  assert.equal(parsed.version, 2)
  assert.equal(parsed.budget.margin_ratio, 0.1)
  assert.equal(parsed.budget.default_context_window, defaultPolicy().budget.default_context_window)
  assert.throws(() => parsePolicy(null), /must be a JSON object/)
})

test('policy：随包 policy.json 可加载且前缀边界正确', () => {
  const policy = loadPolicy()
  assert.deepEqual(policy.prefix.stable, ['prompt', 'tools'])
  assert.deepEqual(policy.prefix.order, ['history', 'skill', 'style'])
  assert.ok(policy.messages.input_truncated.length > 0)
})

test('前缀和与区间求和', () => {
  const sums = prefixSums([1, 2, 3, 4])
  assert.deepEqual(sums, [0, 1, 3, 6, 10])
  assert.equal(rangeSum(sums, 1, 3), 5)
  assert.equal(rangeSum(sums, 0, 4), 10)
})

test('规范化键：空白差异等价；角色参与 dedup_key、不参与 content_key', () => {
  assert.equal(normalizeText('  a   b \n c '), 'a b c')
  const parts = [{ type: 'text', text: 'a  b' }]
  assert.equal(
    computeDedupKey('user', parts),
    computeDedupKey('user', [{ type: 'text', text: 'a b' }]),
  )
  assert.notEqual(computeDedupKey('user', parts), computeDedupKey('system', parts))
  assert.equal(computeContentKey(parts), computeContentKey([{ type: 'text', text: 'a b' }]))
})

test('计数缓存键按原始内容：规范化等价不得共用计数缓存', () => {
  const base = {
    source: 'input',
    priority: 0,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint: 0,
  }
  const spaced = canonicalize([
    { ...base, role: 'user', parts: [{ type: 'text', text: 'hello   world' }] },
  ])[0]
  const single = canonicalize([
    { ...base, role: 'user', parts: [{ type: 'text', text: 'hello world' }] },
  ])[0]
  // 去重键同（规范化等价），但计数缓存键必须按原始文本区分，避免串计数
  assert.equal(spaced.dedupKey, single.dedupKey)
  assert.notEqual(spaced.cacheKey, single.cacheKey)
  // 资产参与计数键：同文本但资产不同不得共用
  const image = { type: 'image', asset: { sha256: 'a'.repeat(64), mime: 'image/png' }, name: null }
  assert.notEqual(
    computeTokenKey([{ type: 'text', text: 'x' }]),
    computeTokenKey([{ type: 'text', text: 'x' }, image]),
  )
})

test('改写 parts 的 tokenKey 与 def 键区隔：同 def 改写后不复用旧计数 / dedup', () => {
  const base = {
    source: 'history',
    priority: 4,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint: 0,
  }
  const original = canonicalize([
    { ...base, role: 'assistant', parts: [{ type: 'text', text: 'hi all' }], defKey: 'h1' },
  ])[0]
  const rewrittenParts = [{ type: 'text', text: 'alice: hi all' }]
  const rewritten = canonicalize([
    {
      ...base,
      role: 'assistant',
      parts: rewrittenParts,
      defKey: 'h1',
      tokenKey: computeTokenKey(rewrittenParts),
    },
  ])[0]
  assert.equal(rewritten.tokens, countParts(rewrittenParts, computeTokenKey(rewrittenParts)))
  assert.notEqual(rewritten.tokens, original.tokens)
  assert.notEqual(rewritten.dedupKey, original.dedupKey)
})

test('预算分配：budget ≤ 0 走 budget_exceeded 结构化错误（防御性兜底）', () => {
  const result = allocate([], 0, defaultPolicy())
  assert.equal(result.error?.code, 'budget_exceeded')
})

test('上下文投影：只读步日志；会话级 refs 全量（含别的会话）不串历史', () => {
  const refs = {
    'h-other-0': { id: 'msg-other-0', role: 'user', content: '别的会话' },
    'h-other-1': { id: 'msg-other-1', role: 'assistant', content: '回答' },
  }
  // refs 有内容但 turns 为空 ⇒ 历史为空（不再沿 refs 还原）。
  const refOnly = { head: 'h-other-1', refs, turns: [] }
  assert.deepEqual(projectContext(refOnly, turnMetadata(refOnly)).records, [])

  // 只有 turns 被投影（refs 被完全忽略）。
  const session = {
    head: 'h-other-1',
    refs,
    turns: [
      {
        turn_id: 't1',
        conv: 'c1',
        at: '2026-01-01T00:00:00.000Z',
        state: 'open',
        user_message: { content: '本会话' },
        steps: [],
      },
    ],
  }
  const records = projectContext(session, turnMetadata(session)).records
  assert.deepEqual(
    records.map((record) => record.parts[0].text),
    ['本会话'],
  )
})

test('缓存有界：超过上限按 LRU 淘汰，不单调增长', () => {
  const parts = [{ type: 'text', text: 'x' }]
  for (let i = 0; i < CACHE_MAX_ENTRIES + 100; i += 1) countParts(parts, `k-${i}`)
  assert.equal(cacheSizes().tokens, CACHE_MAX_ENTRIES)
  for (let i = 0; i < CACHE_MAX_ENTRIES + 100; i += 1) cachedDedupKey(`n-${i}`, 'user', parts)
  assert.equal(cacheSizes().normalize, CACHE_MAX_ENTRIES)
})

// ── 工具结果老化 / 配对 / 预算阶梯 / 校准 ───────────────────────────────────

function raw(overrides) {
  return {
    role: 'user',
    parts: [{ type: 'text', text: 'x' }],
    source: 'history',
    priority: 4,
    at: 0,
    atomic: false,
    atomicGroup: null,
    toolCallId: null,
    from: null,
    orderHint: 0,
    ...overrides,
  }
}

test('老化：同输入同输出；带资源身份 / 规模 / 截断尾部 / 句柄', () => {
  const args = { path: 'src/a.ts' }
  const result = { content: 'line\n'.repeat(100), lines: 100 }
  const first = ageResultText('read', args, 'call-1', result, true)
  const second = ageResultText('read', args, 'call-1', result, true)
  assert.equal(first, second)
  const parsed = JSON.parse(first)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.aged, true)
  assert.equal(parsed.tool, 'read')
  assert.equal(parsed.path, 'src/a.ts')
  assert.equal(parsed.count, 100)
  assert.ok(String(parsed.handle).startsWith('h-'))
  assert.ok(parsed.tail.length > 0 && parsed.tail.length <= 160)
  // 不同调用的句柄不同
  assert.notEqual(
    parsed.handle,
    JSON.parse(ageResultText('read', args, 'call-2', result, true)).handle,
  )
  assert.equal(interruptedResult(), '{"ok":false,"error":"interrupted"}')
})

test('配对：缺失结果的工具调用合成 interrupted 占位，自检归零', () => {
  const messages = canonicalize([
    raw({
      role: 'assistant',
      parts: [],
      source: 'tool',
      priority: 4,
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }],
      atomic: true,
      atomicGroup: 1,
    }),
  ])
  assert.deepEqual(missingResults(messages), ['c1'])
  const repaired = repairPairing(messages)
  assert.deepEqual(missingResults(repaired), [])
  const tool = repaired.find((message) => message.role === 'tool')
  assert.equal(tool.toolCallId, 'c1')
  assert.equal(
    JSON.stringify(tool.parts),
    JSON.stringify([{ type: 'text', text: interruptedResult() }]),
  )
})

test('预算降级阶梯：老化 → 丢推理 → 截断输入；只有 P0 超窗才硬错', () => {
  const policy = defaultPolicy()
  // P0（系统提示）本身超窗 → budget_impossible 且指名元素
  const hugePrompt = canonicalize([
    raw({
      role: 'system',
      source: 'prompt',
      priority: 0,
      parts: [{ type: 'text', text: 'a '.repeat(100) }],
    }),
  ])
  const hard = allocate(hugePrompt, 50, policy)
  assert.equal(hard.error?.code, 'budget_impossible')
  assert.ok(hard.error.message.includes('prompt'))

  // 老化：同回合工具结果过大，先老化再分配
  const withTool = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'tool',
      source: 'tool',
      toolCallId: 'c1',
      priority: 4,
      parts: [
        { type: 'text', text: JSON.stringify({ ok: true, result: { content: 'z '.repeat(400) } }) },
      ],
      toolResult: {
        tool: 'read',
        args: { path: 'a' },
        verbatim: JSON.stringify({ ok: true, result: { content: 'z '.repeat(400) } }),
      },
    }),
  ])
  const aged = allocate(withTool, 200, policy)
  assert.ok(aged.degraded.includes('age_tool_results'))
  assert.equal(aged.error, null)
  const toolText = aged.kept
    .filter((message) => message.role === 'tool')
    .map((message) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .join('')
  assert.ok(toolText.includes('"aged":true'))

  // 丢推理：内容超预算来自推理块
  const withReasoning = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'assistant',
      source: 'tool',
      priority: 4,
      parts: [],
      reasoning: {
        provider: '',
        model: 'm',
        form: 'text',
        payload: 'r '.repeat(80),
        signature: '',
        encrypted: '',
        tokens: 0,
      },
    }),
  ])
  const dropped = allocate(withReasoning, 40, policy)
  assert.deepEqual(dropped.degraded, ['drop_reasoning'])
  assert.equal(dropped.used, 1)

  // 截断输入：输入超预算但 P0 未超
  const bigInput = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'user',
      source: 'input',
      priority: 0,
      orderHint: 1,
      parts: [{ type: 'text', text: 'i '.repeat(400) }],
    }),
  ])
  const truncated = allocate(bigInput, 40, policy)
  assert.ok(truncated.degraded.includes('truncate_input'))
  assert.equal(truncated.error, null)
  const input = truncated.kept.find((message) => message.source === 'input')
  const text = input.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
  assert.ok(text.includes(policy.messages.input_truncated))
  assert.ok(truncated.used <= 40)
})

test('降级阶梯按序生效：老化 → 丢推理 → 丢老回合 → 截断输入', () => {
  const policy = defaultPolicy()
  const verbatim = JSON.stringify({ ok: true, result: { content: 'z '.repeat(300) } })
  const messages = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'tool',
      source: 'tool',
      priority: 4,
      parts: [{ type: 'text', text: verbatim }],
      toolResult: { tool: 'read', args: { path: 'a' }, verbatim },
    }),
    raw({
      role: 'assistant',
      source: 'tool',
      priority: 4,
      parts: [],
      reasoning: {
        provider: '',
        model: 'm',
        form: 'text',
        payload: 'r '.repeat(80),
        signature: '',
        encrypted: '',
        tokens: 0,
      },
    }),
    raw({
      role: 'user',
      source: 'input',
      priority: 0,
      orderHint: 1,
      parts: [{ type: 'text', text: 'i '.repeat(400) }],
    }),
  ])
  const result = allocate(messages, 120, policy)
  assert.equal(result.error, null)
  const ladder = [
    'age_tool_results',
    'drop_reasoning',
    'drop_old_turns',
    'truncate_input',
  ]
  let cursor = 0
  for (const step of result.degraded) {
    const index = ladder.indexOf(step)
    assert.ok(index >= cursor, `梯级乱序：${result.degraded.join(' → ')}`)
    cursor = index
  }
  for (const expected of ['age_tool_results', 'drop_reasoning', 'truncate_input']) {
    assert.ok(
      result.degraded.includes(expected),
      `缺梯级 ${expected}：${result.degraded.join(' → ')}`,
    )
  }
})

test('降级阶梯标签：配额裁不算 drop_old_turns', () => {
  const policy = defaultPolicy()
  // 配额（skill）超限被裁、历史仍在预算内 → 只有 quota，不得登记 drop_old_turns。
  const messages = canonicalize([
    raw({ role: 'system', source: 'prompt', priority: 0, parts: [{ type: 'text', text: 'P' }] }),
    raw({
      role: 'system',
      source: 'skill',
      priority: 2,
      parts: [{ type: 'text', text: 'k '.repeat(500) }],
    }),
    raw({ role: 'user', source: 'history', priority: 4, parts: [{ type: 'text', text: 'h' }] }),
  ])
  const result = allocate(messages, 100, policy)
  assert.equal(result.error, null)
  assert.ok(result.trimmed.some((entry) => entry.source === 'skill' && entry.reason === 'quota'))
  assert.equal(result.degraded.includes('drop_old_turns'), false, '配额裁不是历史裁剪')
})
