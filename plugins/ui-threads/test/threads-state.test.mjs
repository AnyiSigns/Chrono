// `threads.state` 服务装配测试（node --test）：
// 父会话闭包（线程树排序 / 隔离）、标签文案来源（缺省标题 → 兜底文案）、状态角标字段、待办标签；
// 外加协议级驱动：hello → manifest、ping、threads.state、未知能力类、probe、drain → bye、EOF 自退出。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assembleThreadsState } from '../execute/threads-state.ts'
import {
  activeConversations,
  badgeOf,
  dataChangeTarget,
  orderSubtree,
  resolveRootMainId,
  threadLabelKey,
} from '../execute/web/threads-model.ts'
import {
  applyLoaded,
  applyUnreadBump,
  createThreadsStore,
  initialView,
  LOADING_NOTE_MS,
  threadsStatusOf,
  threadsStatusText,
  threadsStatusTextCode,
} from '../execute/web/threads-store.ts'
import { FALLBACK_MESSAGES, messageText, UI_TEXT } from '../execute/web/messages.ts'
import { startService, tempRoot } from './driver.mjs'

function conversation(id, extra = {}) {
  return {
    id,
    title: '新对话',
    kind: 'main',
    parent: null,
    status: 'waiting',
    pending: { approval: 0, question: 0 },
    deleted_at: null,
    ...extra,
  }
}

function sessionIds(conversations, current) {
  return { session: { body: { version: 1, current, conversations } } }
}

/** 一棵线程树：main c1 → sub c2 → sub c3；另一棵 main c4 → sub c5。 */
function twoTrees() {
  return [
    conversation('c1', { title: '主会话 A' }),
    conversation('c2', { kind: 'subagent', parent: { def: 'c1' }, title: '子代理 A1' }),
    conversation('c3', { kind: 'subagent', parent: { def: 'c2' }, title: '子代理 A2' }),
    conversation('c4', { title: '主会话 B' }),
    conversation('c5', { kind: 'group', parent: { def: 'c4' }, title: '圆桌' }),
  ]
}

test('父会话闭包：current 决定根，标签 = 根 + parent 闭包（树序）', () => {
  const tree = twoTrees()
  const atRoot = assembleThreadsState(sessionIds(tree, 'c1'))
  assert.equal(atRoot.ok, true)
  assert.equal(atRoot.current, 'c1')
  assert.equal(atRoot.root, 'c1')
  assert.deepEqual(atRoot.tags.map((tag) => tag.thread), ['c1', 'c2', 'c3'])

  // current 落在子线程：根仍是其 main 祖先，闭包不变
  const atChild = assembleThreadsState(sessionIds(tree, 'c2'))
  assert.equal(atChild.root, 'c1')
  assert.deepEqual(atChild.tags.map((tag) => tag.thread), ['c1', 'c2', 'c3'])

  // 切到另一棵父会话：换一组标签，不混入第一棵
  const atOther = assembleThreadsState(sessionIds(tree, 'c4'))
  assert.equal(atOther.root, 'c4')
  assert.deepEqual(atOther.tags.map((tag) => tag.thread), ['c4', 'c5'])

  // current 缺失：回落第一条 main
  const noCurrent = assembleThreadsState(sessionIds(tree, null))
  assert.equal(noCurrent.root, 'c1')
})

test('软删会话不进顶栏，也不参与根解析', () => {
  const tree = [
    conversation('c1', { title: '主会话' }),
    conversation('c2', { kind: 'subagent', parent: { def: 'c1' }, deleted_at: '2026-01-01' }),
  ]
  assert.deepEqual(activeConversations(tree).map((item) => item.id), ['c1'])
  const value = assembleThreadsState(sessionIds(tree, 'c1'))
  assert.deepEqual(value.tags.map((tag) => tag.thread), ['c1'])
})

test('标签文案来源：缺省标题 → default_title，子代理 / 群聊 / 工作流各有兜底键', () => {
  const tree = [
    conversation('c1', { title: '新对话' }),
    conversation('c2', { kind: 'subagent', parent: { def: 'c1' }, title: '研究子线程' }),
    conversation('c3', { kind: 'group', parent: { def: 'c1' }, title: '新对话' }),
    conversation('c4', { kind: 'workflow', parent: { def: 'c1' }, title: '流水线' }),
  ]
  const value = assembleThreadsState(sessionIds(tree, 'c1'))
  const byId = new Map(value.tags.map((tag) => [tag.thread, tag]))
  assert.equal(byId.get('c1').default_title, true)
  assert.equal(byId.get('c2').default_title, false)
  assert.equal(byId.get('c2').title, '研究子线程')
  assert.equal(byId.get('c3').default_title, true)
  assert.equal(threadLabelKey(byId.get('c1').kind), 'thread_label_main')
  assert.equal(threadLabelKey(byId.get('c2').kind), 'thread_label_subagent')
  assert.equal(threadLabelKey(byId.get('c3').kind), 'thread_label_group')
  assert.equal(threadLabelKey(byId.get('c4').kind), 'thread_label_workflow')
})

test('状态角标：同源 status / pending；waiting / blocked 无角标', () => {
  assert.equal(badgeOf(conversation('x', { status: 'running' })), 'running')
  assert.equal(badgeOf(conversation('x', { status: 'done' })), 'done')
  assert.equal(badgeOf(conversation('x', { status: 'failed' })), 'failed')
  assert.equal(badgeOf(conversation('x', { status: 'terminated' })), 'failed')
  assert.equal(badgeOf(conversation('x', { status: 'waiting' })), null)
  assert.equal(badgeOf(conversation('x', { status: 'blocked' })), null)
  assert.equal(badgeOf(conversation('x', { status: 'running', pending: { approval: 2, question: 0 } })), 'pending')
  assert.equal(badgeOf(conversation('x', { status: 'running', pending: { approval: 0, question: 1 } })), 'pending')

  const value = assembleThreadsState(
    sessionIds([conversation('c1', { status: 'running', pending: { approval: 1, question: 0 } })], 'c1'),
  )
  assert.equal(value.tags[0].badge, 'pending')
  assert.deepEqual(value.tags[0].pending, { approval: 1, question: 0 })
  assert.equal(value.tags[0].status, 'running')
})

test('待办标签位：#47 投影有未完成项才出，全完成 / 清空即消失', () => {
  const ids = sessionIds([conversation('c1', { title: '主会话' })], 'c1')
  ids.todo = {
    body: { conversations: { c1: { items: { tail: { def: 'h3' }, count: 3 } } } },
    refs: {
      h3: { id: 't3', text: '第三步', status: 'pending', prev: { def: 'h2' } },
      h2: { id: 't2', text: '第二步', status: 'in_progress', prev: { def: 'h1' } },
      h1: { id: 't1', text: '第一步', status: 'completed', prev: null },
    },
  }
  const value = assembleThreadsState(ids)
  assert.equal(value.todo.conversation, 'c1')
  assert.equal(value.todo.total, 3)
  assert.equal(value.todo.done, 1)
  assert.equal(value.todo.pending, 2)
  assert.deepEqual(value.todo.items.map((item) => item.text), ['第一步', '第二步', '第三步'])
  assert.equal(Object.hasOwn(value.todo.items[0], 'prev'), false, '清单条目不暴露链式 prev')

  // 全部 completed → 标签消失
  ids.todo.refs.h3.status = 'completed'
  ids.todo.refs.h2.status = 'completed'
  assert.equal(assembleThreadsState(ids).todo, null)

  // 清空（tail null）→ 标签消失
  ids.todo.body.conversations.c1.items = { tail: null, count: 0 }
  assert.equal(assembleThreadsState(ids).todo, null)
})

test('无会话投影 / 非对象入参：不崩、回空标签', () => {
  const empty = assembleThreadsState({})
  assert.equal(empty.ok, true)
  assert.equal(empty.current, null)
  assert.equal(empty.root, null)
  assert.deepEqual(empty.tags, [])
  assert.equal(empty.todo, null)
  assert.equal(assembleThreadsState(null).ok, true)
  assert.equal(assembleThreadsState([]).ok, true)
})

test('线程树纯函数：orderSubtree / resolveRootMainId / dataChangeTarget', () => {
  const tree = twoTrees()
  assert.deepEqual(orderSubtree(tree, 'c1'), ['c1', 'c2', 'c3'])
  assert.deepEqual(orderSubtree(tree, 'c2'), ['c2', 'c3'])
  assert.deepEqual(orderSubtree(tree, 'missing'), [])
  assert.equal(resolveRootMainId(tree, 'c3'), 'c1')
  assert.equal(resolveRootMainId(tree, 'c4'), 'c4')
  assert.equal(resolveRootMainId([], 'x'), null)
  assert.equal(dataChangeTarget({ thread: 'c2', conversation: 'c2' }), 'c2')
  assert.equal(dataChangeTarget({ conversation: 'c2' }), 'c2')
  assert.equal(dataChangeTarget({}), null)
  assert.equal(dataChangeTarget(null), null)
})

test('store 作用域：卸载 / 重挂保留标签 / 未读 / 当前线程', () => {
  // register 作用域只建一次 store，组件卸载 / 重挂都复用该实例。
  const store = createThreadsStore(initialView(FALLBACK_MESSAGES))
  const loaded = applyLoaded(store.getSnapshot(), assembleThreadsState(sessionIds(twoTrees(), 'c1')))
  store.commit(loaded.view)
  store.commit(applyUnreadBump(store.getSnapshot(), 'c2'))
  const before = store.getSnapshot()
  assert.equal(before.data.tags.length, 3)
  assert.equal(before.activeThread, 'c1')
  assert.equal(before.unread.c2, 1)
  // 卸载（组件退订）后重挂：store 原样复用，快照引用与内容不变。
  assert.equal(store.getSnapshot(), before)
})

// ── 顶栏整体状态：loading / offline / failed / empty / idle / ready 互不混淆 ────

test('顶栏状态判定：慢读、断连、失败、空标签、有标签各归各态', () => {
  const initial = initialView(FALLBACK_MESSAGES)
  const base = { ...initial, connected: true }
  const withData = (tags) => ({ ...base, data: { ok: true, current: null, root: null, tags, todo: null } })
  assert.equal(threadsStatusOf(initial), 'offline', '连接态未知（false）时归 offline')
  assert.equal(threadsStatusOf(base), 'idle')
  assert.equal(threadsStatusOf({ ...base, loading: true }), 'loading')
  assert.equal(threadsStatusOf({ ...base, connected: false }), 'offline')
  // 断连优先于在途：插件不可达时不显示「读取中…」。
  assert.equal(threadsStatusOf({ ...base, loading: true, connected: false }), 'offline')
  assert.equal(threadsStatusOf({ ...base, error: { code: 'boom', message: '' }, connected: true }), 'failed')
  assert.equal(threadsStatusOf({ ...base, error: { code: 'boom', message: '' }, connected: false }), 'offline')
  assert.equal(threadsStatusOf(withData([])), 'empty')
  assert.equal(threadsStatusOf(withData([{ thread: 't1' }])), 'ready')
  assert.equal(LOADING_NOTE_MS, 8000)
})

test('状态标题文本：各态取不同文案，loading 追加「仍在读取…」', () => {
  assert.equal(threadsStatusTextCode('loading'), 'threads_loading')
  assert.equal(threadsStatusTextCode('offline'), 'ui_unreachable')
  assert.equal(threadsStatusTextCode('empty'), null)
  assert.equal(threadsStatusTextCode('ready'), null)
  assert.equal(threadsStatusTextCode('idle'), null)
  assert.equal(UI_TEXT.threads_loading_more, '仍在读取…')

  const view = initialView(FALLBACK_MESSAGES)
  assert.equal(threadsStatusText(view, 'loading', false), UI_TEXT.threads_loading)
  assert.equal(
    threadsStatusText(view, 'loading', true),
    `${UI_TEXT.threads_loading} · ${UI_TEXT.threads_loading_more}`,
  )
  assert.equal(threadsStatusText(view, 'empty', false), '')
  assert.equal(threadsStatusText(view, 'offline', false), messageText(FALLBACK_MESSAGES, 'ui_unreachable'))
  const failed = { ...view, error: { code: 'boom', message: '' } }
  assert.equal(threadsStatusText(failed, 'failed', false), messageText(FALLBACK_MESSAGES, 'boom'))
})

test('协议级：hello → manifest，ping，threads.state，未知能力类，probe，drain → bye', async () => {
  const { env, cleanup } = tempRoot()
  const service = startService(env)
  try {
    const manifest = await service.hello()
    assert.equal(manifest.identity, 'ui-threads')
    assert.deepEqual(manifest.implements, ['ui-threads'])
    assert.deepEqual(manifest.methods, { 'ui-threads': ['ping', 'threads.state', 'client.read'] })
    assert.equal(manifest.state, 'recomputable')

    const pong = await service.call('ping', {})
    assert.equal(pong.pong, true)
    assert.equal(pong.identity, 'ui-threads')

    // client.read 路径穿越防护：非法路径 fail-closed（错误帧），不泄露包外字节
    const traversal = await service.callRaw('client.read', { path: '../plugin.json' })
    assert.equal(traversal.kind, 'error')
    const absolute = await service.callRaw('client.read', { path: '/etc/passwd' })
    assert.equal(absolute.kind, 'error')

    const value = await service.call('threads.state', sessionIds(twoTrees(), 'c1'))
    assert.equal(value.ok, true)
    assert.deepEqual(value.tags.map((tag) => tag.thread), ['c1', 'c2', 'c3'])

    const unknown = await service.callPort('nope', 'threads.state', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unresolved_cap')

    const probe = await service.request('probe', {}, 'pong')
    assert.equal(probe.kind, 'pong')

    const bye = await service.request('drain', { deadline_ms: 100 }, 'bye')
    assert.equal(bye.kind, 'bye')
    await service.exit
  } finally {
    if (service.child.exitCode === null) service.child.kill()
    cleanup()
  }
})

test('服务 EOF 自退出', async () => {
  const { env, cleanup } = tempRoot()
  const service = startService(env)
  try {
    service.child.stdin.end()
    const code = await Promise.race([
      service.exit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('service did not exit on EOF')), 8000)),
    ])
    assert.equal(typeof code, 'number')
  } finally {
    if (service.child.exitCode === null) service.child.kill()
    cleanup()
  }
})
