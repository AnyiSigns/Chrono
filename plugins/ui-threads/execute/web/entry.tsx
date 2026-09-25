// `ui-threads` 客户端半边（slot = topbar）：注册进壳的单一 React 运行时。
// 契约：`contract = '2'` + `register(ctx)`；业务态住 React-free store（threads-store.ts），
// 纯视图模型住叶子模块（零 react import）；本文件只做 React 编排与渲染。
// 标签数据经壳 `ctx.command('threads.state')` 取回；切换只写 `ctx.uiState.active_thread`。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SlotContext } from '@chrono/ui-contract'
import { FALLBACK_MESSAGES, formatText, loadMessages, messageText } from './messages.ts'
import { badgeTone, dataChangeTarget, isRecord } from './threads-model.ts'
import { unreadOf } from './unread.ts'
import {
  announcementOf,
  applyActiveThread,
  applyLoadError,
  applyLoaded,
  applyUnreadBump,
  createThreadsStore,
  initialView,
  LOADING_NOTE_MS,
  selectThread,
  setConnected,
  setLoading,
  setTable,
  tagLabel,
  threadsStatusOf,
  threadsStatusText,
  toggleTodo,
} from './threads-store.ts'
import type { ThreadTag, ThreadsStore, TodoView } from './threads-store.ts'
import { STYLE_TEXT } from './styles.ts'

const BADGE_TEXT_KEY: { [tone: string]: string } = {
  running: 'threads_status_running',
  pending: 'threads_status_pending',
  done: 'threads_status_done',
  failed: 'threads_status_failed',
}

/** 待办清单出现 / 更新时「展开→收起」提示动画的保持时长（展开后停此时长再收起）。 */
const TODO_PEEK_MS = 200

/** 线性图标（壳统一 sprite）：装饰性，一律 aria-hidden。 */
function Icon({ icons, name, size = 16, className }: { icons: string; name: string; size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <use href={`${icons}#${name}`} />
    </svg>
  )
}

/** 顶栏组件：常显标签 / 待办清单渲染 + 事件订阅；标签为原生 button，可 Tab 到达。 */
function App({ ctx, store }: { ctx: SlotContext; store: ThreadsStore }) {
  const view = ctx.useStore(store)
  const status = threadsStatusOf(view)
  const todo = view.data !== null ? view.data.todo : null
  const [slow, setSlow] = useState(false)
  const [peek, setPeek] = useState(false)
  const todoSigRef = useRef<string | null>(null)
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

  // ---- 长等待追加提示：仅在「读取中」计时，8s 后追加「仍在读取…」 ----
  useEffect(() => {
    if (status !== 'loading') {
      setSlow(false)
      return undefined
    }
    const timer = window.setTimeout(() => setSlow(true), LOADING_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [status])

  // ---- 待办清单出现 / 更新：播放一次「展开→收起」peek，随后回落默认收起态 ----
  const todoSig =
    todo === null
      ? null
      : `${todo.conversation}|${todo.total}|${todo.done}|${todo.items
          .map((item) => `${item.status}:${item.text}`)
          .join('\u0001')}`
  useEffect(() => {
    if (todoSig === null) {
      todoSigRef.current = null
      setPeek(false)
      return undefined
    }
    if (todoSigRef.current === todoSig) return undefined
    todoSigRef.current = todoSig
    setPeek(true)
    const timer = window.setTimeout(() => setPeek(false), TODO_PEEK_MS)
    return () => window.clearTimeout(timer)
  }, [todoSig])

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
    // 首屏校正连接态：壳在订阅前可能已广播过 `shell.state`，以当前值起步，避免误判 offline。
    store.commit(setConnected(store.getSnapshot(), ctx.events.connected()))
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

  // ---- 切换：写 `active_thread`（本插件是唯一写者） ----
  const onSelect = useCallback(
    (thread: string): void => {
      store.commit(selectThread(store.getSnapshot(), thread))
      ctx.uiState.set('active_thread', thread)
    },
    [ctx, store],
  )

  function renderTag(tag: ThreadTag) {
    const label = tagLabel(tag, view.table)
    const tone = badgeTone(tag.badge)
    const badgeText = tone !== null ? messageText(view.table, BADGE_TEXT_KEY[tone]) : ''
    const count = unreadOf(view.unread, tag.thread)
    const ariaParts = [label]
    if (badgeText.length > 0) ariaParts.push(badgeText)
    if (count > 0) ariaParts.push(formatText(view.table, 'threads_unread', { count }))
    const aria = ariaParts.join(' · ')
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

  function renderTodo(todoView: TodoView, open: boolean) {
    return (
      <div className="threads-todo" data-open={open ? 'true' : 'false'}>
        <button
          type="button"
          className="threads-todo-head"
          aria-expanded={open}
          onClick={() => store.commit(toggleTodo(store.getSnapshot()))}
        >
          <Icon icons={ctx.tokens.icons} name="check-check" size={14} className="threads-todo-icon" />
          <span className="threads-todo-progress">
            {formatText(view.table, 'threads_todo_progress', { done: todoView.done, total: todoView.total })}
          </span>
          <Icon icons={ctx.tokens.icons} name="chevron-down" size={14} className="threads-todo-chevron" />
        </button>
        <div className="threads-todo-body">
          <div className="threads-todo-clip">
            <div className="threads-todo-list">
              {todoView.items.map((item) => (
                <div className="threads-todo-item" data-status={item.status} key={item.id}>
                  <span className="threads-todo-check" data-status={item.status} aria-hidden="true">
                    {item.status === 'completed' ? (
                      <Icon icons={ctx.tokens.icons} name="check" size={10} />
                    ) : null}
                  </span>
                  <span className="threads-todo-text">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  function renderTags() {
    // 失败 / 不可达：给可重试的显式错误标签，不再落回「不渲染」。
    if (status === 'offline' || status === 'failed') {
      return (
        <button type="button" className="threads-tag" data-tone="error" onClick={() => void load()}>
          <span className="threads-label">{threadsStatusText(view, status, false)}</span>
          <span className="threads-unread">{messageText(view.table, 'threads_retry')}</span>
        </button>
      )
    }
    // 读取中：给可见文案（>8s 追加「仍在读取…」），不再是无声呼吸条。
    if (status === 'loading') {
      return (
        <span className="threads-loading" data-role="loading">
          <span className="threads-breathe" />
          <span>{threadsStatusText(view, status, slow)}</span>
        </span>
      )
    }
    if (status === 'empty' || status === 'idle' || view.data === null) return null
    return view.data.tags.map(renderTag)
  }

  const tagNodes = renderTags()
  const hasBar = tagNodes !== null || todo !== null
  const todoOpen = view.todoOpen || peek
  return (
    <div
      className="threads-root"
      role="region"
      aria-label={messageText(view.table, 'threads_region')}
      tabIndex={0}
    >
      <style>{STYLE_TEXT}</style>
      {hasBar ? (
        <div className="threads-panel">
          {tagNodes !== null ? <div className="threads-tags">{tagNodes}</div> : null}
          {todo !== null ? renderTodo(todo, todoOpen) : null}
        </div>
      ) : null}
      <div className="threads-sr" aria-live="polite" aria-atomic="true">
        {announcementOf(view)}
      </div>
    </div>
  )
}

export const contract = '2'

/** 注册进壳的 `topbar` slot；壳对每个注册组件包错误边界。 */
export function register(ctx: SlotContext): void {
  // store 住 register 作用域：壳错误边界卸载后重挂复用同一实例，标签数据 / 未读 / 连接态不随组件销毁。
  // 首屏以当前壳连接态起步，避免订阅前已广播的 `shell.state` 缺失导致误判 offline。
  const store = createThreadsStore(setConnected(initialView(FALLBACK_MESSAGES), ctx.events.connected()))
  ctx.slots.register({ name: 'topbar' }, (props) => <App ctx={props.ctx} store={store} />)
}
