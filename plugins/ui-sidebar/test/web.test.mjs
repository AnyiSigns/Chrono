// 前端纯函数测试（node --test）：分组 / 标题过滤 / 消息链还原 / 角标状态机 /
// 二次确认 / 宽度夹取与窄屏分支 / 导出 / 文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  configWriteCommand,
  conversationMessages,
  filterConversations,
  groupConversations,
  isEmptyView,
  matchTitle,
  normalizeConversations,
  normalizeQuery,
  normalizeWorkspaces,
  slotWriteCommand,
  ungroupedConversations,
} from '../execute/web/sidebar-model.ts'
import {
  applyEvent,
  badgeFor,
  badgeForGroup,
  badgeTextCode,
  BADGE_TEXT_CODES,
  clearUnread,
  createBadgeState,
  runningRun,
  seedFromHistory,
  seedOpenTurns,
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

test('标题过滤：大小写折叠改变长度时区间仍落在原串上（不越界 / 不错位）', () => {
  // `İ` 的 toLowerCase 为两码元，旧实现按折叠串下标切片会错位。
  const result = matchTitle('İstanbul', 'stanbul')
  assert.equal(result.matched, true)
  for (const [start, end] of result.ranges) {
    assert.ok(start >= 0 && end <= 'İstanbul'.length && start < end)
    assert.equal('İstanbul'.slice(start, end).toLowerCase(), 'stanbul')
  }
  // 折叠不改变长度时保持原快路径行为
  assert.deepEqual(matchTitle('Alpha Beta', 'beta'), { matched: true, ranges: [[6, 10]] })
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

test('未分组会话：null / 已移除工作区的会话显式收拢，且受查询过滤', () => {
  const workspaces = normalizeWorkspaces([{ id: 'w1', name: 'A', path: '/a' }])
  const conversations = normalizeConversations({
    conversations: [
      { id: 'c1', workspace_id: 'w1', title: 'A1' },
      { id: 'c2', workspace_id: 'w9', title: 'removed' },
      { id: 'c3', title: 'unbound' },
      { id: 'c4', workspace_id: 'w1', title: 'A2' },
    ],
  })
  const orphans = ungroupedConversations(workspaces, conversations, '')
  assert.deepEqual(orphans.map((item) => item.id), ['c2', 'c3'])
  assert.deepEqual(ungroupedConversations(workspaces, conversations, 'unb').map((item) => item.id), ['c3'])
  assert.deepEqual(ungroupedConversations([], conversations, '').map((item) => item.id), ['c1', 'c2', 'c3', 'c4'])
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

test('运行角标：chat.turn.started 记回合 / run、chat.turn.settled 清除；失败结局转失败角标', () => {
  let state = createBadgeState()
  assert.equal(threadOf({ thread: 'c1' }), 'c1')
  assert.equal(threadOf({ conversation: 'c2' }), 'c2')
  assert.equal(threadOf({}), null)
  // 续跑时 thread 可能是 `_main`，按 conversation 归键。
  state = applyEvent(state, 'chat', 'chat.turn.started', { turn_id: 't1', run: 'r1', thread: '_main', conversation: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'running', run: 'r1' })
  assert.equal(runningRun(state, 'c1'), 'r1')
  state = applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't1', conversation: 'c1', outcome: { kind: 'committed' } })
  assert.equal(badgeFor(state, 'c1'), null)
  assert.equal(runningRun(state, 'c1'), null)
  // 失败结局（拒绝 / 中断）→ 失败角标。
  state = applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't2', conversation: 'c1', outcome: { kind: 'refused', code: 'x' } })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'failed' })
  // 取消不算失败。
  let cancelled = applyEvent(createBadgeState(), 'chat', 'chat.turn.started', { turn_id: 't3', conversation: 'c2' })
  cancelled = applyEvent(cancelled, 'chat', 'chat.turn.settled', { turn_id: 't3', conversation: 'c2', outcome: { kind: 'cancelled' } })
  assert.equal(badgeFor(cancelled, 'c2'), null)
})

test('角标优先级：待审批 > 运行中 > 失败 > 未读；不常驻红点', () => {
  let state = createBadgeState()
  state = applyEvent(state, 'chat', 'chat.turn.started', { turn_id: 't1', run: 'r1', conversation: 'c1' })
  state = applyEvent(state, 'session', 'approval.pending', { thread: 'c1' })
  state = applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't1', conversation: 'c1', outcome: { kind: 'refused' } })
  state = applyEvent(state, 'session', 'group.message', { thread: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'pending', count: 1 })
  state = applyEvent(state, 'session', 'approval.decided', { thread: 'c1', count: 0 })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'failed' })
  state = applyEvent(state, 'chat', 'chat.turn.started', { turn_id: 't2', run: 'r3', conversation: 'c1' })
  assert.deepEqual(badgeFor(state, 'c1'), { kind: 'running', run: 'r3' })
  state = applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't2', conversation: 'c1', outcome: { kind: 'committed' } })
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

test('首屏补种：从会话 status / pending / inbox 生成初值；运行中不补种', () => {
  const conversations = [
    { id: 'c1', status: 'failed', pending: null, inbox: null },
    { id: 'c2', status: 'waiting', pending: { approval: 1 }, inbox: { count: 5, last_seen: 2 } },
    { id: 'c3', status: 'running', pending: null, inbox: null },
  ]
  const seeded = seedFromHistory(createBadgeState(), conversations)
  assert.deepEqual(badgeFor(seeded, 'c1'), { kind: 'failed' })
  assert.deepEqual(badgeFor(seeded, 'c2'), { kind: 'pending', count: 1 })
  // `status:"running"` 是死字段（生产从不写）：不产生运行角标。
  assert.equal(badgeFor(seeded, 'c3'), null)
  // 运行中来自会话回合事件，事件态优先于历史补种。
  const withEvent = applyEvent(createBadgeState(), 'chat', 'chat.turn.started', { turn_id: 't9', run: 'r9', conversation: 'c3' })
  const merged = seedFromHistory(withEvent, conversations)
  assert.deepEqual(badgeFor(merged, 'c3'), { kind: 'running', run: 'r9' })
})

test('首屏运行角标：session.open_turns 补种（事件到达前即可显示，含非当前会话）；事件仍清除', () => {
  // 重载后、下一个 `chat.turn.started` 之前：会话持久回合状态给出运行中。
  const seeded = seedOpenTurns(createBadgeState(), [
    { turn_id: 't1', conv: 'c1' },
    { turn_id: 't2', conv: 'c2' },
    { conv: '' },
    null,
  ])
  assert.deepEqual(badgeFor(seeded, 'c1'), { kind: 'running', run: null })
  assert.equal(badgeFor(seeded, 'c2').kind, 'running')
  assert.equal(badgeFor(seeded, 'c3'), null)
  // 摘要只带 {turn_id,conv}，无 run：运行中补种后终止按钮无 run 可用。
  assert.equal(runningRun(seeded, 'c1'), null)
  // 只补缺：事件带来的运行记录（含 run id）优先，不被摘要覆盖。
  const withEvent = applyEvent(createBadgeState(), 'chat', 'chat.turn.started', {
    turn_id: 't1',
    run: 'r1',
    conversation: 'c1',
  })
  assert.deepEqual(badgeFor(seedOpenTurns(withEvent, [{ turn_id: 't1', conv: 'c1' }]), 'c1'), {
    kind: 'running',
    run: 'r1',
  })
  // 事件路径仍能清除持久读补出的运行中。
  const cleared = applyEvent(seeded, 'chat', 'chat.turn.settled', {
    turn_id: 't1',
    conversation: 'c1',
    outcome: { kind: 'committed' },
  })
  assert.equal(badgeFor(cleared, 'c1'), null)
  // 非法摘要原样返回入参引用（调用方据引用相等判变更）。
  assert.equal(seedOpenTurns(seeded, null), seeded)
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
  state = applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't0', conversation: 'c1', outcome: { kind: 'interrupted' } })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'failed' })
  state = applyEvent(state, 'chat', 'chat.turn.started', { turn_id: 't1', run: 'r1', conversation: 'c2' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'running', run: 'r1' })
  state = applyEvent(state, 'session', 'approval.pending', { thread: 'c1' })
  assert.deepEqual(badgeForGroup(state, ['c1', 'c2']), { kind: 'pending', count: 1 })
})

test('角标文案码：种类 → 文案码单一映射，未知回 null', () => {
  assert.equal(badgeTextCode('running'), BADGE_TEXT_CODES.running)
  assert.equal(badgeTextCode('pending'), 'sidebar_pending')
  assert.equal(badgeTextCode('failed'), 'sidebar_failed')
  assert.equal(badgeTextCode('unread'), 'sidebar_unread_count')
  assert.equal(badgeTextCode('missing'), 'sidebar_directory_missing')
  assert.equal(badgeTextCode('bogus'), null)
  assert.equal(badgeTextCode(null), null)
})

test('applyEvent：无实际变更时回传入参引用（供调用方免序列化判变更）', () => {
  const state = createBadgeState()
  // 未知 topic / 无 thread 原样返回
  assert.equal(applyEvent(state, 'host', 'unknown.topic', { thread: 'c1' }), state)
  assert.equal(applyEvent(state, 'chat', 'chat.turn.started', {}), state)
  // 已清零的 approval.decided 不再产生新引用
  assert.equal(applyEvent(state, 'session', 'approval.decided', { thread: 'c1', count: 0 }), state)
  // 有实际变更时回新引用
  const next = applyEvent(state, 'session', 'group.message', { thread: 'c1' })
  assert.notEqual(next, state)
  // 重复的终局（无运行记录、非失败结局）不产生新引用
  assert.equal(
    applyEvent(state, 'chat', 'chat.turn.settled', { turn_id: 't1', conversation: 'c1', outcome: { kind: 'committed' } }),
    state,
  )
})

test('首屏补种：本地已读会话的历史未读不再复活', () => {
  const conversations = [{ id: 'c1', status: 'waiting', pending: null, inbox: { count: 5, last_seen: 1 } }]
  assert.deepEqual(badgeFor(seedFromHistory(createBadgeState(), conversations), 'c1'), {
    kind: 'unread',
    count: 4,
  })
  const locallyRead = new Set(['c1'])
  assert.equal(badgeFor(seedFromHistory(createBadgeState(), conversations, locallyRead), 'c1'), null)
  // 未标记的其它会话仍照常补种
  const both = [{ ...conversations[0] }, { id: 'c2', status: 'waiting', pending: null, inbox: { count: 2, last_seen: 0 } }]
  const seeded = seedFromHistory(createBadgeState(), both, locallyRead)
  assert.equal(badgeFor(seeded, 'c1'), null)
  assert.deepEqual(badgeFor(seeded, 'c2'), { kind: 'unread', count: 2 })
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

test('写口命令：槽 / 配置写走 owner 命令，不构造世界写 directive', () => {
  const slot = { kind: 'idle' }
  assert.deepEqual(slotWriteCommand('_main', slot), {
    name: 'input.write',
    args: { thread: '_main', slot },
  })
  assert.deepEqual(configWriteCommand({ ui: { sidebar_width: 240 } }), {
    name: 'config.write',
    args: { patch: { ui: { sidebar_width: 240 } } },
  })
  const all = JSON.stringify([slotWriteCommand('_main', slot), configWriteCommand({})])
  assert.equal(all.includes('add_gen'), false)
  assert.equal(all.includes('$directives'), false)
})

test('loadMessages：拉取失败回落内置最小表', async () => {
  const failing = () => Promise.reject(new Error('offline'))
  const table = await loadMessages(failing, '/x')
  assert.ok(table.ui_unreachable !== undefined)
  const ok = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{"a":{"title":"t","body":"b"}}') })
  assert.equal((await loadMessages(ok, '/x')).a.body, 'b')
})
