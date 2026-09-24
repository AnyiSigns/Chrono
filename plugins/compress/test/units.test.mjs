// `compress` 逻辑级测试：直接 import execute 源码（不 spawn 服务），覆盖派生 / 合并 / 去重 / 三方法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosine, dedupNewItems } from '../execute/dedup.ts'
import { combineDedup, createHandlers, TTL_MS } from '../execute/methods.ts'
import { asStringList, normalizeText, uniqueStrings } from '../execute/plan.ts'
import { semanticSummary } from '../execute/semantic.ts'
import {
  deriveSentences,
  emptySummary,
  mergeSummaryLists,
  parseSummary,
  sentencesOf,
  summaryFromArgs,
  summaryFromSource,
  summaryToL2Json,
  truncate,
} from '../execute/summary.ts'
import { BadArgsError } from '../execute/types.ts'
import { memoryFixture, opsOf, externOf, directivesOf } from './driver.mjs'

/** 最小补丁组装（测试内联）：replace / delete 两种 op。 */
function applyOps(base, ops) {
  const doc = structuredClone(base)
  for (const op of ops) {
    let node = doc
    for (let i = 0; i < op.path.length - 1; i++) node = node[op.path[i]]
    const last = op.path[op.path.length - 1]
    if (op.op === 'delete') delete node[last]
    else node[last] = structuredClone(op.value)
  }
  return doc
}

const ENV = { run: 'r', thread: 't', now: 1_700_000_000_000 }
const EXPIRES = new Date(1_700_000_000_000 + TTL_MS).toISOString()

test('normalizeText / uniqueStrings / asStringList', () => {
  assert.equal(normalizeText('  a   b \n'), 'a b')
  assert.deepEqual(uniqueStrings([' a ', 'a', 'b', '']), ['a', 'b'])
  assert.deepEqual(asStringList(['x', 'y'], 'facts'), ['x', 'y'])
  assert.deepEqual(asStringList(undefined, 'facts'), [])
  assert.throws(() => asStringList('x', 'facts'), BadArgsError)
})

test('sentencesOf / deriveSentences 确定派生', () => {
  assert.deepEqual(sentencesOf('First. Second! Third?'), ['First.', 'Second!', 'Third?'])
  const slice = [
    { role: 'user', content: 'Alpha one. Beta two.' },
    { role: 'assistant', content: 'Gamma three.' },
  ]
  assert.deepEqual(deriveSentences(slice, 2, 100), ['Alpha one.', 'Beta two.'])
  assert.deepEqual(deriveSentences(undefined, 3, 100), [])
})

test('truncate 按 Unicode 码点截断，不劈代理对', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcde', 3), 'abc')
  assert.equal(truncate('a😀b', 2), 'a😀')
  const astral = '😀😀😀'
  const cut = truncate(astral, 1)
  assert.equal(cut, '😀')
  assert.equal(Array.from(cut).length, 1)
  // 对照：UTF-16 码元切分会得到孤立高代理项
  assert.notEqual(cut, astral.slice(0, 1))
  assert.equal(astral.slice(0, 1), '\uD83D')
})

test('target_length 一致作用于 summary 解析来源', () => {
  const long = 'x'.repeat(10)
  const parsed = summaryFromSource({ summary: { goal: long, facts: [long, 'short'] } }, 3, 3)
  assert.equal(parsed.goal, 'xxx')
  assert.deepEqual(parsed.facts, ['xxx', 'sho'])
})

test('summaryFromArgs：结构化字段优先，缺失由切片派生', () => {
  const summary = summaryFromArgs(
    {
      goal: '目标',
      facts: ['事实一', '事实一'],
      session_slice: [{ role: 'user', content: 'Derived sentence.' }],
    },
    100,
    3,
  )
  assert.equal(summary.goal, '目标')
  assert.deepEqual(summary.facts, ['事实一'])
  assert.deepEqual(summary.decisions, [])
  assert.deepEqual(summary.next_steps, [])
})

test('summaryFromArgs：无结构化字段时从切片派生 goal 与 facts', () => {
  const summary = summaryFromArgs({ session_slice: [{ role: 'user', content: 'Hello world.' }] }, 100, 3)
  assert.equal(summary.goal, 'Hello world.')
  assert.deepEqual(summary.facts, ['Hello world.'])
})

test('mergeSummaryLists：去重后追加、goal 新值优先', async () => {
  const existing = { ...emptySummary(), goal: 'old', facts: ['a', 'b'] }
  const incoming = { ...emptySummary(), goal: 'new', facts: ['b', 'c'] }
  const dedup = async (items, reference) => ({
    accepted: items.filter((item) => !reference.includes(item)),
    dedup: 'text',
  })
  const merged = await mergeSummaryLists(existing, incoming, dedup)
  assert.equal(merged.summary.goal, 'new')
  assert.deepEqual(merged.summary.facts, ['a', 'b', 'c'])
  assert.equal(merged.dedup, 'text')

  // 混合路径：任一次判定走了向量即报 vector（与 combineDedup 同口径）
  const mixed = await mergeSummaryLists(existing, incoming, async (items, reference) => ({
    accepted: items.filter((item) => !reference.includes(item)),
    dedup: items.length > 0 && reference.length > 0 ? 'vector' : 'text',
  }))
  assert.equal(mixed.dedup, 'vector')
})

test('combineDedup：任一段向量即报 vector，全文本才报 text', () => {
  assert.equal(combineDedup('vector', 'text'), 'vector')
  assert.equal(combineDedup('text', 'vector'), 'vector')
  assert.equal(combineDedup('vector', 'vector'), 'vector')
  assert.equal(combineDedup('text', 'text'), 'text')
})

test('parseSummary / summaryToL2Json：L2 无 next_steps', () => {
  const parsed = parseSummary({ goal: 'g', facts: ['f'], next_steps: ['n'] })
  assert.deepEqual(parsed.facts, ['f'])
  assert.deepEqual(parsed.next_steps, ['n'])
  const l2 = summaryToL2Json(parsed)
  assert.equal(l2.next_steps, undefined)
  assert.deepEqual(l2.facts, ['f'])
})

test('cosine / dedupNewItems：精确去重与向量去重', async () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  const exact = await dedupNewItems(['a', 'a', 'b'], ['a'], { model: 'm', threshold: 0.9 })
  assert.deepEqual(exact.accepted, ['b'])
  assert.equal(exact.dedup, 'text')

  const embedding = { embed: async (texts) => texts.map((text) => (text === 'alpha' || text === 'alpha!' ? [1, 0] : [0, 1])) }
  const vector = await dedupNewItems(['alpha!', 'beta'], ['alpha'], { embedding, model: 'm', threshold: 0.9 })
  assert.deepEqual(vector.accepted, ['beta'])
  assert.equal(vector.dedup, 'vector')

  const broken = { embed: async () => { throw new Error('down') } }
  const fallback = await dedupNewItems(['x'], ['y'], { embedding: broken, model: 'm', threshold: 0.9 })
  assert.deepEqual(fallback.accepted, ['x'])
  assert.equal(fallback.dedup, 'text')
})

test('semanticSummary：模型出 JSON 即用；解析失败 / 缺 config 回结构化错误', async () => {
  const model = { chat: async () => ({ ok: true, text: '```json\n{"goal":"m","facts":["f1","f2"]}\n```' }) }
  const ok = await semanticSummary({ model_config: { base_url: 'x' } }, emptySummary(), model)
  assert.equal(ok.summary.goal, 'm')
  assert.deepEqual(ok.summary.facts, ['f1', 'f2'])

  const bad = await semanticSummary({ model_config: {} }, emptySummary(), { chat: async () => ({ ok: true, text: 'nope' }) })
  assert.equal(bad.error.code, 'semantic_parse_failed')

  const missing = await semanticSummary({}, emptySummary(), model)
  assert.equal(missing.error.code, 'model_config_required')
})

test('summarize（algorithmic）：写计划 put + add_gen，保留其他会话 / 工作区', async () => {
  const handlers = createHandlers({})
  const memory = memoryFixture()
  const value = await handlers.summarize(
    { memory, conversation: 'c-1', covered_upto: 'msg-9', goal: 'G', facts: ['f1', 'f2'] },
    ENV,
  )
  const ops = opsOf(value)
  assert.deepEqual(ops.map((op) => op.op), ['put', 'add_gen'])
  assert.equal(ops[1].args.id, 'short-memory')
  const body = ops[0].args.body
  assert.equal(body.sessions['c-1'].summary.goal, 'G')
  assert.equal(body.sessions['c-1'].covered_upto, 'msg-9')
  assert.equal(body.sessions['c-1'].expires_at, EXPIRES)
  assert.deepEqual(body.sessions['c-keep'], memory.sessions['c-keep'])
  assert.deepEqual(body.workspaces, memory.workspaces)
  const payload = externOf(value)
  assert.equal(payload.ok, true)
  assert.equal(payload.kind, 'summarize')
  assert.equal(payload.covered_upto, 'msg-9')
})

test('补丁世代：summarize 有 data_gen 写补丁 + base，组装结果 == 整份写入', async () => {
  const handlers = createHandlers({})
  const memory = memoryFixture()
  const full = await handlers.summarize(
    { memory, conversation: 'c-1', covered_upto: 'msg-9', goal: 'G', facts: ['f1', 'f2'] },
    ENV,
  )
  const fullBody = opsOf(full)[0].args.body
  const value = await handlers.summarize(
    {
      memory,
      conversation: 'c-1',
      covered_upto: 'msg-9',
      goal: 'G',
      facts: ['f1', 'f2'],
      memory_data_gen: { seq: 3, payload: 'a'.repeat(64) },
    },
    ENV,
  )
  const ops = opsOf(value)
  assert.equal(ops[1].args.base, 3)
  assert.ok(Array.isArray(ops[0].args.body.ops) && ops[0].args.body.ops.length > 0)
  assert.deepEqual(applyOps(memory, ops[0].args.body.ops), fullBody)
})

test('补丁世代：summarize 空改动回落整份', async () => {
  const handlers = createHandlers({})
  const memory = memoryFixture()
  // 同输入第二次：目标内容与既有 L1 一致 → 补丁为空 → 回落整份。
  const first = await handlers.summarize(
    { memory, conversation: 'c-1', covered_upto: 'msg-9', goal: 'G', facts: ['f1', 'f2'] },
    ENV,
  )
  const next = opsOf(first)[0].args.body
  const second = await handlers.summarize(
    { memory: next, conversation: 'c-1', covered_upto: 'msg-9', goal: 'G', facts: ['f1', 'f2'], memory_data_gen: { seq: 3 } },
    ENV,
  )
  const ops = opsOf(second)
  assert.equal(ops[1].args.base, undefined)
  assert.equal(Array.isArray(ops[0].args.body.ops), false)
})

test('summarize：缺 memory / conversation → BadArgsError', async () => {
  const handlers = createHandlers({})
  await assert.rejects(() => handlers.summarize({ conversation: 'c' }, ENV), BadArgsError)
  await assert.rejects(() => handlers.summarize({ memory: memoryFixture() }, ENV), BadArgsError)
})

test('compact：写 L1 并触发 extract 写 L2（2–3 条）', async () => {
  const handlers = createHandlers({})
  const value = await handlers.compact(
    {
      memory: memoryFixture(),
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    },
    ENV,
  )
  const body = opsOf(value)[0].args.body
  assert.equal(body.sessions['c-1'].summary.goal, 'G')
  const items = body.workspaces['w-1'].summary.facts
  assert.ok(items.length >= 2 && items.length <= 3, `items=${items.length}`)
  assert.deepEqual(body.workspaces['w-keep'], memoryFixture().workspaces['w-keep'])
  const payload = externOf(value)
  assert.equal(payload.kind, 'compact')
  assert.ok(payload.items.length >= 2 && payload.items.length <= 3)
})

test('extract：2–3 条不重复；全重复只回 extern', async () => {
  const handlers = createHandlers({})
  const memory = memoryFixture()
  memory.workspaces['w-1'] = {
    summary: { goal: '', decisions: [], facts: ['dup', 'dup2'], open_questions: [], files: [] },
    sources: [],
    at: '2020-01-01T00:00:00.000Z',
  }
  const value = await handlers.extract({ memory, workspace: 'w-1', summary: { facts: ['dup', 'dup2', 'new1', 'new2', 'new3'] } }, ENV)
  const items = externOf(value).items
  assert.deepEqual(items, ['new1', 'new2', 'new3'])

  const dupOnly = await handlers.extract({ memory, workspace: 'w-1', summary: { facts: ['dup', 'dup2'] }, session_slice: [] }, ENV)
  assert.deepEqual(directivesOf(dupOnly).map((item) => item.kind), ['extern'])
  assert.equal(externOf(dupOnly).reason, 'all_duplicate')
})

test('extract：候选不足 2 条 → insufficient_content', async () => {
  const handlers = createHandlers({})
  const value = await handlers.extract({ memory: memoryFixture(), workspace: 'w-1', summary: { facts: [] } }, ENV)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'insufficient_content')
  assert.equal(value.$directives, undefined)
})

test('semantic 模式：经注入模型后端出摘要；模型失败作数据', async () => {
  const model = { chat: async () => ({ ok: true, text: JSON.stringify({ goal: 'M', facts: ['mf1', 'mf2'] }) }) }
  const handlers = createHandlers({ model })
  const value = await handlers.summarize(
    { memory: memoryFixture(), conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' } },
    ENV,
  )
  assert.equal(externOf(value).summary.goal, 'M')

  const failing = createHandlers({ model: { chat: async () => { throw new Error('boom') } } })
  const failed = await failing.summarize(
    { memory: memoryFixture(), conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' } },
    ENV,
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.$directives, undefined)
})

test('target_length 一致作用于 semantic 输出与既有 L1', async () => {
  const model = { chat: async () => ({ ok: true, text: JSON.stringify({ goal: 'aaaaaa', facts: ['bbbbbb'] }) }) }
  const handlers = createHandlers({ model })
  const memory = memoryFixture()
  memory.sessions['c-1'] = {
    summary: { goal: '', decisions: [], facts: ['oldfactlong'], open_questions: [], files: [], next_steps: [] },
    covered_upto: null,
    at: '2020-01-01T00:00:00.000Z',
    expires_at: '2020-01-02T00:00:00.000Z',
  }
  const value = await handlers.summarize(
    { memory, conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' }, target_length: 3 },
    ENV,
  )
  const payload = externOf(value)
  assert.equal(payload.summary.goal, 'aaa')
  assert.deepEqual(payload.summary.facts, ['old', 'bbb'])
})
