// `ui-sidebar` 客户端半边：`contract = '2'` + `register(ctx)`，把 React 组件注册进 `sidebar` slot。
// 业务状态住 React-free store（`sidebar-store.ts`）；本文件只渲染快照、只调 store 动作。
// 叶子纯模块（sidebar-model / badges / width / export / messages / confirm）零 react import。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { SlotContext } from '@chrono/ui-contract'
import { badgeFor, badgeForGroup, badgeTextCode, runningRun } from './badges.ts'
import type { Badge } from './badges.ts'
import { groupConversations, isEmptyView, matchTitle, relativeBucket, ungroupedConversations } from './sidebar-model.ts'
import type { Conversation, ConversationGroup, Workspace } from './sidebar-model.ts'
import { SIDEBAR_CSS, SIDEBAR_MOTION } from './styles.ts'
import { SidebarStore } from './sidebar-store.ts'
import type { MenuItem, SidebarSnapshot } from './sidebar-store.ts'
import { loadMessages } from './messages.ts'

export const contract = '2'

export async function register(ctx: SlotContext): Promise<void> {
  const messages = await loadMessages((url) => fetch(url), ctx.tokens.messages)
  const store = new SidebarStore(ctx, messages)
  const registered = ctx.slots.register({ name: 'sidebar' }, (props) => {
    // start / dispose 随挂载 / 卸载成对：错误边界卸载后重试重挂会再次 start，store 不残留 disposed。
    useEffect(() => {
      store.start()
      return () => store.dispose()
    }, [])
    return <Sidebar ctx={props.ctx} store={store} />
  })
  // 注册被拒（陈旧装载）：刚建的 store 立即 dispose，避免第二份在途。
  if (registered !== true) {
    store.dispose()
    return
  }
}

function tooltipProps(store: SidebarStore, label: string): Record<string, unknown> {
  if (label.length === 0) return {}
  return {
    'aria-describedby': 'sb-tooltip',
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => store.showTooltip(label, event.currentTarget),
    onFocus: (event: ReactFocusEvent<HTMLElement>) => store.showTooltip(label, event.currentTarget),
    onMouseLeave: () => store.hideTooltip(),
    onBlur: () => store.hideTooltip(),
  }
}

function Icon({ icons, name, size = 16, label = '' }: { icons: string; name: string; size?: number; label?: string }) {
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
      role={label.length > 0 ? 'img' : undefined}
      aria-label={label.length > 0 ? label : undefined}
      aria-hidden={label.length > 0 ? undefined : true}
    >
      <use href={`${icons}#${name}`} />
    </svg>
  )
}

function IconButton(props: {
  store: SidebarStore
  icons: string
  name: string
  label: string
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  size?: number
  danger?: boolean
  tipLabel?: string
}) {
  const { store, icons, name, label, onClick, disabled, size = 16, danger, tipLabel } = props
  const tips = tipLabel !== undefined ? tooltipProps(store, tipLabel) : {}
  return (
    <button
      type="button"
      className="sb-iconbtn"
      aria-label={label}
      // 有自绘 tooltip（tipLabel）时不再挂原生 title：否则浏览器原生提示与 `sb-tooltip` 同时弹出，悬停出现两个浮层。
      title={tipLabel !== undefined ? undefined : label}
      disabled={disabled}
      data-danger={danger === true ? 'true' : undefined}
      onClick={onClick}
      {...tips}
    >
      <Icon icons={icons} name={name} size={size} label={label} />
    </button>
  )
}

function Title({ title, query }: { title: string; query: string }) {
  const result = matchTitle(title, query)
  if (result.ranges.length === 0) return <>{title}</>
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const [start, end] of result.ranges) {
    if (start > cursor) nodes.push(title.slice(cursor, start))
    nodes.push(<mark key={`${start}-${end}`}>{title.slice(start, end)}</mark>)
    cursor = end
  }
  if (cursor < title.length) nodes.push(title.slice(cursor))
  return <>{nodes}</>
}

function BadgeView({ store, badge }: { store: SidebarStore; badge: Badge }) {
  if (badge.kind === 'unread') {
    return (
      <div className="sb-badge">
        <span className="sb-unread" aria-label={store.fmt('sidebar_unread_count', { count: badge.count })}>
          {String(badge.count)}
        </span>
      </div>
    )
  }
  const code = badgeTextCode(badge.kind)
  const label = code === null ? '' : store.text(code)
  return (
    <div className="sb-badge">
      <span className="sb-dot" data-kind={badge.kind} role="img" aria-label={label} />
    </div>
  )
}

/**
 * 破坏性动作二次确认弹窗（删除会话 / 终止运行）：居中遮罩 + 主体 + 取消 / 确认。
 * 由 `snap.confirm.key`（`delete:<会话 id>` / `terminate:<会话 id>`）驱动；Esc 与点遮罩取消。
 */
function ConfirmModal({ store, snap }: { store: SidebarStore; snap: SidebarSnapshot }) {
  const key = snap.confirm.key
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (key === null) return
    const node = dialogRef.current
    if (node !== null) node.focus()
  }, [key])
  if (key === null) return null
  const separator = key.indexOf(':')
  const action = separator > 0 ? key.slice(0, separator) : key
  const id = separator > 0 ? key.slice(separator + 1) : ''
  const session = snap.conversations.find((item) => item.id === id) ?? null
  const isDelete = action === 'delete'
  const question = isDelete ? store.text('sidebar_confirm_delete') : store.text('sidebar_confirm_terminate')
  const primaryLabel = isDelete ? store.text('sidebar_delete') : store.text('sidebar_terminate')
  const runId = session !== null ? runningRun(snap.badges, session.id) : null
  const confirm = (): void => {
    if (isDelete) {
      if (session !== null) void store.doDelete(session)
      return
    }
    if (runId !== null) void store.doTerminate(runId)
  }
  return (
    <div className="sb-modal-backdrop" role="presentation" onClick={() => store.cancelConfirm()}>
      <div
        ref={dialogRef}
        className="sb-modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            store.cancelConfirm()
          }
        }}
      >
        <div className="sb-modal-title">{question}</div>
        {session !== null && session.title.length > 0 ? (
          <div className="sb-modal-subject">{session.title}</div>
        ) : null}
        <div className="sb-modal-actions">
          <button type="button" className="sb-modal-btn" onClick={() => store.cancelConfirm()}>
            {store.text('sidebar_cancel')}
          </button>
          <button
            type="button"
            className="sb-modal-btn"
            data-danger="true"
            disabled={!isDelete && runId === null}
            onClick={confirm}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 会话行的相对时间标签（刚刚 / n 分钟前 / 今天 / 昨天 / n 天前 / 更早）；无时间回 null。 */
function relativeLabel(store: SidebarStore, updatedAt: number | null): string | null {
  const bucket = relativeBucket(updatedAt)
  if (bucket === null) return null
  switch (bucket.kind) {
    case 'now':
      return store.text('sidebar_time_now')
    case 'minutes':
      return store.fmt('sidebar_time_minutes', { n: bucket.n })
    case 'hours':
      return store.fmt('sidebar_time_hours', { n: bucket.n })
    case 'today':
      return store.text('sidebar_time_today')
    case 'yesterday':
      return store.text('sidebar_time_yesterday')
    case 'days':
      return store.fmt('sidebar_time_days', { n: bucket.n })
    default:
      return store.text('sidebar_time_older')
  }
}

function RenameInput({ store, session }: { store: SidebarStore; session: Conversation }) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const element = ref.current
    if (element !== null) {
      element.focus()
      element.select()
    }
  }, [])
  return (
    <input
      ref={ref}
      className="sb-session-rename"
      type="text"
      defaultValue={session.title}
      aria-label={store.text('sidebar_rename')}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void store.commitRename(session, event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          store.cancelRename()
        }
      }}
      onBlur={(event) => void store.commitRename(session, event.currentTarget.value)}
    />
  )
}

function SessionRow({
  store,
  snap,
  session,
  inFlyout = false,
}: {
  store: SidebarStore
  snap: SidebarSnapshot
  session: Conversation
  inFlyout?: boolean
}) {
  const current = store.currentId() === session.id
  const runId = runningRun(snap.badges, session.id)
  const editing = snap.editing === session.id
  const badge = badgeFor(snap.badges, session.id)

  let body: ReactNode
  if (editing) {
    body = (
      <>
        <RenameInput store={store} session={session} />
        <div className="sb-session-actions" data-persist="true" />
      </>
    )
  } else {
    const time = relativeLabel(store, session.updatedAt)
    body = (
      <>
        <div className="sb-session-title">
          <Title title={session.title} query={snap.query} />
        </div>
        {badge !== null && <BadgeView store={store} badge={badge} />}
        {time !== null ? <div className="sb-session-time">{time}</div> : null}
        <div className="sb-session-actions" data-persist="false">
          {runId !== null ? (
            <IconButton
              store={store}
              icons={snap.icons}
              name="square"
              label={store.text('sidebar_terminate')}
              onClick={(event) => {
                event.stopPropagation()
                store.requestTerminate(session)
              }}
            />
          ) : (
            <IconButton
              store={store}
              icons={snap.icons}
              name="pencil-line"
              label={store.text('sidebar_rename')}
              onClick={(event) => {
                event.stopPropagation()
                store.startRename(session)
              }}
            />
          )}
          <IconButton
            store={store}
            icons={snap.icons}
            name="more-horizontal"
            label={store.text('sidebar_export')}
            onClick={(event) => {
              event.stopPropagation()
              store.openSessionMenu(event.currentTarget, session)
            }}
          />
        </div>
      </>
    )
  }

  return (
    <div
      className="sb-session"
      data-current={String(current)}
      data-id={session.id}
      tabIndex={0}
      role="button"
      aria-label={session.title}
      onClick={() => void store.selectSession(session.id, inFlyout)}
      onDoubleClick={() => store.startRename(session)}
      onKeyDown={(event) => {
        if (event.key === 'F2') {
          event.preventDefault()
          store.startRename(session)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          void store.selectSession(session.id, inFlyout)
        }
      }}
    >
      {body}
    </div>
  )
}

function GroupView(props: {
  store: SidebarStore
  snap: SidebarSnapshot
  group: ConversationGroup
  inFlyout?: boolean
}) {
  const { store, snap, group, inFlyout = false } = props
  const workspace: Workspace = group.workspace
  const collapsed = snap.collapsedGroups.has(workspace.id)
  const headTips = workspace.missing ? tooltipProps(store, store.text('sidebar_directory_missing')) : {}
  return (
    <div className="sb-group">
      <div
        className="sb-group-head"
        data-missing={String(workspace.missing)}
        tabIndex={0}
        role="button"
        aria-expanded={!collapsed}
        onClick={() => store.toggleGroup(workspace.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            store.toggleGroup(workspace.id)
          }
        }}
        {...headTips}
      >
        <IconButton
          store={store}
          icons={snap.icons}
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          label={collapsed ? store.text('sidebar_expand') : store.text('sidebar_collapse')}
          onClick={(event) => {
            event.stopPropagation()
            store.toggleGroup(workspace.id)
          }}
        />
        <Icon icons={snap.icons} name="folder" />
        {workspace.missing && <span className="sb-missing-dot" />}
        <div className="sb-group-name" {...tooltipProps(store, workspace.path.length > 0 ? workspace.path : workspace.name)}>
          {workspace.name}
        </div>
        <div className="sb-group-actions" data-persist="false">
          <IconButton
            store={store}
            icons={snap.icons}
            name="chat-plus"
            size={20}
            label={store.text('sidebar_new_conversation')}
            tipLabel={store.text('sidebar_new_conversation')}
            disabled={workspace.missing}
            onClick={(event) => {
              event.stopPropagation()
              void store.newConversation(workspace.id)
            }}
          />
          <IconButton
            store={store}
            icons={snap.icons}
            name="more-horizontal"
            label={store.text('sidebar_remove_workspace')}
            onClick={(event) => {
              event.stopPropagation()
              store.openWorkspaceMenu(event.currentTarget, workspace)
            }}
          />
        </div>
      </div>
      {!collapsed && (
        <div className="sb-group-body">
          {group.sessions.map((session) => (
            <SessionRow key={session.id} store={store} snap={snap} session={session} inFlyout={inFlyout} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 未分组桶：`workspace_id` 缺失 / 工作区已移除的会话单列，避免静默不可见。只读，不带工作区动作。 */
function OrphanView({
  store,
  snap,
  sessions,
  inFlyout = false,
}: {
  store: SidebarStore
  snap: SidebarSnapshot
  sessions: Conversation[]
  inFlyout?: boolean
}) {
  return (
    <div className="sb-group">
      <div className="sb-group-head" data-missing="false">
        <Icon icons={snap.icons} name="folder" />
        <div className="sb-group-name">{store.text('sidebar_ungrouped')}</div>
      </div>
      <div className="sb-group-body">
        {sessions.map((session) => (
          <SessionRow key={session.id} store={store} snap={snap} session={session} inFlyout={inFlyout} />
        ))}
      </div>
    </div>
  )
}

function EmptyView({ store, icons, title, hint }: { store: SidebarStore; icons: string; title: string; hint?: string }) {
  return (
    <div className="sb-empty">
      {hint !== undefined && <Icon icons={icons} name="folder" size={20} />}
      <div className="sb-empty-title">{title}</div>
      {hint !== undefined && <div className="sb-empty-hint">{hint}</div>}
    </div>
  )
}

function MenuView({ store, snap }: { store: SidebarStore; snap: SidebarSnapshot }) {
  const menu = snap.menu
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 位置随锚点：打开时定位，并在滚动（捕获）/ 缩放时重算，避免列表滚动后菜单脱锚。
  useLayoutEffect(() => {
    if (menu === null) return
    const update = (): void => {
      const node = ref.current
      const anchor = menu.anchor
      if (node === null || anchor === null) {
        setPos(null)
        return
      }
      const rect = anchor.getBoundingClientRect()
      const menuRect = node.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))
      const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8)
      setPos({ left: Math.round(left), top: Math.round(top) })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [menu])

  // 打开时把焦点移入首项（仅一次，重定位不抢焦点）。
  useLayoutEffect(() => {
    if (menu === null) return
    const node = ref.current
    if (node === null) return
    const first = node.querySelector('button:not(:disabled)')
    if (first !== null && first instanceof HTMLElement) first.focus()
  }, [menu])

  if (menu === null) return null
  const items: MenuItem[] = menu.items
  return (
    <div
      ref={ref}
      className="sb-menu"
      role="menu"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos === null ? 'hidden' : 'visible' }}
      onMouseEnter={() => store.openFlyout()}
      onMouseLeave={() => store.hideFlyout()}
      onKeyDown={(event) => {
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
        )
        if (focusable.length === 0) return
        const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
        let next = -1
        if (event.key === 'ArrowDown') next = (current + 1) % focusable.length
        else if (event.key === 'ArrowUp') next = (current - 1 + focusable.length) % focusable.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = focusable.length - 1
        else return
        event.preventDefault()
        focusable[next].focus()
      }}
    >
      {items.map((item) => (
        <button
          key={`${item.icon}:${item.label}`}
          type="button"
          role="menuitem"
          data-danger={item.danger === true ? 'true' : undefined}
          disabled={item.disabled === true}
          onClick={(event) => {
            event.stopPropagation()
            store.closeMenu()
            item.run()
          }}
        >
          <Icon icons={snap.icons} name={item.icon} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

function FlyoutView({ store, snap }: { store: SidebarStore; snap: SidebarSnapshot }) {
  if (!snap.collapsed) return null
  const flyout = snap.flyout
  const groups = groupConversations(snap.workspaces, snap.conversations, snap.query)
  const orphans = ungroupedConversations(snap.workspaces, snap.conversations, snap.query)
  return (
    <div
      className="sb-flyout"
      data-open={String(snap.flyoutOpen)}
      style={{ left: flyout.left, top: flyout.top, maxHeight: flyout.maxHeight, maxWidth: flyout.maxWidth }}
      onMouseEnter={() => store.openFlyout()}
      onMouseLeave={() => store.hideFlyout()}
      onFocus={() => store.focusFlyout()}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        store.blurFlyout()
      }}
    >
      {groups.map((group) => (
        <GroupView key={group.workspace.id} store={store} snap={snap} group={group} inFlyout />
      ))}
      {orphans.length > 0 && <OrphanView store={store} snap={snap} sessions={orphans} inFlyout />}
    </div>
  )
}

function TooltipView({ snap }: { snap: SidebarSnapshot }) {
  const tooltip = snap.tooltip
  return (
    <div
      id="sb-tooltip"
      className="sb-tooltip"
      role="tooltip"
      hidden={tooltip === null}
      style={tooltip === null ? undefined : { left: tooltip.left, top: tooltip.top }}
    >
      {tooltip === null ? '' : tooltip.label}
    </div>
  )
}

function Sidebar({ ctx, store }: { ctx: SlotContext; store: SidebarStore }) {
  const snap = ctx.useStore(store)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 拖拽调宽合帧：pointermove 可达输入频率，逐事件提交会每帧多次写 width（触发布局）。
  // 只记最新 x，一帧提交一次；松手 / 取消时先冲刷未决帧再收尾。
  const dragRaf = useRef(0)
  const dragX = useRef(0)

  useEffect(() => {
    return () => {
      if (dragRaf.current !== 0) cancelAnimationFrame(dragRaf.current)
      dragRaf.current = 0
    }
  }, [])

  useEffect(() => {
    store.attachRoot(rootRef.current)
    return () => store.attachRoot(null)
  }, [store])

  // 侧栏宽度归本插件（可拖拽 + 持久化）；壳的 `#slot-sidebar` 按 `--sidebar-w-expanded` 定宽。
  // 把有效宽度同步到槽根，避免插件根（`--sb-width`）与槽宽不一致 → 内容溢出 / 横向滚动 / 裁切。
  // 槽根带 `overflow: hidden`：宽度过渡必须与 `.sb-root` 同拍（同一时长 + 缓动），否则一快一慢会露出裁切；
  // 故把 `SIDEBAR_MOTION` 也写到槽根；拖拽调宽 / 用户偏好减少动效时关掉过渡。
  // 卸载 / 宽度变更时还原槽根的原值，宿主宽度变量与过渡不在本插件卸载后残留。
  useEffect(() => {
    const host = rootRef.current?.closest('#slot-sidebar') as HTMLElement | null
    if (host === null || host === undefined) return
    const prevWidth = host.style.getPropertyValue('--sidebar-w-expanded')
    const prevTransition = host.style.getPropertyValue('transition')
    const forced = document.documentElement.getAttribute('data-motion') === 'full'
    const reduced = !forced && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    host.style.setProperty('--sidebar-w-expanded', `${snap.width}px`)
    host.style.setProperty('transition', snap.dragging || reduced ? 'none' : `width ${SIDEBAR_MOTION}`)
    return () => {
      if (prevWidth.length > 0) host.style.setProperty('--sidebar-w-expanded', prevWidth)
      else host.style.removeProperty('--sidebar-w-expanded')
      if (prevTransition.length > 0) host.style.setProperty('transition', prevTransition)
      else host.style.removeProperty('transition')
    }
  }, [snap.width, snap.dragging])

  const toggleLabel = snap.collapsed ? store.text('sidebar_expand') : store.text('sidebar_collapse')

  // 两态内容都常驻，切换时按同一时钟交叉淡入淡出（藏起的一层 inert，不抢焦点 / 不接指针）。
  const railBody: ReactNode = (() => {
    // 窄栏轨道：只渲染一枚文件夹图标，悬浮其上开出全量分组 flyout（仅悬浮触发，点击不切换）；
    // 状态点聚合所有工作区（任一目录缺失 > 全量会话最高优先级角标）。
    // 会话行 / 名称 / 搜索 / 文案类状态不在窄栏渲染；错误态留一枚重试图标。
    if (snap.error !== null) {
      return (
        <div className="sb-rail-static">
          <IconButton
            store={store}
            icons={snap.icons}
            name="rotate-ccw"
            label={store.text('sidebar_retry')}
            onClick={() => void store.loadAll()}
          />
        </div>
      )
    }
    const groups = groupConversations(snap.workspaces, snap.conversations, snap.query)
    const orphans = ungroupedConversations(snap.workspaces, snap.conversations, snap.query)
    const badge = badgeForGroup(snap.badges, [
      ...groups.flatMap((group) => group.sessions.map((session) => session.id)),
      ...orphans.map((session) => session.id),
    ])
    const dotKind = snap.workspaces.some((workspace) => workspace.missing) ? 'missing' : (badge?.kind ?? null)
    const dotCode = dotKind === null ? null : badgeTextCode(dotKind)
    const dotLabel =
      dotKind === null
        ? ''
        : dotKind === 'unread'
          ? store.fmt('sidebar_unread_count', { count: badge?.count ?? 0 })
          : dotCode === null
            ? ''
            : store.text(dotCode)
    const railLabel = dotLabel.length > 0 ? dotLabel : store.text('sidebar_rail_label')
    return (
      <button
        type="button"
        className="sb-rail-item"
        data-open={String(snap.flyoutOpen)}
        aria-label={railLabel}
        aria-haspopup="true"
        aria-expanded={snap.flyoutOpen}
        onMouseEnter={() => store.openFlyout()}
        onMouseLeave={() => store.hideFlyout()}
        onFocus={() => store.focusFlyout()}
        onBlur={() => store.blurFlyout()}
        onClick={() => store.focusFlyout()}
      >
        <Icon icons={snap.icons} name="folder" />
        {dotKind !== null && <span className="sb-dot sb-rail-dot" data-kind={dotKind} role="img" aria-label={dotLabel} />}
      </button>
    )
  })()

  let wideBody: ReactNode
  if (snap.error !== null) {
    wideBody = (
      <div className="sb-empty">
        <div className="sb-empty-title">{snap.error}</div>
        <IconButton
          store={store}
          icons={snap.icons}
          name="rotate-ccw"
          label={store.text('sidebar_retry')}
          onClick={() => void store.loadAll()}
        />
      </div>
    )
  } else if (snap.loading && snap.workspaces.length === 0 && snap.conversations.length === 0) {
    wideBody = <EmptyView store={store} icons={snap.icons} title={store.text('sidebar_loading_more')} />
  } else if (
    isEmptyView(snap.workspaces) &&
    ungroupedConversations(snap.workspaces, snap.conversations, snap.query).length === 0
  ) {
    wideBody = (
      <EmptyView
        store={store}
        icons={snap.icons}
        title={store.text('sidebar_empty_title')}
        hint={store.text('sidebar_empty_hint')}
      />
    )
  } else {
    const groups = groupConversations(snap.workspaces, snap.conversations, snap.query)
    const orphans = ungroupedConversations(snap.workspaces, snap.conversations, snap.query)
    if (
      snap.query.trim().length > 0 &&
      groups.every((group) => group.sessions.length === 0) &&
      orphans.length === 0
    ) {
      wideBody = <EmptyView store={store} icons={snap.icons} title={store.text('sidebar_no_match')} />
    } else {
      wideBody = (
        <>
          {groups.map((group) => (
            <GroupView key={group.workspace.id} store={store} snap={snap} group={group} />
          ))}
          {orphans.length > 0 && <OrphanView store={store} snap={snap} sessions={orphans} />}
        </>
      )
    }
  }

  // 宽窄切换按钮：宽面板与窄轨各持一枚（同一元素描述，两处挂载），只靠 inert 控制可交互性。
  const toggleButton = (
    <button
      type="button"
      className="sb-iconbtn sb-toggle"
      aria-label={toggleLabel}
      title={snap.wide ? toggleLabel : store.text('sidebar_expand_unavailable')}
      disabled={!snap.wide}
      onClick={() => store.toggleCollapsed()}
    >
      <span className="sb-toggle-glyph" key={snap.collapsed ? 'rail' : 'wide'}>
        <Icon icons={snap.icons} name={snap.collapsed ? 'panel-expand' : 'panel-collapse'} size={18} label={toggleLabel} />
      </span>
    </button>
  )

  return (
    <div
      ref={rootRef}
      className="sb-root"
      data-collapsed={String(snap.collapsed)}
      data-dragging={String(snap.dragging)}
      style={{ '--sb-width': `${snap.width}px`, '--sb-wide': `${snap.storedWidth}px` } as CSSProperties}
    >
      <style>{SIDEBAR_CSS}</style>
      <div className="sb-track">
        <div className="sb-layer sb-layer-wide" aria-hidden={snap.collapsed} inert={snap.collapsed}>
          <div className="sb-head">{store.text('sidebar_product')}</div>
          <div className="sb-search">
            <div className="sb-search-row">
              <Icon icons={snap.icons} name="search" />
              <input
                type="search"
                aria-label={store.text('sidebar_search_placeholder')}
                placeholder={store.text('sidebar_search_placeholder')}
                value={snap.query}
                onChange={(event) => store.setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') store.clearQuery()
                }}
              />
            </div>
          </div>
          <button type="button" className="sb-add" disabled={snap.pickerBusy} onClick={() => void store.addWorkspace()}>
            <Icon icons={snap.icons} name="folder-plus" />
            <span className="sb-label">
              {snap.pickerBusy ? store.text('sidebar_waiting_picker') : store.text('sidebar_add_workspace')}
            </span>
          </button>
          <div className="sb-status" hidden={snap.status === null} role="status" aria-live="polite">
            {snap.status === null ? '' : snap.status}
          </div>
          <div className="sb-list">{wideBody}</div>
          <div className="sb-foot">
            <div className="sb-nav">
              {snap.nav.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="sb-settings"
                  tabIndex={snap.collapsed ? -1 : 0}
                  onClick={() => store.openNav(item)}
                >
                  <Icon icons={snap.icons} name={item.icon} />
                  <span className="sb-label">{store.navLabel(item)}</span>
                </button>
              ))}
            </div>
            {toggleButton}
          </div>
        </div>
        <div className="sb-layer sb-layer-rail" aria-hidden={!snap.collapsed} inert={!snap.collapsed}>
          <div className="sb-rail-head">{store.text('sidebar_product')}</div>
          <button
            type="button"
            className="sb-add sb-add-rail"
            aria-label={store.text('sidebar_add_workspace')}
            title={store.text('sidebar_add_workspace')}
            disabled={snap.pickerBusy}
            onClick={() => void store.addWorkspace()}
          >
            <Icon icons={snap.icons} name="folder-plus" />
          </button>
          <div className="sb-list">{railBody}</div>
          <div className="sb-foot sb-foot-rail">
            {snap.nav.map((item) => (
              <IconButton
                key={item.id}
                store={store}
                icons={snap.icons}
                name={item.icon}
                label={store.navLabel(item)}
                tipLabel={store.navLabel(item)}
                onClick={() => store.openNav(item)}
              />
            ))}
            {toggleButton}
          </div>
        </div>
      </div>
      {!snap.collapsed && snap.wide && (
        <div
          className="sb-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={store.text('sidebar_collapse')}
          onPointerDown={(event) => {
            event.preventDefault()
            store.beginResize(event.clientX)
            dragX.current = event.clientX
            const target = event.currentTarget
            if (typeof target.setPointerCapture === 'function') target.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            dragX.current = event.clientX
            if (dragRaf.current !== 0) return
            dragRaf.current = requestAnimationFrame(() => {
              dragRaf.current = 0
              store.dragResize(dragX.current)
            })
          }}
          onPointerUp={() => {
            if (dragRaf.current !== 0) {
              cancelAnimationFrame(dragRaf.current)
              dragRaf.current = 0
              store.dragResize(dragX.current)
            }
            store.endResize()
          }}
          onPointerCancel={() => {
            if (dragRaf.current !== 0) {
              cancelAnimationFrame(dragRaf.current)
              dragRaf.current = 0
            }
            store.endResize()
          }}
        />
      )}
      <FlyoutView store={store} snap={snap} />
      <MenuView store={store} snap={snap} />
      <TooltipView snap={snap} />
      <ConfirmModal store={store} snap={snap} />
    </div>
  )
}
