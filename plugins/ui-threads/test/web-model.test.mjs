// `ui-threads` 浏览器视图层纯函数测试（node --test）：
// hover 延时状态机、未读计数、active_thread 单桥重置、角标色调、文案兜底。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOVER_HIDE_MS,
  HOVER_SHOW_MS,
  hoverDelay,
  isHoverOpen,
  nextHoverStatus,
} from '../execute/web/hover-intent.ts'
import { bumpUnread, clearUnread, unreadOf } from '../execute/web/unread.ts'
import { resolveActiveThread } from '../execute/web/bridge-state.ts'
import { badgeTone, threadLabelKey } from '../execute/web/threads-model.ts'
import { formatText, lookupMessage, messageText, parseMessages, UI_TEXT } from '../execute/web/messages.ts'
import { FALLBACK_MESSAGES } from '../execute/web/messages.ts'
import {
  applyActiveThread,
  applyLoaded,
  applyLoadError,
  applyUnreadBump,
  createThreadsStore,
  initialView,
  normalizeThreadsData,
  selectThread,
  setConnected,
  setLoading,
  setTable,
  toggleTodo,
} from '../execute/web/threads-store.ts'

test('hover 意图延时：150ms 出 / 300ms 收，划过与回入取消', () => {
  assert.equal(HOVER_SHOW_MS, 150)
  assert.equal(HOVER_HIDE_MS, 300)

  // 进入 → showing（排 150ms）；到点 → visible
  let status = nextHoverStatus('hidden', 'enter')
  assert.equal(status, 'showing')
  assert.equal(hoverDelay(status), 150)
  assert.equal(isHoverOpen(status), false)
  status = nextHoverStatus(status, 'timeout')
  assert.equal(status, 'visible')
  assert.equal(hoverDelay(status), null)
  assert.equal(isHoverOpen(status), true)

  // 划过：showing 期间离开 → 直接 hidden（不展开、不排收起）
  assert.equal(nextHoverStatus('showing', 'leave'), 'hidden')

  // 离开 → hiding（排 300ms）；到点 → hidden
  status = nextHoverStatus('visible', 'leave')
  assert.equal(status, 'hiding')
  assert.equal(hoverDelay(status), 300)
  assert.equal(isHoverOpen(status), false)
  assert.equal(nextHoverStatus(status, 'timeout'), 'hidden')

  // 收起期间回入 → 取消收起、保持展开
  assert.equal(nextHoverStatus('hiding', 'enter'), 'visible')

  // 幂等 / 非法输入不抛错
  assert.equal(nextHoverStatus('visible', 'enter'), 'visible')
  assert.equal(nextHoverStatus('hidden', 'leave'), 'hidden')
  assert.equal(nextHoverStatus('bogus', 'enter'), 'hidden')
})

test('未读计数：非当前线程 +1、切入清零、当前线程不计数', () => {
  let counts = {}
  counts = bumpUnread(counts, 'c2', 'c1')
  counts = bumpUnread(counts, 'c2', 'c1')
  counts = bumpUnread(counts, 'c1', 'c1')
  assert.equal(unreadOf(counts, 'c2'), 2)
  assert.equal(unreadOf(counts, 'c1'), 0)
  assert.equal(unreadOf(counts, 'c9'), 0)
  counts = clearUnread(counts, 'c2')
  assert.equal(unreadOf(counts, 'c2'), 0)
  // 不可变：原对象不被改写
  const original = { c2: 3 }
  const next = bumpUnread(original, 'c2', 'c1')
  assert.deepEqual(original, { c2: 3 })
  assert.equal(next.c2, 4)
  // 空线程 / 非字符串不计数
  assert.deepEqual(bumpUnread({}, null, 'c1'), {})
})

test('active_thread 单桥：仅 current 变（或未选定）时重置', () => {
  // 首屏：未选定 → 跟随 current
  assert.deepEqual(resolveActiveThread({ current: 'c1', knownCurrent: null, activeThread: null }), {
    activeThread: 'c1',
    knownCurrent: 'c1',
    reset: true,
  })
  // 点击子线程后 current 未变 → 保持子线程
  assert.deepEqual(resolveActiveThread({ current: 'c1', knownCurrent: 'c1', activeThread: 'c2' }), {
    activeThread: 'c2',
    knownCurrent: 'c1',
    reset: false,
  })
  // 侧栏 select 落账 → current 变 → 重置到新 current
  assert.deepEqual(resolveActiveThread({ current: 'c3', knownCurrent: 'c1', activeThread: 'c2' }), {
    activeThread: 'c3',
    knownCurrent: 'c3',
    reset: true,
  })
  // current 缺失 → 不动
  assert.deepEqual(resolveActiveThread({ current: null, knownCurrent: 'c1', activeThread: 'c2' }), {
    activeThread: 'c2',
    knownCurrent: 'c1',
    reset: false,
  })
  // 非法输入 → 全 null
  assert.deepEqual(resolveActiveThread(undefined), { activeThread: null, knownCurrent: null, reset: false })
})

test('角标色调与文案键映射', () => {
  assert.equal(badgeTone('running'), 'running')
  assert.equal(badgeTone('pending'), 'pending')
  assert.equal(badgeTone('done'), 'done')
  assert.equal(badgeTone('failed'), 'failed')
  assert.equal(badgeTone(null), null)
  assert.equal(badgeTone('bogus'), null)
  assert.equal(threadLabelKey('subagent'), 'thread_label_subagent')
  assert.equal(threadLabelKey('unknown'), 'thread_label_main')
})

test('文案兜底：本地界面文案、占位符代入、错误码 unknown', () => {
  assert.equal(messageText(null, 'threads_region'), UI_TEXT.threads_region)
  assert.equal(formatText('threads_todo', { count: 3 }), '待办 3')
  assert.equal(formatText('threads_unread', { count: 2 }), '未读 2')
  const unknown = lookupMessage(null, 'threads_does_not_exist')
  assert.equal(unknown.body.includes('threads_does_not_exist'), true)
  assert.equal(parseMessages('{"x":{"title":"t","body":"b"}}').x.body, 'b')
  assert.equal(parseMessages('not json'), null)
})

test('store fold：归一防御、applyLoaded 单桥、切换清未读、未读 +1、提交通知', () => {
  const view = initialView(FALLBACK_MESSAGES)
  assert.deepEqual(normalizeThreadsData(null), { ok: true, current: null, root: null, tags: [], todo: null })

  const loaded = applyLoaded(view, {
    ok: true,
    current: 'c1',
    root: 'c1',
    tags: [{ thread: 'c1', kind: 'main', title: '新对话', default_title: true, badge: null }],
    todo: { conversation: 'c1', total: 2, done: 1, pending: 1, items: [{ id: 't2', text: '第二步', status: 'pending' }] },
  })
  assert.equal(loaded.reset, true)
  assert.equal(loaded.view.activeThread, 'c1')
  assert.equal(loaded.view.knownCurrent, 'c1')
  assert.equal(loaded.view.data.tags.length, 1)
  assert.equal(loaded.view.data.todo.pending, 1)
  assert.equal(loaded.view.loading, false)
  assert.equal(loaded.view.error, null)

  // current 未变 → 不重置（点击子线程后保持）
  const child = { ...loaded.view, activeThread: 'c2' }
  const same = applyLoaded(child, { ok: true, current: 'c1', root: 'c1', tags: [], todo: null })
  assert.equal(same.reset, false)
  assert.equal(same.view.activeThread, 'c2')

  // 未读：非当前线程 +1，当前线程不计数；切入清零
  let bumped = applyUnreadBump(child, 'c2')
  assert.equal(bumped.unread.c2, undefined)
  bumped = applyUnreadBump(bumped, 'c3')
  assert.equal(bumped.unread.c3, 1)
  const selected = selectThread(bumped, 'c3')
  assert.equal(selected.activeThread, 'c3')
  assert.equal(selected.unread.c3, 0)
  assert.equal(selected.todoOpen, false)

  // 外部 uiState 写入置为当前并清零（无计数不改写；有计数清零）
  const external = applyActiveThread(selected, 'c9')
  assert.equal(external.activeThread, 'c9')
  assert.equal(external.unread.c9, undefined)
  const cleared = applyActiveThread(applyUnreadBump(selected, 'c8'), 'c8')
  assert.equal(cleared.activeThread, 'c8')
  assert.equal(cleared.unread.c8, 0)

  // 错误 / 连接 / 待办 / 文案表
  const failed = applyLoadError(setLoading(view, true), { code: 'ui_unreachable', message: 'x' })
  assert.equal(failed.loading, false)
  assert.equal(failed.error.code, 'ui_unreachable')
  assert.equal(setConnected(view, true).connected, true)
  assert.equal(toggleTodo(view).todoOpen, true)
  const withTable = setTable(view, { x: { title: 't', body: 'b' } })
  assert.equal(withTable.table.x.body, 'b')

  // store：快照稳定，commit 通知订阅者
  const store = createThreadsStore(view)
  let notified = 0
  const off = store.subscribe(() => { notified += 1 })
  assert.equal(store.getSnapshot(), view)
  store.commit(setConnected(view, true))
  assert.equal(notified, 1)
  assert.equal(store.getSnapshot().connected, true)
  off()
  store.commit(view)
  assert.equal(notified, 1)
})
