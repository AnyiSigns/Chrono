// 前端纯函数测试（node --test）：分组 / 标题过滤 / 消息链还原 / 角标状态机 /
// 二次确认 / 宽度夹取与窄屏分支 / 导出 / 文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  conversationMessages,
  filterConversations,
  groupConversations,
  isEmptyView,
  matchTitle,
  normalizeConversations,
  normalizeQuery,
  normalizeWorkspaces,
} from '../execute/web/sidebar-model.ts'
import {
  applyEvent,
  badgeFor,
  badgeForGroup,
  clearUnread,
  createBadgeState,
  runningRun,
  seedFromHistory,
  threadOf,
} from '../execute/web/badges.ts'
import { beginConfirm, clearConfirm, confirmExpired, CONFIRM_MS, createConfirmState, isConfirming } from '../execute/web/confirm.ts'
import {
  breakpointOf,
  canResize,
  clampWidth,
  effectiveWidth,
  resolveCollapsed,
  WIDTH_COLLAPSED,
  WIDTH_EXPANDED,
  WIDTH_MAX,
  WIDTH_MIN,
  widthFromDrag,
} from '../execute/web/width.ts'
import { exportBody, exportFilename, exportJson, exportMarkdown, messageText, messagesOf, safeFilename } from '../execute/web/export.ts'
import { formatText, loadMessages, lookupMessage, parseMessages, UI_TEXT } from '../execute/web/messages.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')

// ---- 分组 / 过滤 ----

test('工作区 / 会话归一：滤除非法与软删', () => {
  const workspaces = normalizeWorkspaces([
    { id: 'w1', name: 'A', path: '/a', missing: true },
    { id: '', name: 'bad' },
    null,
    { id: 'w2', path: '/b' },
  ])
  assert.deepEqual(workspaces, [
    { id: 'w1', name: 'A', path: '/a', missing: true },
    { id: 'w2', name: 'w2', path: '/b', missing: false },
  ])
  const conversations = normalizeConversations({
    conversations: [
      { id: 'c1', workspace_id: 'w1', title: 'A1', count: 2 },
      { id: 'c2', workspace_id: 'w1', title: 'deleted', deleted_at: '2026-01-01' },
      { id: 'c3' },
      null,
    ],
  })
  assert.deepEqual(conversations.map((item) => item.id), ['c1', 'c3'])
  assert.equal(conversations[0].count, 2)
  assert.equal(conversations[1].title, '')
  assert.deepEqual(normalizeConversations(null), [])
})

test('标题本地过滤：大小写不敏感、区间高亮、空查询全命中', () => {
  assert.deepEqual(matchTitle('Alpha Beta', 'beta'), { matched: true, ranges: [[6, 10]] })
  assert.deepEqual(matchTitle('aaa', 'a'), { matched: true, ranges: [[0, 1], [1, 2], [2, 3]] })
  assert.deepEqual(matchTitle('Alpha', ''), { matched: true, ranges: [] })
  assert.equal(matchTitle('Alpha', 'zzz').matched, false)
  assert.equal(normalizeQuery('  Ab '), 'ab')
  const list = [
    { id: 'c1', title: 'Alpha' },
    { id: 'c2', title: 'Beta' },
  ]
  assert.deepEqual(filterConversations(list, 'alp').map((item) => item.id), ['c1'])
  assert.deepEqual(filterConversations(list, '').map((item) => item.id), ['c1', 'c2'])
})

test('按工作区分组：顺序 = 工作区顺序，已移除工作区的会话随之隐藏', () => {
  const workspaces = normalizeWorkspaces([
    { id: 'w1', name: 'A', path: '/a' },
    { id: 'w2', name: 'B', path: '/b' },
  ])
  const conversations = normalizeConversations({
    conversations: [
      { id: 'c1', workspace_id: 'w1', title: 'A1' },
      { id: 'c2', workspace_id: 'w2', title: 'B1' },
      { id: 'c3', workspace_id: 'w1', title: 'A2' },
      { id: 'c4', workspace_id: 'w9', title: 'orphan' },
    ],
  })
  const groups = groupConversations(workspaces, conversations, '')
  assert.deepEqual(groups.map((group) => group.workspace.id), ['w1', 'w2'])
  assert.deepEqual(groups[0].sessions.map((item) => item.id), ['c1', 'c3'])
  assert.deepEqual(groups[1].sessions.map((item) => item.id), ['c2'])
  const filtered = groupConversations(workspaces, conversations, 'a2')
  assert.deepEqual(filtered[0].sessions.map((item) => item.id), ['c3'])
  assert.deepEqual(filtered[1].sessions, [])
  assert.equal(isEmptyView([], [], ''), true)
  assert.equal(isEmptyView(workspaces, conversations, ''), false)
  assert.equal(isEmptyView(workspaces, [], 'x'), false)
})

test('消息链还原：沿 prev 从链头逆序收集再反转；断链 / 环安全', () => {
  const history = {
    body: { conversations: [{ id: 'c1', head: { def: 'h2' } }] },
    refs: {
      h1: { id: 'm1', role: 'user', content: 'a', prev: null },
      h2: { id: 'm2', role: 'assistant', content: 'b', prev: { def: 'h1' } },
    },
  }
  assert.deepEqual(conversationMessages(history, 'c1').map((item) => item.id), ['m1', 'm2'])
  assert.deepEqual(conversationMessages(history, 'missing'), [])
  const broken = { body: { conversations: [{ id: 'c1', head: { def: 'x' } }] }, refs: {} }
  assert.deepEqual(conversationMessages(broken, 'c1'), [])
  const cyclic = { body: { conversations: [{ id: 'c1', head: { def: 'a' } }] }, refs: { a: { id: 'a', prev: { def: 'b' } }, b: { id: 'b', prev: { def: 'a' } } } }
  assert.deepEqual(conversationMessages(cyclic, 'c1').map((item) => item.id), ['b', 'a'])
})

// ---- 角标状态机 ----

test('运行角标：run.started 记 run、run.finished 清除；失败转失败角标', () => {
  let state = createBadgeState()
  assert.equal(threadOf({ thread: 'c1' }), 'c1')
  assert.equal(threadOf({ conversation: 'c2' }), 'c2')
  assert.equal(threadOf({}), null)
  state = applyEvent(state, 'host', 'run.started', { run: 'r1', thread: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'running', run: 'r1' })
  assert.equal(runningRun(state, 'c1'), 'r1')
  state = applyEvent(state, 'host', 'run.finished', { run: 'r1', thread: 'c1', status: 'done' })
  assert.equal(badgeFor(state, 'c1'), null)
  assert.equal(runningRun(state, 'c1'), null)
  state = applyEvent(state, 'host', 'run.finished', { run: 'r2', thread: 'c1', status: 'failed' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'failed' })
})

test('角标优先级：待审批 > 运行中 > 失败 > 未读；不常驻红点', () => {
  let state = createBadgeState()
  state = applyEvent(state, 'host', 'run.started', { run: 'r1', thread: 'c1' })
  state = applyEvent(state, 'session', 'approval.pending', { thread: 'c1' })
  state = applyEvent(state, 'host', 'run.finished', { run: 'r1', thread: 'c1', status: 'failed' })
  state = applyEvent(state, 'session', 'group.message', { thread: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'pending', count: 1 })
  state = applyEvent(state, 'session', 'approval.decided', { thread: 'c1', count: 0 })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'failed' })
  state = applyEvent(state, 'host', 'run.started', { run: 'r3', thread: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'running', run: 'r3' })
  state = applyEvent(state, 'host', 'run.finished', { run: 'r3', thread: 'c1', status: 'done' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'unread', count: 1 })
  state = clearUnread(state, 'c1')
  assert.equal(badgeFor(state, 'c1'), null)
})

test('thread.updated 归一 status / pending / inbox；thread.closed 清空', () => {
  let state = createBadgeState()
  state = applyEvent(state, 'session', 'thread.updated', {
    thread: 'c1',
    status: 'running',
    pending: { approval: 2, question: 0 },
    inbox: { count: 3, last_seen: 1 },
  })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'pending', count: 2 })
  state = applyEvent(state, 'session', 'thread.updated', { thread: 'c1', pending: { approval: 0 }, inbox: { count: 3, last_seen: 3 } })
  assert.equal(badgeFor(state, 'c1'), null)
  state = applyEvent(state, 'session', 'thread.closed', { thread: 'c1' })
  assert.equal(badgeFor(state, 'c1'), null)
})

test('首屏补种：从会话 status / pending / inbox 生成初值，事件态优先', () => {
  const conversations = [
    { id: 'c1', status: 'failed', pending: null, inbox: null },
    { id: 'c2', status: 'waiting', pending: { approval: 1 }, inbox: { count: 5, last_seen: 2 } },
    { id: 'c3', status: 'running', pending: null, inbox: null },
  ]
  const seeded = seedFromHistory(createBadgeState(), conversations)
  assert.deepEqual(badgeFor(seeded, 'c1'), { kind: 'failed' })
  assert.deepEqual(badgeFor(seeded, 'c2'), { kind: 'pending', count: 1 })
  assert.deepEqual(badgeFor(seeded, 'c3'), { kind: 'running', run: null })
  const withEvent = applyEvent(createBadgeState(), 'host', 'run.started', { run: 'r9', thread: 'c3' })
  const merged = seedFromHistory(withEvent, conversations)
  assert.deepEqual(badgeFor(merged, 'c3'), { kind: 'running', run: 'r9' })
})

test('组聚合角标：取组内最高优先级；未读跨会话求和；空组 / 无角标为 null', () => {
  assert.equal(badgeForGroup(createBadgeState(), []), null)
  assert.equal(badgeForGroup(createBadgeState(), ['c1', 'c2']), null)
  let state = createBadgeState()
  state = applyEvent(state, 'session', 'group.message', { thread: 'c1' })
  state = applyEvent(state, 'session', 'group.message', { thread: 'c1' })
  state = applyEvent(state, 'session', 'group.message', { thread: 'c2' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'unread', count: 3 })
  assert.deepEqual(badgeForGroup(state, ['c1']), { kind: 'unread', count: 2 })
  state = applyEvent(state, 'host', 'run.finished', { run: 'r0', thread: 'c1', status: 'failed' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'failed' })
  state = applyEvent(state, 'host', 'run.started', { run: 'r1', thread: 'c2' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'running', run: 'r1' })
  state = applyEvent(state, 'session', 'approval.pending', { thread: 'c1' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'pending', count: 1 })
})

// ---- 二次确认 ----

test('二次确认：窗口内生效、超时收回', () => {
  const state = beginConfirm(createConfirmState(), 'delete:c1', 1000)
  assert.equal(isConfirming(state, 'delete:c1', 1000 + CONFIRM_MS - 1), true)
  assert.equal(isConfirming(state, 'delete:c1', 1000 + CONFIRM_MS), false)
  assert.equal(confirmExpired(state, 1000 + CONFIRM_MS), true)
  assert.equal(confirmExpired(state, 1000), false)
  assert.equal(isConfirming(state, 'other', 1000), false)
  assert.equal(clearConfirm().key, null)
})

// ---- 宽度 / 窄屏 ----

test('宽度夹取与断点分支：非宽屏强制收缩、宽屏可拉伸', () => {
  assert.equal(clampWidth(100), WIDTH_MIN)
  assert.equal(clampWidth(999), WIDTH_MAX)
  assert.equal(clampWidth(300.4), 300)
  assert.equal(clampWidth('x'), WIDTH_EXPANDED)
  assert.equal(breakpointOf(1440), 'wide')
  assert.equal(breakpointOf(1024), 'wide')
  assert.equal(breakpointOf(900), 'mid')
  assert.equal(breakpointOf(500), 'narrow')
  assert.equal(canResize(1024), true)
  assert.equal(canResize(1023), false)
  assert.equal(resolveCollapsed(800, false), true)
  assert.equal(resolveCollapsed(1200, false), false)
  assert.equal(resolveCollapsed(1200, true), true)
  assert.equal(effectiveWidth(800, 300, false), WIDTH_COLLAPSED)
  assert.equal(effectiveWidth(1200, 300, false), 300)
  assert.equal(effectiveWidth(1200, 300, true), WIDTH_COLLAPSED)
  assert.equal(widthFromDrag(260, 50), 310)
  assert.equal(widthFromDrag(400, 100), WIDTH_MAX)
  assert.equal(widthFromDrag(260, -100), WIDTH_MIN)
})

// ---- 导出 ----

test('导出 markdown / JSON 与文件名安全化', () => {
  const conversation = { id: 'c1', title: 'A/B', workspace_id: 'w1' }
  const messages = [
    { id: 'm1', role: 'user', content: 'hello' },
    { id: 'm2', role: 'assistant', parts: [{ text: 'part-a' }, { text: 'part-b' }] },
  ]
  assert.equal(messageText(messages[0]), 'hello')
  assert.equal(messageText(messages[1]), 'part-a\npart-b')
  const md = exportMarkdown(conversation, messages)
  assert.match(md, /# A\/B/)
  assert.match(md, /## user/)
  assert.match(md, /hello/)
  const json = JSON.parse(exportJson(conversation, messages))
  assert.equal(json.id, 'c1')
  assert.equal(json.messages[1].content, 'part-a\npart-b')
  assert.equal(safeFilename('A/B:C'), 'A-B-C')
  assert.equal(safeFilename('   '), 'conversation')
  assert.equal(exportFilename(conversation, 'json'), 'A-B.json')
  assert.equal(exportBody('md', conversation, messages), md)
  assert.equal(exportBody('json', conversation, messages), exportJson(conversation, messages))
  const history = { body: { conversations: [{ id: 'c1', head: { def: 'h1' } }] }, refs: { h1: { id: 'm1', role: 'user', content: 'x', prev: null } } }
  assert.equal(messagesOf(history, 'c1').length, 1)
})

// ---- 文案 ----

test('文案表：解析 / 未知码兜底 / 共享表优先、本地骨架兜底', () => {
  const table = parseMessages('{"locale":"zh-CN","unknown_command":{"title":"未知命令","body":"没有这个命令"}}')
  assert.equal(table.unknown_command.body, '没有这个命令')
  assert.equal(parseMessages('not json'), null)
  assert.equal(lookupMessage(table, 'no_such').body.includes('no_such'), true)
  const shared = parseMessages(readFileSync(join(REPO_ROOT, 'plugins', 'ui-shell', 'execute', 'web', 'messages.v1.json'), 'utf8'))
  assert.ok(shared !== null, '共享文案表应可解析')
  assert.equal(lookupMessage(shared, 'settings_title').body, '设置')
  assert.equal(lookupMessage(null, 'sidebar_settings').body, UI_TEXT.sidebar_settings)
  assert.equal(formatText(null, 'sidebar_unread_count', { count: 3 }), '未读 3')
  assert.equal(lookupMessage(null, 'sidebar_unknown_key').body.includes('sidebar_unknown_key'), true)
})

test('loadMessages：拉取失败回落内置最小表', async () => {
  const failing = () => Promise.reject(new Error('offline'))
  const table = await loadMessages(failing, '/x')
  assert.ok(table.ui_unreachable !== undefined)
  const ok = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"a":{"title":"t","body":"b"}}') })
  assert.equal((await loadMessages(ok, '/x')).a.body, 'b')
})
