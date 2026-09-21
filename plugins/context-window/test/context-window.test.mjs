// `context-window` 服务协议级测试（node --test）：合成 bag 驱动 `context.build`，收 `context.assembled` 事件。
// 覆盖：流水线各阶段、预算两路错误、atomic 组、前缀序、三方言、多模态降级、TTL、covered_upto、
// 75% 只追加一条、交错引导幂等且不含工具标识符、thread_kind 四路、事件载荷、回放纪律、错误不崩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseBag, chainOf, contentOf, FIXED_ENV, PKG_ROOT, startService } from './driver.mjs'

const COMPRESS_HINT = '上下文接近预算上限；请先用自然语言总结并压缩较早的上下文，再继续。'
const GUIDANCE = '请用自然语言说明下一步要做什么；不要引用工具标识符，也不要复述参数。'
const TOOL_IDENTIFIERS = ['read', 'write', 'grep', 'glob', 'shell', 'fsop', 'exec', 'tool.', 'tool-fs', 'context', 'session', 'sandbox', 'capability', 'port']

function eventsSince(drv, before) {
  return drv.events.slice(before)
}

function textMessages(value) {
  return value.messages.map(contentOf)
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'context-window')
    assert.deepEqual(manifest.implements, ['context'])
    assert.deepEqual(manifest.methods.context, ['build'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const drv = startService()
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
})

test('native 缺失 ⇒ 服务启动即失败（在 hello 前退出非 0，不回落 JS 计数）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-no-native-'))
  cpSync(join(PKG_ROOT, 'execute'), join(dir, 'execute'), { recursive: true })
  cpSync(join(PKG_ROOT, 'plugin.json'), join(dir, 'plugin.json'))
  cpSync(join(PKG_ROOT, 'schema'), join(dir, 'schema'), { recursive: true })
  const child = spawn(process.execPath, [join(dir, 'execute', 'main.ts')], {
    env: { ...process.env, CHRONO_PLUGIN_STATE: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  const code = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill()
      resolveExit('timeout')
    }, 10000)
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolveExit(exitCode)
    })
  })
  assert.notEqual(code, 0)
})

// ── 组装与事件 ─────────────────────────────────────────────────────────────

test('build 成功：messages / params / manifest，事件载荷带帧 env 的 run/thread', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const value = await drv.build(baseBag())
    assert.equal(value.ok, true)
    assert.ok(Array.isArray(value.messages))
    assert.equal(value.params.model, 'm1')
    assert.equal(value.params.max_output, 100)
    assert.equal(value.manifest.run, 'run-1')
    assert.equal(value.manifest.thread, 't1')
    assert.equal(value.manifest.budget, 850)
    assert.ok(value.manifest.used > 0)
    assert.equal(value.manifest.sources.prompt.count, 1)
    const emitted = eventsSince(drv, before)
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].topic, 'context.assembled')
    assert.equal(emitted[0].payload.run, 'run-1')
    assert.equal(emitted[0].payload.thread, 't1')
    assert.equal(emitted[0].payload.model, 'm1')
    assert.deepEqual(emitted[0].payload.flags, [])
  } finally {
    drv.close()
  }
})

test('前缀缓存排序：prompt → tools → L2 → L1 → 技能 → 召回 → 历史 → 风格 → input', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        tools: [{ name: 't1', description: 'd', schema: { type: 'object' } }],
        memories: {
          l2: { summary: 'L2T' },
          prev_l1: { summary: 'PL1T' },
          l1: { summary: 'L1T' },
        },
        skills: [{ name: 's1', content: 'SK' }],
        recall: [{ entry: 'REC', score: 1 }],
        session: chainOf([{ id: 'h1', role: 'user', content: 'HIST' }]),
        style: 'STY',
      }),
    )
    const texts = textMessages(value)
    assert.equal(texts[0], 'P')
    assert.equal(texts[1], '{"name":"t1","description":"d","schema":{"type":"object"}}')
    assert.deepEqual(texts.slice(2), [
      '[工作区记忆]\nL2T',
      '[上一会话摘要]\nPL1T',
      '[本会话摘要]\nL1T',
      '[技能 s1]\nSK',
      'REC',
      'HIST',
      'STY',
      'IN',
    ])
  } finally {
    drv.close()
  }
})

// ── 去重 / 冲突 ────────────────────────────────────────────────────────────

test('去重：规范化等价（空白差异）只留最新一条', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session: chainOf([
          { id: 'a', role: 'user', content: 'hello   world' },
          { id: 'b', role: 'user', content: 'hello world' },
        ]),
      }),
    )
    const history = value.messages.filter((m) => m.content === 'hello world' || m.content === 'hello   world')
    assert.equal(history.length, 1)
    assert.equal(history[0].content, 'hello world')
    assert.equal(value.manifest.deduped, 1)
  } finally {
    drv.close()
  }
})

test('跨来源去重：召回与历史内容一致 → 丢召回副本', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        recall: [{ entry: 'dup', score: 5 }],
        session: chainOf([{ id: 'h', role: 'user', content: 'dup' }]),
      }),
    )
    assert.equal(value.manifest.sources.recall.count, 0)
    assert.equal(value.manifest.deduped, 1)
    const dups = textMessages(value).filter((text) => text === 'dup')
    assert.equal(dups.length, 1)
  } finally {
    drv.close()
  }
})

test('冲突消解：同 subject 多版本取 at 最新', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: {
          l2: { summary: 'old', subject: 'proj', at: 1000 },
          l1: { summary: 'new', subject: 'proj', at: 2000 },
        },
      }),
    )
    const texts = textMessages(value)
    assert.ok(texts.includes('[本会话摘要]\nnew'))
    assert.ok(!texts.includes('[工作区记忆]\nold'))
    assert.ok(value.manifest.trimmed.some((entry) => entry.reason === 'conflict'))
  } finally {
    drv.close()
  }
})

// ── 预算 / 配额 ────────────────────────────────────────────────────────────

test('budget_impossible：P0 + P1 超预算（结构化错误值，非崩溃）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const before = drv.events.length
    const value = await drv.build(
      baseBag({
        system_prompt: 'a '.repeat(100),
        memories: { l1: { summary: 'b '.repeat(50) } },
        config: { model: 'm1', context_window: 100, max_output: 10 },
      }),
    )
    assert.equal(value.ok, false)
    assert.equal(value.code, 'budget_impossible')
    assert.equal(value.budget, 85)
    const emitted = eventsSince(drv, before)
    assert.equal(emitted[0].payload.flags.includes('budget_impossible'), true)
    assert.ok(Array.isArray(emitted[0].payload.trimmed))
  } finally {
    drv.close()
  }
})

test('budget_exceeded：退化预算（≤ 0）走结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({ config: { model: 'm1', context_window: 100, max_output: 100 } }),
    )
    assert.equal(value.ok, false)
    assert.equal(value.code, 'budget_exceeded')
  } finally {
    drv.close()
  }
})

test('配额下滚：技能超额被裁，未用额度给历史', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const skills = [1, 2, 3, 4, 5].map((index) => ({ name: `s${index}`, content: 'k '.repeat(400) }))
    const historyMessages = [1, 2, 3, 4].map((index) => ({
      id: `h${index}`,
      role: 'user',
      content: `m${index} ` + 'w '.repeat(50),
    }))
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        skills,
        session: chainOf(historyMessages),
        config: { model: 'm1', context_window: 2000, max_output: 100 },
      }),
    )
    assert.equal(value.ok, true)
    assert.equal(value.manifest.sources.skill.count, 0)
    assert.ok(value.manifest.trimmed.filter((entry) => entry.source === 'skill' && entry.reason === 'quota').length >= 1)
    assert.equal(value.manifest.sources.history.count, historyMessages.length)
    assert.ok(value.manifest.used <= value.manifest.budget)
  } finally {
    drv.close()
  }
})

test('atomic 组不被裁散：工具调用 + 结果同进同出', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session: chainOf([
          { id: 'm1', role: 'user', content: 'old '.repeat(200) },
          { id: 'm2', role: 'assistant', parts: [{ type: 'tool_call', name: 'read', args: { path: 'a' } }] },
          { id: 'm3', role: 'tool', content: 'tool result', tool_call_id: 'call-1' },
          { id: 'm4', role: 'user', content: 'latest' },
        ]),
        config: { model: 'm1', context_window: 100, max_output: 1 },
      }),
    )
    const texts = textMessages(value)
    const hasToolCall = texts.some((text) => text.includes('"type":"tool_call"'))
    const hasToolResult = texts.includes('tool result')
    assert.equal(hasToolCall, hasToolResult)
    assert.equal(hasToolCall, true)
    assert.ok(!texts.some((text) => text.startsWith('old ')))
    assert.ok(value.manifest.trimmed.some((entry) => entry.source === 'history' && entry.reason === 'budget'))
  } finally {
    drv.close()
  }
})

test('召回按配额截断并按分数降序', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        recall: [
          { entry: 'low', score: 1, content: 'l '.repeat(200) },
          { entry: 'high', score: 9, content: 'h '.repeat(200) },
          { entry: 'mid', score: 5, content: 'm '.repeat(200) },
        ],
        config: { model: 'm1', context_window: 2000, max_output: 100 },
      }),
    )
    assert.equal(value.manifest.sources.recall.count, 1)
    assert.equal(value.manifest.recall.length, 1)
    assert.equal(value.manifest.recall[0].entry, 'high')
    assert.ok(value.manifest.trimmed.some((entry) => entry.source === 'recall' && entry.reason === 'quota'))
  } finally {
    drv.close()
  }
})

// ── 方言 / 多模态 ──────────────────────────────────────────────────────────

const IMAGE_BAG = {
  input: {
    content: 'see',
    attachments: [
      { kind: 'image', name: 'pic.png', source: { kind: 'asset', sha256: 'a'.repeat(64), mime: 'image/png', size: 10 } },
    ],
  },
}

function inputMessage(value) {
  return value.messages[value.messages.length - 1]
}

test('openai-chat 方言：content parts 形状（text + image_url）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({ ...IMAGE_BAG, config: { model: 'm1', context_window: 1000, max_output: 100, protocol: 'openai-chat' } }),
    )
    const message = inputMessage(value)
    assert.equal(message.role, 'user')
    assert.ok(Array.isArray(message.content))
    assert.deepEqual(message.content[0], { type: 'text', text: 'see' })
    assert.deepEqual(message.content[1], { type: 'image_url', image_url: { url: `asset:${'a'.repeat(64)}` } })
  } finally {
    drv.close()
  }
})

test('openai-responses 方言：input_text + input_image', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        ...IMAGE_BAG,
        config: { model: 'm1', context_window: 1000, max_output: 100, protocol: 'openai-responses' },
      }),
    )
    const message = inputMessage(value)
    assert.deepEqual(message.content[0], { type: 'input_text', text: 'see' })
    assert.deepEqual(message.content[1], { type: 'input_image', image_url: `asset:${'a'.repeat(64)}` })
  } finally {
    drv.close()
  }
})

test('anthropic-messages 方言：image source = asset 引用', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        ...IMAGE_BAG,
        config: { model: 'm1', context_window: 1000, max_output: 100, protocol: 'anthropic-messages' },
      }),
    )
    const message = inputMessage(value)
    assert.deepEqual(message.content[0], { type: 'text', text: 'see' })
    assert.deepEqual(message.content[1], {
      type: 'image',
      source: { type: 'asset', sha256: 'a'.repeat(64), mime: 'image/png' },
    })
  } finally {
    drv.close()
  }
})

test('多模态降级：模型不支持该模态 → 文本引用 + flags modality_dropped', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        ...IMAGE_BAG,
        config: { model: 'm1', context_window: 1000, max_output: 100, protocol: 'openai-chat', modalities: { input: ['text'] } },
      }),
    )
    const message = inputMessage(value)
    assert.ok(JSON.stringify(message.content).includes('附件'))
    assert.equal(value.manifest.flags.includes('modality_dropped'), true)
  } finally {
    drv.close()
  }
})

// ── TTL / covered_upto ─────────────────────────────────────────────────────

test('TTL：过期 L1 不注入且 flags 记 l1_expired', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: {
          l2: { summary: 'fresh', at: 1000 },
          l1: { summary: 'stale', expires_at: FIXED_ENV.now - 1, at: 1 },
        },
      }),
    )
    const texts = textMessages(value)
    assert.ok(texts.includes('[工作区记忆]\nfresh'))
    assert.ok(!texts.some((text) => text.includes('stale')))
    assert.equal(value.manifest.sources.l1.count, 0)
    assert.equal(value.manifest.flags.includes('l1_expired'), true)
  } finally {
    drv.close()
  }
})

test('TTL：过期 L2 不注入且 flags 记 l2_expired（不复用 l1_expired）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: {
          l2: { summary: 'stale-ws', expires_at: FIXED_ENV.now - 1, at: 1 },
          l1: { summary: 'fresh', at: 1 },
        },
      }),
    )
    const texts = textMessages(value)
    assert.ok(texts.includes('[本会话摘要]\nfresh'))
    assert.ok(!texts.some((text) => text.includes('stale-ws')))
    assert.equal(value.manifest.sources.l2.count, 0)
    assert.equal(value.manifest.flags.includes('l2_expired'), true)
    assert.equal(value.manifest.flags.includes('l1_expired'), false)
  } finally {
    drv.close()
  }
})

test('covered_upto：边界之前的轮次不进组装', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: { l1: { summary: 'sum', covered_upto: 'm1' } },
        session: chainOf([
          { id: 'm1', role: 'user', content: 'one' },
          { id: 'm2', role: 'assistant', content: 'two' },
          { id: 'm3', role: 'user', content: 'three' },
        ]),
      }),
    )
    const texts = textMessages(value)
    assert.ok(!texts.includes('one'))
    assert.deepEqual(texts.filter((text) => ['two', 'three'].includes(text)), ['two', 'three'])
    assert.equal(value.manifest.sources.history.count, 2)
    assert.equal(value.manifest.sources.l1.count, 1)
  } finally {
    drv.close()
  }
})

test('covered_upto 失效：丢弃该 L1 + flags l1_invalid，历史全量', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        memories: { l1: { summary: 'sum', covered_upto: 'missing' } },
        session: chainOf([
          { id: 'm1', role: 'user', content: 'one' },
          { id: 'm2', role: 'assistant', content: 'two' },
        ]),
      }),
    )
    assert.equal(value.manifest.sources.l1.count, 0)
    assert.equal(value.manifest.flags.includes('l1_invalid'), true)
    assert.equal(value.manifest.sources.history.count, 2)
  } finally {
    drv.close()
  }
})

// ── 75% / 交错引导 ─────────────────────────────────────────────────────────

test('75% 触发：只追加一条压缩提示', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'a '.repeat(80),
        system_prompt: 'P',
        config: { model: 'm1', context_window: 100, max_output: 1 },
      }),
    )
    const texts = textMessages(value)
    assert.equal(texts.filter((text) => text === COMPRESS_HINT).length, 1)
    assert.equal(texts[texts.length - 1], COMPRESS_HINT)
  } finally {
    drv.close()
  }
})

test('交错引导：含工具结果时幂等追加一条，文案不含工具标识符', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        input: 'IN',
        system_prompt: 'P',
        session: chainOf([
          { id: 'm1', role: 'assistant', parts: [{ type: 'tool_call', name: 'read', args: {} }] },
          { id: 'm2', role: 'tool', content: 'result', tool_call_id: 'c1' },
        ]),
      }),
    )
    const texts = textMessages(value)
    assert.equal(texts.filter((text) => text === GUIDANCE).length, 1)
    assert.equal(texts[texts.length - 1], GUIDANCE)
    const lowered = GUIDANCE.toLowerCase()
    for (const identifier of TOOL_IDENTIFIERS) {
      assert.equal(lowered.includes(identifier), false, `引导语含工具标识符：${identifier}`)
    }
  } finally {
    drv.close()
  }
})

test('无工具结果时不追加交错引导', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(baseBag({ input: 'IN', system_prompt: 'P' }))
    assert.ok(!textMessages(value).includes(GUIDANCE))
  } finally {
    drv.close()
  }
})

// ── 线程口径 ───────────────────────────────────────────────────────────────

test('thread_kind=subagent：去上一会话 L1，加父摘要 / 任务提示词 / 未读收件箱', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        thread_kind: 'subagent',
        input: 'IN',
        system_prompt: 'P',
        memories: { prev_l1: { summary: 'prev' }, l1: { summary: 'cur' } },
        parent_summaries: [{ summary: 'parent' }],
        task_prompt: 'task',
        inbox_unread: [{ kind: 'instruction', body: 'go', from: 'parent' }],
      }),
    )
    const texts = textMessages(value)
    assert.ok(!texts.some((text) => text.includes('[上一会话摘要]')))
    assert.ok(texts.includes('[本会话摘要]\ncur'))
    assert.ok(texts.includes('[父会话摘要]\nparent'))
    assert.ok(texts.includes('task'))
    assert.ok(texts.some((text) => text.includes('[收件箱 instruction')))
  } finally {
    drv.close()
  }
})

test('thread_kind=group：群聊 transcript 带发言者名 + 人格 + 议题', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        thread_kind: 'group',
        input: 'IN',
        system_prompt: 'P',
        persona: 'p',
        topic: 't',
        session: chainOf([{ id: 'g1', role: 'assistant', content: 'hi all', from: 'alice' }]),
      }),
    )
    const texts = textMessages(value)
    assert.ok(texts.includes('alice: hi all'))
    assert.ok(texts.includes('[本轮发言者人格]\np'))
    assert.ok(texts.includes('[圆桌议题]\nt'))
  } finally {
    drv.close()
  }
})

test('thread_kind=workflow：不组装消息历史', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        thread_kind: 'workflow',
        input: 'IN',
        system_prompt: 'P',
        session: chainOf([{ id: 'm1', role: 'user', content: 'HIST' }]),
      }),
    )
    assert.equal(value.manifest.sources.history.count, 0)
    assert.ok(!textMessages(value).includes('HIST'))
  } finally {
    drv.close()
  }
})

// ── 回放纪律 / 错误 ────────────────────────────────────────────────────────

test('同 bag 两次调用逐字节一致（回放纪律）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const bag = baseBag({
      input: 'IN',
      system_prompt: 'P',
      tools: [{ name: 't1', schema: { type: 'object' } }],
      memories: { l2: { summary: 'l2' }, l1: { summary: 'l1' } },
      skills: [{ name: 's', content: 'sk' }],
      recall: [{ entry: 'r', score: 1 }],
      session: chainOf([
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'two' },
      ]),
      style: 'st',
    })
    const first = await drv.build(bag)
    const second = await drv.build(bag)
    assert.equal(JSON.stringify(first), JSON.stringify(second))
  } finally {
    drv.close()
  }
})

test('错误不崩进程：坏 args / 未知方法后仍可正常服务', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const badArgs = await drv.buildRaw(null)
    assert.equal(badArgs.kind, 'error')
    assert.equal(badArgs.code, 'bad_args')

    const unknown = await drv.request('call', { port: 'context', method: 'nope', args: {} }, 'error')
    assert.equal(unknown.code, 'unknown_method')

    const unknownCap = await drv.request('call', { port: 'nope', method: 'build', args: {} }, 'error')
    assert.equal(unknownCap.code, 'unresolved_cap')

    const value = await drv.build(baseBag())
    assert.equal(value.ok, true)
  } finally {
    drv.close()
  }
})

test('坏帧（非法 JSON）→ 协议损坏即退出，让宿主 fail-closed', async () => {
  const drv = startService()
  await drv.hello()
  const body = Buffer.from('{not json', 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  drv.child.stdin.write(frame)
  const code = await drv.exit
  assert.equal(code, 1)
})
