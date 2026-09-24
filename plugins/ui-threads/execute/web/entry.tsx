// `ui-threads` 客户端半边（slot = topbar）：注册进壳的单一 React 运行时。
// 契约：`contract = '2'` + `register(ctx)`；业务态住 React-free store（threads-store.ts），
// 纯视图模型住叶子模块（零 react import）；本文件只做 React 编排与渲染。
// 标签数据经壳 `ctx.command('threads.state')` 取回；切换只写 `ctx.uiState.active_thread`。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import type { SlotContext } from '@chrono/ui-contract'
import { FALLBACK_MESSAGES, formatText, loadMessages, messageText } from './messages.ts'
import { badgeTone, dataChangeTarget, isRecord, threadLabelKey } from './threads-model.ts'
import { hoverDelay, isHoverOpen, nextHoverStatus } from './hover-intent.ts'
import type { HoverEvent, HoverStatus } from './hover-intent.ts'
import { unreadOf } from './unread.ts'
import {
  applyActiveThread,
  applyLoadError,
  applyLoaded,
  applyUnreadBump,
  createThreadsStore,
  initialView,
  selectThread,
  setConnected,
  setLoading,
  setTable,
  toggleTodo,
} from './threads-store.ts'
import type { ThreadTag, TodoView } from './threads-store.ts'
import { STYLE_TEXT } from './styles.ts'

const BADGE_TEXT_KEY: { [tone: string]: string } = {
  running: 'threads_status_running',
  pending: 'threads_status_pending',
  done: 'threads_status_done',
  failed: 'threads_status_failed',
}

function todoStatusKey(status: string): string {
  if (status === 'completed') return 'threads_todo_completed'
  if (status === 'in_progress') return 'threads_todo_in_progress'
  return 'threads_todo_pending'
}

/** 顶栏组件：hover 意图显隐 + 标签 / 待办渲染 + 事件订阅；键盘经根容器 focus 可达。 */
function App({ ctx }: { ctx: SlotContext }) {
  const [store] = useState(() => createThreadsStore(initialView(FALLBACK_MESSAGES)))
  const view = ctx.useStore(store)
  const [open, setOpen] = useState(false)
  const hover = useRef<{ status: HoverStatus; timer: number | null }>({ status: 'hidden', timer: null })
  const reloadTimer = useRef<number | null>(null)
  const disposed = useRef(false)
  const loadSeq = useRef(0)

  // ---- 文案表（壳唯一来源；失败用内置最小表） ----
  useEffect(() => {
    let alive = true
    void loadMessages(fetch, ctx.tokens.messages).then((table) => {
      if (alive) store.commit(setTable(store.getSnapshot(), table))
    })
    return () => {
      alive = false
    }
  }, [ctx, store])

  // ---- 数据：只读命令 `threads.state`（壳 api.command） ----
  const load = useCallback(async (): Promise<void> => {
    const seq = (loadSeq.current += 1)
    store.commit(setLoading(store.getSnapshot(), true))
    const result = await ctx.command('threads.state', null)
    if (disposed.current || seq !== loadSeq.current) return
    if (!isRecord(result) || result.ok !== true) {
      const code = isRecord(result) && typeof result.code === 'string' ? result.code : 'unknown'
      const message = isRecord(result) && typeof result.message === 'string' ? result.message : ''
      store.commit(applyLoadError(store.getSnapshot(), { code, message }))
      return
    }
    const applied = applyLoaded(store.getSnapshot(), result.value)
    store.commit(applied.view)
    if (applied.reset && applied.view.activeThread !== null) {
      ctx.uiState.set('active_thread', applied.view.activeThread)
    }
  }, [ctx, store])

  const scheduleReload = useCallback((): void => {
    if (reloadTimer.current !== null) return
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load()
    }, 120)
  }, [load])

  // ---- uiState：`active_thread` 外部写入（侧栏 / 其它 slot） ----
  useEffect(() => {
    store.commit(applyActiveThread(store.getSnapshot(), ctx.uiState.get('active_thread')))
    return ctx.uiState.subscribe('active_thread', (value) => {
      store.commit(applyActiveThread(store.getSnapshot(), value))
    })
  }, [ctx, store])

  // ---- 事件（壳事件总线；impl / topic 原样重播） ----
  useEffect(() => {
    disposed.current = false
    const close =
      typeof ctx.events?.onAny === 'function'
        ? ctx.events.onAny((record) => {
            const payload = isRecord(record.payload) ? record.payload : {}
            if (record.topic === 'shell.state') {
              const wasConnected = store.getSnapshot().connected
              const connected = payload.connected === true
              store.commit(setConnected(store.getSnapshot(), connected))
              if (connected && !wasConnected && store.getSnapshot().error !== null) void load()
              return
            }
            if (
              record.topic === 'thread.updated' ||
              record.topic === 'thread.opened' ||
              record.topic === 'thread.closed'
            ) {
              scheduleReload()
              return
            }
            if (record.topic === 'group.message') {
              store.commit(applyUnreadBump(store.getSnapshot(), dataChangeTarget(payload)))
              scheduleReload()
              return
            }
            if (record.topic === 'workflow.step') scheduleReload()
          })
        : () => {}
    void load()
    return () => {
      disposed.current = true
      close()
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current)
        reloadTimer.current = null
      }
    }
  }, [ctx, store, load, scheduleReload])

  // ---- hover 意图延时（150ms 出 / 300ms 收） ----
  const dispatchHover = useCallback((event: HoverEvent): void => {
    const current = hover.current
    const next = nextHoverStatus(current.status, event)
    if (next === current.status) return
    if (current.timer !== null) {
      window.clearTimeout(current.timer)
      current.timer = null
    }
    current.status = next
    setOpen(isHoverOpen(next))
    const delay = hoverDelay(next)
    if (delay !== null) {
      current.timer = window.setTimeout(() => {
        current.timer = null
        dispatchHover('timeout')
      }, delay)
    }
  }, [])

  useEffect(
    () => () => {
      if (hover.current.timer !== null) window.clearTimeout(hover.current.timer)
    },
    [],
  )

  function handleFocus(event: FocusEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    dispatchHover('enter')
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    dispatchHover('leave')
  }

  // ---- 切换：写 `active_thread`（本插件是唯一写者） ----
  const onSelect = useCallback(
    (thread: string): void => {
      store.commit(selectThread(store.getSnapshot(), thread))
      ctx.uiState.set('active_thread', thread)
    },
    [ctx, store],
  )

  function renderTag(tag: ThreadTag) {
    const label =
      tag.default_title === true ? messageText(view.table, threadLabelKey(tag.kind)) : tag.title
    const tone = badgeTone(tag.badge)
    const badgeText = tone !== null ? messageText(view.table, BADGE_TEXT_KEY[tone]) : ''
    const aria = badgeText.length > 0 ? `${label} · ${badgeText}` : label
    const count = unreadOf(view.unread, tag.thread)
    return (
      <button
        key={tag.thread}
        type="button"
        className="threads-tag"
        data-kind={tag.kind}
        data-active={tag.thread === view.activeThread ? 'true' : 'false'}
        aria-label={aria}
        title={label}
        onClick={() => onSelect(tag.thread)}
      >
        {tone !== null ? <span className="threads-dot" data-tone={tone} aria-hidden="true" /> : null}
        <span className="threads-label">{label}</span>
        {count > 0 ? <span className="threads-unread">{String(count)}</span> : null}
      </button>
    )
  }

  function renderTodo(todo: TodoView) {
    return (
      <div className="threads-todo">
        <div className="threads-todo-heading">{messageText(view.table, 'threads_todo_heading')}</div>
        {todo.items.map((item, index) => (
          <div className="threads-todo-item" key={item.id ?? String(index)}>
            <span className="threads-todo-status">
              {messageText(view.table, todoStatusKey(item.status))}
            </span>
            <span className="threads-todo-text">{item.text}</span>
          </div>
        ))}
      </div>
    )
  }

  function renderTags() {
    if (view.error !== null) {
      return (
        <button type="button" className="threads-tag" onClick={() => void load()}>
          <span className="threads-label">{messageText(view.table, view.error.code)}</span>
          <span className="threads-unread">{messageText(view.table, 'threads_retry')}</span>
        </button>
      )
    }
    if (view.data === null) {
      return view.loading ? <span className="threads-breathe" /> : null
    }
    const nodes = view.data.tags.map(renderTag)
    const todo = view.data.todo
    if (todo !== null && todo.pending > 0) {
      const label = formatText('threads_todo', { count: todo.pending })
      nodes.push(
        <button
          key="todo"
          type="button"
          className="threads-tag"
          data-kind="todo"
          data-active={view.todoOpen ? 'true' : 'false'}
          aria-label={label}
          title={label}
          onClick={() => store.commit(toggleTodo(store.getSnapshot()))}
        >
          <span className="threads-label">{label}</span>
        </button>,
      )
    }
    return nodes
  }

  const todo = view.data !== null ? view.data.todo : null
  return (
    <div
      className="threads-root"
      data-open={open ? 'true' : 'false'}
      role="region"
      aria-label={messageText(view.table, 'threads_region')}
      tabIndex={0}
      onMouseEnter={() => dispatchHover('enter')}
      onMouseLeave={() => dispatchHover('leave')}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <style>{STYLE_TEXT}</style>
      <div className="threads-hit" aria-hidden="true" />
      <div className="threads-panel">
        <div className="threads-tags">{renderTags()}</div>
        {todo !== null && view.todoOpen ? renderTodo(todo) : null}
      </div>
      <div className="threads-sr" aria-live="polite" aria-atomic="true" />
    </div>
  )
}

export const contract = '2'

/** 注册进壳的 `topbar` slot；壳对每个注册组件包错误边界。 */
export function register(ctx: SlotContext): void {
  ctx.slots.register({ name: 'topbar' }, App)
}
