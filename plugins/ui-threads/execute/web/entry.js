// `ui-threads` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约，slot = topbar）。
// 本模块只编排：DOM 骨架、hover 意图显隐、标签渲染、事件订阅（自己服务的 `/events`）。
// 标签数据经只读命令 `threads.state` 取回（服务从入口 term 传入的 `ctx.ids` 装配）；切换只走 `api.uiState`。

import { ensureStyles } from './styles.js'
import { el, clear } from './dom.js'
import { formatText, loadMessages, messageText } from './messages.js'
import { badgeTone, dataChangeTarget, threadLabelKey } from './threads-model.js'
import { hoverDelay, isHoverOpen, nextHoverStatus } from './hover-intent.js'
import { bumpUnread, clearUnread, unreadOf } from './unread.js'
import { resolveActiveThread } from './bridge-state.js'

export const contract = '1'

const BASE = new URL('.', import.meta.url)

async function postJson(path, body) {
  try {
    const response = await fetch(new URL(path, BASE).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const parsed = await response.json().catch(() => null)
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, code: 'ui_unreachable', message: `http ${response.status}` }
    }
    return parsed
  } catch (err) {
    return { ok: false, code: 'ui_unreachable', message: String(err && err.message ? err.message : err) }
  }
}

const BADGE_TEXT_KEY = {
  running: 'threads_status_running',
  pending: 'threads_status_pending',
  done: 'threads_status_done',
  failed: 'threads_status_failed',
}

function todoStatusKey(status) {
  if (status === 'completed') return 'threads_todo_completed'
  if (status === 'in_progress') return 'threads_todo_in_progress'
  return 'threads_todo_pending'
}

/** 挂载子应用；返回 `{unmount}`（壳会 await 本函数）。 */
export async function mount(root, api) {
  const doc = root.ownerDocument
  ensureStyles(doc)
  const table = await loadMessages(fetch, '/assets/messages.v1.json')

  const state = {
    data: null,
    activeThread: null,
    knownCurrent: null,
    unread: {},
    connected: typeof api.events?.connected === 'function' ? api.events.connected() : false,
    error: null,
    loading: false,
    todoOpen: false,
  }

  let hoverStatus = 'hidden'
  let hoverTimer = null
  let reloadTimer = null
  let disposed = false

  // ---- DOM 骨架（常态 0 高度；overlay 展开，不推挤布局） ----

  const live = el(doc, 'div', { class: 'threads-sr', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } })
  const tags = el(doc, 'div', { class: 'threads-tags' })
  const todoBox = el(doc, 'div', { class: 'threads-todo', attrs: { hidden: true } })
  const panel = el(doc, 'div', { class: 'threads-panel' }, [tags, todoBox])
  const hit = el(doc, 'div', { class: 'threads-hit', attrs: { 'aria-hidden': 'true' } })
  const container = el(
    doc,
    'div',
    { class: 'threads-root', attrs: { 'data-open': 'false', role: 'region', 'aria-label': messageText(table, 'threads_region') } },
    [hit, panel, live],
  )
  root.replaceChildren(container)

  // ---- hover 意图延时（150ms 出 / 300ms 收） ----

  function dispatchHover(event) {
    const next = nextHoverStatus(hoverStatus, event)
    if (next === hoverStatus) return
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
    hoverStatus = next
    container.setAttribute('data-open', isHoverOpen(hoverStatus) ? 'true' : 'false')
    const delay = hoverDelay(hoverStatus)
    if (delay !== null) {
      hoverTimer = setTimeout(() => {
        hoverTimer = null
        dispatchHover('timeout')
      }, delay)
    }
  }

  container.addEventListener('mouseenter', () => dispatchHover('enter'))
  container.addEventListener('mouseleave', () => dispatchHover('leave'))

  // ---- 渲染 ----

  function labelOf(tag) {
    return tag.default_title === true ? messageText(table, threadLabelKey(tag.kind)) : tag.title
  }

  function renderTag(tag) {
    const label = labelOf(tag)
    const tone = badgeTone(tag.badge)
    const children = []
    if (tone !== null) {
      children.push(el(doc, 'span', { class: 'threads-dot', dataset: { tone }, attrs: { 'aria-hidden': 'true' } }))
    }
    children.push(el(doc, 'span', { class: 'threads-label', text: label }))
    const count = unreadOf(state.unread, tag.thread)
    if (count > 0) {
      children.push(el(doc, 'span', { class: 'threads-unread', text: String(count) }))
    }
    const badgeText = tone !== null ? messageText(table, BADGE_TEXT_KEY[tone]) : ''
    const aria = badgeText.length > 0 ? `${label} · ${badgeText}` : label
    return el(
      doc,
      'button',
      {
        class: 'threads-tag',
        attrs: { type: 'button', 'data-kind': tag.kind, 'data-active': String(tag.thread === state.activeThread), 'aria-label': aria, title: label },
        on: { click: () => selectThread(tag.thread) },
      },
      children,
    )
  }

  function renderTodoTag(todo) {
    const label = formatText('threads_todo', { count: todo.pending })
    return el(
      doc,
      'button',
      {
        class: 'threads-tag',
        attrs: { type: 'button', 'data-kind': 'todo', 'data-active': String(state.todoOpen), 'aria-label': label, title: label },
        on: {
          click: () => {
            state.todoOpen = !state.todoOpen
            render()
          },
        },
      },
      [el(doc, 'span', { class: 'threads-label', text: label })],
    )
  }

  function renderTodo(todo) {
    clear(todoBox)
    if (todo === null || state.todoOpen !== true) {
      todoBox.hidden = true
      return
    }
    todoBox.hidden = false
    todoBox.appendChild(el(doc, 'div', { class: 'threads-todo-heading', text: messageText(table, 'threads_todo_heading') }))
    const items = Array.isArray(todo.items) ? todo.items : []
    for (const item of items) {
      const status = item !== null && typeof item === 'object' && typeof item.status === 'string' ? item.status : 'pending'
      todoBox.appendChild(
        el(doc, 'div', { class: 'threads-todo-item' }, [
          el(doc, 'span', { class: 'threads-todo-status', text: messageText(table, todoStatusKey(status)) }),
          el(doc, 'span', { class: 'threads-todo-text', text: typeof item.text === 'string' ? item.text : '' }),
        ]),
      )
    }
  }

  function render() {
    clear(tags)
    const data = state.data
    if (state.error !== null) {
      const retry = el(doc, 'button', {
        class: 'threads-tag',
        attrs: { type: 'button' },
        on: { click: () => void load() },
      }, [
        el(doc, 'span', { class: 'threads-label', text: messageText(table, state.error.code) }),
        el(doc, 'span', { class: 'threads-unread', text: messageText(table, 'threads_retry') }),
      ])
      tags.appendChild(retry)
      renderTodo(null)
      return
    }
    if (data === null) {
      if (state.loading) tags.appendChild(el(doc, 'span', { class: 'threads-breathe' }))
      renderTodo(null)
      return
    }
    const list = Array.isArray(data.tags) ? data.tags : []
    for (const tag of list) tags.appendChild(renderTag(tag))
    const todo = data.todo !== null && typeof data.todo === 'object' ? data.todo : null
    if (todo !== null && todo.pending > 0) tags.appendChild(renderTodoTag(todo))
    renderTodo(todo)
  }

  // ---- 单桥 / 切换 ----

  function selectThread(thread) {
    if (typeof thread !== 'string' || thread.length === 0) return
    state.activeThread = thread
    state.unread = clearUnread(state.unread, thread)
    state.todoOpen = false
    if (typeof api.uiState?.set === 'function') api.uiState.set('active_thread', thread)
    render()
  }

  function applyCurrent() {
    const data = state.data ?? {}
    const resolved = resolveActiveThread({
      current: data.current,
      knownCurrent: state.knownCurrent,
      activeThread: state.activeThread,
    })
    state.knownCurrent = resolved.knownCurrent
    if (resolved.reset) {
      state.activeThread = resolved.activeThread
      state.unread = clearUnread(state.unread, resolved.activeThread)
      if (typeof api.uiState?.set === 'function') api.uiState.set('active_thread', resolved.activeThread)
    }
  }

  // ---- 数据 ----

  async function load() {
    if (disposed) return
    state.loading = true
    if (state.data === null) render()
    const result = await postJson('api/command', { name: 'threads.state', args: null })
    if (disposed) return
    state.loading = false
    if (result.ok !== true) {
      state.error = {
        code: typeof result.code === 'string' ? result.code : 'unknown',
        message: typeof result.message === 'string' ? result.message : '',
      }
      render()
      return
    }
    state.error = null
    state.data = result.value !== null && typeof result.value === 'object' ? result.value : { tags: [], todo: null, current: null }
    applyCurrent()
    render()
  }

  function scheduleReload() {
    if (reloadTimer !== null) return
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void load()
    }, 120)
  }

  // ---- 事件（壳事件总线；impl / topic 原样重播） ----

  function connectEvents() {
    return typeof api.events?.onAny === 'function' ? api.events.onAny(handleRecord) : () => {}
  }

  function handleRecord(record) {
    const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
    if (record.topic === 'shell.state') {
      const wasConnected = state.connected
      state.connected = payload.connected === true
      if (state.connected && !wasConnected && state.error !== null) void load()
      return
    }
    if (record.topic === 'thread.updated' || record.topic === 'thread.opened' || record.topic === 'thread.closed') {
      scheduleReload()
      return
    }
    if (record.topic === 'group.message') {
      state.unread = bumpUnread(state.unread, dataChangeTarget(payload), state.activeThread)
      render()
      scheduleReload()
      return
    }
    if (record.topic === 'workflow.step') {
      scheduleReload()
    }
  }

  // ---- uiState（跨 slot 视图态：active_thread 写者 = 本插件） ----

  const offThread =
    typeof api.uiState?.subscribe === 'function'
      ? api.uiState.subscribe('active_thread', (value) => {
          state.activeThread = typeof value === 'string' && value.length > 0 ? value : null
          state.unread = clearUnread(state.unread, state.activeThread)
          render()
        })
      : () => {}

  const initialThread = typeof api.uiState?.get === 'function' ? api.uiState.get('active_thread') : undefined
  state.activeThread = typeof initialThread === 'string' && initialThread.length > 0 ? initialThread : null

  const closeEvents = connectEvents()
  await load()

  return {
    unmount() {
      disposed = true
      offThread()
      closeEvents()
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      if (reloadTimer !== null) clearTimeout(reloadTimer)
      root.replaceChildren()
    },
  }
}
