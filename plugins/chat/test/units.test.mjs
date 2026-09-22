// chat 纯函数级测试：interpret bag 装配 / 计划合并 / title 判定 / 历史切片（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInterpretBag,
  buildTitleArgs,
  chainEntries,
  firstMessageOf,
  graphSliceOf,
  ledgerSliceOf,
  modelConfigOf,
  personaOf,
  shouldGenerateTitle,
  slotOf,
  threadKey,
  tierOf,
  todoSliceOf,
  workspaceOf,
} from '../execute/assemble.ts'
import { buildHistory, restoreChain, sliceChain, parseHistoryQuery } from '../execute/history.ts'
import { defHashOf, directivesOf, errorValue, externOnly, isErrorValue, mergeDirectives } from '../execute/plan.ts'
import { loadWiring, sliceEnabled } from '../execute/wiring.ts'
import { chainRefs, configFixture, idsFixture, memoryFixture } from './driver.mjs'

test('modelConfigOf：从 #2 config 解析连接实例 + 档案 + 风格来源', () => {
  const ids = idsFixture()
  const config = modelConfigOf(ids)
  assert.equal(config.vendor, 'deepseek')
  assert.equal(config.model, 'deepseek-chat')
  assert.equal(config.base_url, 'https://api.deepseek.com')
  assert.equal(config.context_window, 65536)
  assert.equal(config.max_output, 8192)
  assert.equal(config.auth_ref.name, 'DEEPSEEK_API_KEY')
  assert.deepEqual(config.params, { temperature: 0.3 })
})

test('modelConfigOf / tierOf：缺 vendor / provider 回 null，tier 取 permission', () => {
  assert.equal(modelConfigOf(idsFixture({ configBody: { model: 'm' } })), null)
  assert.equal(modelConfigOf(idsFixture({ configBody: { vendor: 'nope', model: 'm', providers: {} } })), null)
  assert.equal(tierOf(idsFixture()), 'review')
  assert.equal(tierOf(idsFixture({ omit: ['config'] })), null)
})

test('threadKey / slotOf：env.thread 决定槽键，缺省回落 _main', () => {
  assert.equal(threadKey('t1'), 't1')
  assert.equal(threadKey(null), '_main')
  const ids = idsFixture()
  assert.equal(slotOf(ids, 't1').kind, 'chat.message')
  assert.equal(slotOf(ids, 'other'), undefined)
})

test('graphSliceOf：六类条目 body + refs 闭包', () => {
  const graph = graphSliceOf(idsFixture())
  for (const key of ['contracts', 'nodes', 'prompts', 'graph', 'thresholds', 'refusal_codes']) {
    assert.ok(Object.hasOwn(graph, key), `graph 缺 ${key}`)
  }
  assert.equal(graph.contracts.tail.def.length, 64)
  assert.equal(graph.refs['a'.repeat(64)].nodes[0], 'context.assemble')
  assert.equal(graphSliceOf(idsFixture({ omit: ['loop-policy'] })), null)
})

test('ledgerSliceOf：四类链 body + refs', () => {
  const ledger = ledgerSliceOf(idsFixture())
  assert.equal(ledger.proposals.count, 0)
  assert.deepEqual(ledger.refs, {})
  assert.equal(ledgerSliceOf(idsFixture({ omit: ['evolution'] })), null)
})

test('workspaceOf：会话 workspace_id → #41 body 的 path', () => {
  const conversation = { id: 'c-1', workspace_id: 'w-1' }
  assert.deepEqual(workspaceOf(idsFixture(), conversation), { id: 'w-1', root: 'C:/ws/w-1' })
  assert.deepEqual(workspaceOf(idsFixture(), { id: 'c-1', workspace_id: 'w-9' }), { id: 'w-9', root: null })
  assert.deepEqual(workspaceOf(idsFixture({ omit: ['workspace'] }), conversation), { id: 'w-1', root: null })
})

test('todoSliceOf：当前会话条目沿链还原为 {items}', () => {
  const todo = todoSliceOf(idsFixture(), 'c-1')
  assert.equal(todo.items.length, 1)
  assert.equal(todo.items[0].id, 't1')
  assert.equal(todo.items[0].status, 'pending')
  assert.deepEqual(todoSliceOf(idsFixture(), 'c-9'), { items: [] })
  assert.equal(todoSliceOf(idsFixture(), null), null)
})

test('personaOf：会话 agent 实例 → system_prompt def → 提示词文本', () => {
  assert.equal(personaOf(idsFixture({ agent: 'agent-a' }), { id: 'c-1', agent: 'agent-a' }), '你是代码评审员。')
  assert.equal(personaOf(idsFixture(), { id: 'c-1', agent: null }), null)
  assert.equal(personaOf(idsFixture({ agent: 'nope' }), { id: 'c-1', agent: 'nope' }), null)
})

test('chainEntries：沿 prev 回溯 newest→oldest，坏引用即停', () => {
  const hash = 'a'.repeat(64)
  const refs = { [hash]: { id: 1, prev: null } }
  assert.deepEqual(chainEntries({ tail: { def: hash }, count: 1 }, refs).map((e) => e.id), [1])
  assert.deepEqual(chainEntries({ tail: null, count: 0 }, refs), [])
  assert.deepEqual(chainEntries({ tail: { def: 'b'.repeat(64) }, count: 1 }, refs), [])
})

test('defHashOf：裸哈希 / {def} 引用 / 非法', () => {
  const hash = 'a'.repeat(64)
  assert.equal(defHashOf(hash), hash)
  assert.equal(defHashOf({ def: hash }), hash)
  assert.equal(defHashOf('zz'), null)
  assert.equal(defHashOf({ def: 'nope' }), null)
})

test('buildInterpretBag：§1.14 全键装配 + 记忆 / 会话 / 图 / 门禁切片', () => {
  const ids = idsFixture({ agent: 'agent-a' })
  const wiring = loadWiring()
  const bag = buildInterpretBag({
    ids,
    wiring,
    slot: slotOf(ids, 't1'),
    conversation: ids.session.body.conversations[0],
    conversationId: 'c-1',
    config: modelConfigOf(ids),
    thread: 't1',
  })
  for (const key of [
    'input',
    'config',
    'tier',
    'memories',
    'session',
    'graph',
    'persona',
    'skills',
    'workspace_root',
    'evidence',
    'todo',
    'guard_rules',
    'sandbox_tiers',
    'tools_bindings',
    'mcp_tools',
  ]) {
    assert.ok(Object.hasOwn(bag, key), `bag 缺 ${key}`)
  }
  assert.equal(bag.input.content, '帮我写一个快速排序')
  assert.equal(bag.tier, 'review')
  assert.equal(bag.memories.l1.summary.goal, '写排序')
  assert.equal(bag.memories.l2.summary.goal, 'w')
  assert.equal(bag.session.head, 'h3')
  assert.equal(bag.persona, '你是代码评审员。')
  assert.equal(bag.workspace_id, 'w-1')
  assert.equal(bag.session_id, 'c-1')
  assert.equal(bag.thread, 't1')
  assert.equal(bag.thread_kind, 'main')
  assert.equal(bag.style, '简洁')
  assert.equal(bag.tools_bindings.bindings['retrieval.search'].class, 'retrieval')
  assert.equal(bag.recall, undefined, 'slices.recall=false 不应装配 recall')
  assert.equal(sliceEnabled(wiring, 'recall'), false)
  // 缺省空 tools 不落键：否则 #27 会把空数组当「预建空目录」屏蔽真实工具目录。
  assert.equal(Object.hasOwn(bag, 'tools'), false, '空 tools 不应落 bag')
})

test('buildInterpretBag：非空缺省 tools 才落键（空数组不落）', () => {
  const ids = idsFixture()
  const wiring = { ...loadWiring(), tools: [{ name: 'edit', description: 'x', schema: { type: 'object' } }] }
  const bag = buildInterpretBag({
    ids,
    wiring,
    slot: slotOf(ids, 't1'),
    conversation: ids.session.body.conversations[0],
    conversationId: 'c-1',
    config: modelConfigOf(ids),
    thread: 't1',
  })
  assert.equal(bag.tools.length, 1)
  assert.equal(bag.tools[0].name, 'edit')
})

test('shouldGenerateTitle：仅缺省标题且 count==0', () => {
  assert.equal(shouldGenerateTitle({ title: '新对话', count: 0 }, '新对话'), true)
  assert.equal(shouldGenerateTitle({ title: '已有', count: 0 }, '新对话'), false)
  assert.equal(shouldGenerateTitle({ title: '新对话', count: 4 }, '新对话'), false)
  assert.equal(shouldGenerateTitle(null, '新对话'), false)
})

test('buildTitleArgs：args 含 config / session / title_default', () => {
  const ids = idsFixture()
  const config = modelConfigOf(ids)
  const args = buildTitleArgs({
    conversationId: 'c-1',
    firstMessage: firstMessageOf(slotOf(ids, 't1')),
    config,
    sessionBody: ids.session.body,
    titleDefault: '新对话',
  })
  for (const key of ['conversation', 'first_message', 'vendor', 'model', 'params', 'config', 'session', 'title_default']) {
    assert.ok(Object.hasOwn(args, key), `title args 缺 ${key}`)
  }
  assert.equal(args.config.base_url, 'https://api.deepseek.com')
  assert.equal(args.session.current, 'c-1')
  assert.equal(args.title_default, '新对话')
})

test('mergeDirectives：按段序机械数组合并，忽略无计划段', () => {
  const a = { $directives: [{ kind: 'write', request: { op: 'batch', args: { ops: [] } } }] }
  const b = { $directives: [{ kind: 'extern', payload: { ok: true } }] }
  const merged = mergeDirectives([{ ok: true, messages: [] }, a, { ok: true, text: 'x' }, b])
  assert.deepEqual(directivesOf(merged), [...a.$directives, ...b.$directives])
})

test('isErrorValue / externOnly：结构化失败以 extern 收口', () => {
  assert.equal(isErrorValue({ ok: false, code: 'budget_impossible' }), true)
  assert.equal(isErrorValue({ ok: true, messages: [] }), false)
  assert.deepEqual(externOnly(errorValue('x', 'y')).$directives, [
    { kind: 'extern', payload: { ok: false, error: { code: 'x', message: 'y' } } },
  ])
})

test('restoreChain / sliceChain：沿 prev 还原（新→旧）+ before / limit 切片', () => {
  const refs = chainRefs()
  const conversation = { head: { def: 'h3' } }
  const chain = restoreChain(refs, conversation)
  assert.deepEqual(chain.map((entry) => entry.body.id), ['m3', 'm2', 'm1'])
  assert.deepEqual(sliceChain(chain, null, 2).map((entry) => entry.body.id), ['m3', 'm2'])
  assert.deepEqual(sliceChain(chain, 'm3', null).map((entry) => entry.body.id), ['m2', 'm1'])
  assert.deepEqual(sliceChain(chain, 'h2', 1).map((entry) => entry.body.id), ['m1'])
})

test('parseHistoryQuery：conversation / before / limit 形态', () => {
  assert.deepEqual(parseHistoryQuery({ conversation: 'c-2', before: 'm3', limit: 2 }), {
    conversation: 'c-2',
    before: 'm3',
    limit: 2,
  })
  assert.deepEqual(parseHistoryQuery(null), { conversation: null, before: null, limit: null })
  assert.equal(parseHistoryQuery({ limit: 0 }).limit, null)
})

test('buildHistory：缺省 conversation=current，窗口 + body/refs 全量返回', () => {
  const body = { version: 1, current: 'c-1', conversations: [{ id: 'c-1', head: { def: 'h3' } }] }
  const refs = chainRefs()
  const full = buildHistory(body, refs, { conversation: null, before: null, limit: null })
  assert.equal(full.conversation, 'c-1')
  assert.equal(full.next_before, null)
  assert.deepEqual(full.messages.map((entry) => entry.body.id), ['m3', 'm2', 'm1'])
  assert.equal(full.body.current, 'c-1')
  assert.equal(full.refs.h1.id, 'm1')
})

test('buildHistory：conversation 指定 + limit 截断 + before 更旧窗', () => {
  const body = {
    version: 1,
    current: 'c-1',
    conversations: [
      { id: 'c-1', head: { def: 'h3' } },
      { id: 'c-2', head: { def: 'h2' } },
    ],
  }
  const refs = chainRefs()
  assert.deepEqual(
    buildHistory(body, refs, { conversation: 'c-2', before: null, limit: null }).messages.map((e) => e.body.id),
    ['m2', 'm1'],
  )
  assert.deepEqual(
    buildHistory(body, refs, { conversation: null, before: null, limit: 2 }).messages.map((e) => e.body.id),
    ['m3', 'm2'],
  )
  assert.deepEqual(
    buildHistory(body, refs, { conversation: null, before: 'm3', limit: null }).messages.map((e) => e.body.id),
    ['m2', 'm1'],
  )
})

test('loadWiring：缺省与 schema 值一致（段序归 #33 图数据，本包不再持 pipeline）', () => {
  const wiring = loadWiring()
  assert.equal(Object.hasOwn(wiring, 'pipeline'), false)
  assert.equal(wiring.on_empty_slot, 'noop')
  assert.equal(wiring.title.title_default, '新对话')
  assert.deepEqual(memoryFixture().sessions['c-1'].summary.facts, [])
  assert.equal(configFixture().vendor, 'deepseek')
})
