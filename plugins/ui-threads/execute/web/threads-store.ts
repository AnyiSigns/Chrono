// 线程顶栏的业务状态（React-free store + 纯 fold）：组件只渲染，业务态住这里。
// 无 react import：壳经 `ctx.useStore(store)` 以 `useSyncExternalStore` 绑定快照。
// 快照不可变：每个 action 返回新对象，store.commit 换引用并通知订阅者。

import { resolveActiveThread } from './bridge-state.ts'
import { bumpUnread, clearUnread, unreadTotal } from './unread.ts'
import type { UnreadCounts } from './unread.ts'
import { isRecord, threadLabelKey } from './threads-model.ts'
import { formatText, messageText } from './messages.ts'
import type { MessageTable } from './messages.ts'

export interface ThreadTag {
  thread: string
  kind: string
  title: string
  default_title: boolean
  status: string
  pending: { approval: number; question: number }
  badge: string | null
}

export interface TodoItem {
  id: string
  text: string
  status: string
}

export interface TodoView {
  conversation: string
  total: number
  done: number
  pending: number
  items: TodoItem[]
}

export interface ThreadsData {
  ok: boolean
  current: string | null
  root: string | null
  tags: ThreadTag[]
  todo: TodoView | null
}

export interface ThreadsError {
  code: string
  message: string
}

export interface ThreadsView {
  table: MessageTable
  data: ThreadsData | null
  activeThread: string | null
  knownCurrent: string | null
  unread: UnreadCounts
  connected: boolean
  error: ThreadsError | null
  loading: boolean
  todoOpen: boolean
}

export interface ReadableStore<S> {
  getSnapshot(): S
  subscribe(listener: (snapshot: S) => void): () => void
}

export interface ThreadsStore extends ReadableStore<ThreadsView> {
  commit(next: ThreadsView): void
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeTag(raw: unknown): ThreadTag | null {
  if (!isRecord(raw) || typeof raw.thread !== 'string' || raw.thread.length === 0) return null
  const pending = isRecord(raw.pending) ? raw.pending : {}
  return {
    thread: raw.thread,
    kind: typeof raw.kind === 'string' ? raw.kind : 'main',
    title: typeof raw.title === 'string' ? raw.title : '',
    default_title: raw.default_title === true,
    status: typeof raw.status === 'string' ? raw.status : '',
    pending: { approval: num(pending.approval), question: num(pending.question) },
    badge: typeof raw.badge === 'string' ? raw.badge : null,
  }
}

function normalizeTodo(raw: unknown): TodoView | null {
  if (!isRecord(raw)) return null
  const items: TodoItem[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.items)) {
    for (const [index, item] of raw.items.entries()) {
      if (!isRecord(item)) continue
      const text = typeof item.text === 'string' ? item.text : ''
      const status = typeof item.status === 'string' ? item.status : 'pending'
      const explicit = typeof item.id === 'string' && item.id.length > 0 ? item.id : null
      // 无 id 的项按内容生成稳定键（跨重排不变）；同内容重复项再以序号消歧，保证唯一。
      let id = explicit ?? `todo:${status}:${text}`
      if (seen.has(id)) id = `${id}#${index}`
      seen.add(id)
      items.push({ id, text, status })
    }
  }
  return {
    conversation: typeof raw.conversation === 'string' ? raw.conversation : '',
    total: num(raw.total),
    done: num(raw.done),
    pending: num(raw.pending),
    items,
  }
}

/** 归一服务回包（防御式）：形状非法时回空标签数据，不崩。 */
export function normalizeThreadsData(value: unknown): ThreadsData {
  if (!isRecord(value)) return { ok: true, current: null, root: null, tags: [], todo: null }
  const tags: ThreadTag[] = []
  if (Array.isArray(value.tags)) {
    for (const raw of value.tags) {
      const tag = normalizeTag(raw)
      if (tag !== null) tags.push(tag)
    }
  }
  return {
    ok: value.ok === true,
    current: typeof value.current === 'string' && value.current.length > 0 ? value.current : null,
    root: typeof value.root === 'string' && value.root.length > 0 ? value.root : null,
    tags,
    todo: normalizeTodo(value.todo),
  }
}

/** 标签显示名：真实标题优先；缺省标题 / 空标题回退到种类兜底文案（不出现空标签）。 */
export function tagLabel(tag: ThreadTag, table: MessageTable): string {
  if (tag.default_title !== true && tag.title.length > 0) return tag.title
  return messageText(table, threadLabelKey(tag.kind))
}

/**
 * `aria-live` 播报串：错误态 → 错误人话；否则「当前标签 · 未读 N」。
 * 供标签 / 未读 / 状态变化时播报，避免空 live region 从不发声。
 */
export function announcementOf(view: ThreadsView): string {
  if (view.error !== null) return messageText(view.table, view.error.code)
  const active = view.data?.tags.find((tag) => tag.thread === view.activeThread) ?? null
  const parts: string[] = []
  if (active !== null) parts.push(tagLabel(active, view.table))
  const unread = unreadTotal(view.unread)
  if (unread > 0) parts.push(formatText(view.table, 'threads_unread', { count: unread }))
  return parts.join(' · ')
}

/** 初始快照（表未热时用内置最小文案表）。 */
export function initialView(table: MessageTable): ThreadsView {
  return {
    table,
    data: null,
    activeThread: null,
    knownCurrent: null,
    unread: {},
    connected: false,
    error: null,
    loading: false,
    todoOpen: false,
  }
}

/** 建 React-free store：快照 + 订阅 + 换引用提交。 */
export function createThreadsStore(initial: ThreadsView): ThreadsStore {
  let snapshot = initial
  const listeners = new Set<(value: ThreadsView) => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    commit(next) {
      snapshot = next
      for (const listener of [...listeners]) listener(snapshot)
    },
  }
}

export function setTable(view: ThreadsView, table: MessageTable): ThreadsView {
  return view.table === table ? view : { ...view, table }
}

export function setConnected(view: ThreadsView, connected: boolean): ThreadsView {
  return view.connected === connected ? view : { ...view, connected }
}

/** `uiState.active_thread` 外部写入：置为当前线程并清零其未读。 */
export function applyActiveThread(view: ThreadsView, value: unknown): ThreadsView {
  const thread = typeof value === 'string' && value.length > 0 ? value : null
  return { ...view, activeThread: thread, unread: clearUnread(view.unread, thread) }
}

/** `group.message` 到达：非当前线程未读 +1。 */
export function applyUnreadBump(view: ThreadsView, thread: unknown): ThreadsView {
  const unread = bumpUnread(view.unread, thread, view.activeThread)
  return unread === view.unread ? view : { ...view, unread }
}

/** 点击标签：切换当前线程、清零未读、收起待办清单。 */
export function selectThread(view: ThreadsView, thread: unknown): ThreadsView {
  if (typeof thread !== 'string' || thread.length === 0) return view
  return {
    ...view,
    activeThread: thread,
    unread: clearUnread(view.unread, thread),
    todoOpen: false,
  }
}

export function toggleTodo(view: ThreadsView): ThreadsView {
  return { ...view, todoOpen: !view.todoOpen }
}

export function setLoading(view: ThreadsView, loading: boolean): ThreadsView {
  return view.loading === loading ? view : { ...view, loading }
}

export function applyLoadError(view: ThreadsView, error: ThreadsError): ThreadsView {
  return { ...view, loading: false, error }
}

/**
 * 应用 `threads.state` 回包：写数据、清错误，并按单桥解析 `active_thread`。
 * `reset` 为 true 表示需要把解析结果写回 `uiState`（`current` 变了 / 尚未选定）。
 */
export function applyLoaded(view: ThreadsView, value: unknown): { view: ThreadsView; reset: boolean } {
  const data = normalizeThreadsData(value)
  const resolved = resolveActiveThread({
    current: data.current,
    knownCurrent: view.knownCurrent,
    activeThread: view.activeThread,
  })
  const unread = resolved.reset ? clearUnread(view.unread, resolved.activeThread) : view.unread
  return {
    view: {
      ...view,
      data,
      error: null,
      loading: false,
      knownCurrent: resolved.knownCurrent,
      activeThread: resolved.activeThread,
      unread,
    },
    reset: resolved.reset,
  }
}
