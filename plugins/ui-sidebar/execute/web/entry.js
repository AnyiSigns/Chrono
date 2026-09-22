// `ui-sidebar` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约）。
// 只编排：DOM 骨架、数据装载、事件订阅（自己服务的 `/events`）、分组 / 会话 / 角标 / 菜单 / 宽度。
// 会话读面 = 入站命令 `chat.history` 的会话 body；写与命令一律经本插件服务的入站面。

import { ensureStyles } from './styles.js'
import { el, icon, iconButton, clear } from './dom.js'
import { formatText, loadMessages, messageText } from './messages.js'
import {
  groupConversations,
  isEmptyView,
  isRecord,
  matchTitle,
  normalizeConversations,
  normalizeWorkspaces,
} from './sidebar-model.js'
import { applyEvent, badgeFor, clearUnread, createBadgeState, runningRun, seedFromHistory } from './badges.js'
import { beginConfirm, clearConfirm, CONFIRM_MS, createConfirmState, isConfirming } from './confirm.js'
import {
  canResize,
  clampWidth,
  effectiveWidth,
  resolveCollapsed,
  widthFromDrag,
  WIDTH_COLLAPSED,
  WIDTH_EXPANDED,
  WRITE_DEBOUNCE_MS,
} from './width.js'
import { exportBody, exportFilename, messagesOf } from './export.js'

export const contract = '1'

const BASE = new URL('.', import.meta.url)
const THREAD = '_main'
const TOOLTIP_DELAY_MS = 400
const FLYOUT_OPEN_MS = 150
const FLYOUT_CLOSE_MS = 300
const RELOAD_DEBOUNCE_MS = 150
const STATUS_CLEAR_MS = 4000

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

/** 挂载子应用；返回 `{unmount}`（壳会 await 本函数）。 */
export async function mount(root, api) {
  const doc = root.ownerDocument
  ensureStyles(doc)
  const table = await loadMessages(fetch, '/assets/messages.v1.json')
  const text = (code) => messageText(table, code)
  const fmt = (code, vars) => formatText(table, code, vars)

  const state = {
    workspaces: [],
    conversations: [],
    history: null,
    query: '',
    userCollapsed: false,
    collapsed: false,
    storedWidth: WIDTH_EXPANDED,
    collapsedGroups: new Set(),
    badges: createBadgeState(),
    confirm: createConfirmState(),
    editing: null,
    pickerBusy: false,
    loading: true,
    error: null,
    status: null,
    connected: false,
  }

  let disposed = false
  let source = null
  let drag = null
  let tooltipTimer = null
  let flyoutTimer = null
  let reloadTimer = null
  let confirmTimer = null
  let widthTimer = null
  let statusTimer = null

  // ---- DOM 骨架 ----

  const tooltip = el(doc, 'div', { class: 'sb-tooltip', attrs: { hidden: true, id: 'sb-tooltip', role: 'tooltip' } })
  const statusEl = el(doc, 'div', { class: 'sb-status', attrs: { hidden: true, role: 'status', 'aria-live': 'polite' } })
  const head = el(doc, 'div', { class: 'sb-head', text: text('sidebar_product') })
  const searchInput = el(doc, 'input', {
    attrs: { type: 'search', 'aria-label': text('sidebar_search_placeholder'), placeholder: text('sidebar_search_placeholder') },
  })
  const searchRow = el(doc, 'div', { class: 'sb-search' }, [
    el(doc, 'div', { class: 'sb-search-row' }, [icon(doc, 'search', 16), searchInput]),
  ])
  const addLabel = el(doc, 'span', { class: 'sb-label', text: text('sidebar_add_workspace') })
  const addButton = el(doc, 'button', { class: 'sb-add', attrs: { type: 'button' } }, [icon(doc, 'folder-plus', 16), addLabel])
  const listEl = el(doc, 'div', { class: 'sb-list' })
  const settingsLabel = el(doc, 'span', { class: 'sb-label', text: text('sidebar_settings') })
  const settingsButton = el(doc, 'button', { class: 'sb-settings', attrs: { type: 'button' } }, [icon(doc, 'settings', 16), settingsLabel])
  const toggleButton = iconButton(doc, 'panel-left', text('sidebar_collapse'), () => toggleCollapsed(), 16)
  toggleButton.classList.add('sb-toggle')
  const foot = el(doc, 'div', { class: 'sb-foot' }, [settingsButton, toggleButton])
  const resizer = el(doc, 'div', {
    class: 'sb-resizer',
    attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': text('sidebar_collapse') },
  })
  const flyout = el(doc, 'div', { class: 'sb-flyout', attrs: { hidden: true } })
  const menuEl = el(doc, 'div', { class: 'sb-menu', attrs: { hidden: true, role: 'menu' } })
  let menuAnchor = null
  const container = el(doc, 'div', { class: 'sb-root', dataset: { collapsed: 'false', dragging: 'false' } }, [
    head,
    searchRow,
    addButton,
    statusEl,
    listEl,
    foot,
    resizer,
  ])
  root.replaceChildren(container)
  // 浮层挂 `body`（`position: fixed`）：脱离侧栏 `overflow: hidden`，不遮挡且不被裁剪。
  doc.body.appendChild(flyout)
  doc.body.appendChild(menuEl)
  doc.body.appendChild(tooltip)

  // ---- 提示 / 状态 ----

  function attachTooltip(node, label) {
    if (typeof label !== 'string' || label.length === 0) return
    node.setAttribute('aria-describedby', 'sb-tooltip')
    node.addEventListener('mouseenter', () => showTooltip(node, label))
    node.addEventListener('focus', () => showTooltip(node, label))
    node.addEventListener('mouseleave', hideTooltip)
    node.addEventListener('blur', hideTooltip)
  }

  function showTooltip(node, label) {
    if (tooltipTimer !== null) clearTimeout(tooltipTimer)
    tooltipTimer = setTimeout(() => {
      tooltip.textContent = label
      tooltip.hidden = false
      const rect = node.getBoundingClientRect()
      tooltip.style.left = `${Math.round(rect.right + 8)}px`
      tooltip.style.top = `${Math.round(rect.top)}px`
    }, TOOLTIP_DELAY_MS)
  }

  function hideTooltip() {
    if (tooltipTimer !== null) clearTimeout(tooltipTimer)
    tooltipTimer = null
    tooltip.hidden = true
  }

  function setStatus(message) {
    state.status = message
    if (statusTimer !== null) clearTimeout(statusTimer)
    if (message !== null) {
      statusTimer = setTimeout(() => {
        state.status = null
        renderStatus()
      }, STATUS_CLEAR_MS)
    }
    renderStatus()
  }

  function renderStatus() {
    statusEl.hidden = state.status === null
    statusEl.textContent = state.status ?? ''
  }

  // ---- 数据 ----

  async function command(name, args) {
    const result = await postJson('api/command', { name, args: args ?? null, thread: THREAD })
    if (result.ok !== true) {
      return { ok: false, code: typeof result.code === 'string' ? result.code : 'ui_unreachable', message: typeof result.message === 'string' ? result.message : '' }
    }
    return { ok: true, value: result.value }
  }

  async function writeSlot(slot) {
    const read = await command('input.read', { thread: THREAD })
    const body = read.ok && isRecord(read.value) ? read.value : { slots: {} }
    const slots = isRecord(body.slots) ? { ...body.slots, [THREAD]: slot } : { [THREAD]: slot }
    const directives = [
      {
        kind: 'write',
        request: {
          op: 'batch',
          args: {
            ops: [
              { op: 'put', args: { body: { ...body, slots } } },
              { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
        },
      },
    ]
    return postJson('api/submit', { directives, thread: THREAD })
  }

  async function loadWorkspaces() {
    const result = await command('workspace.list', null)
    if (!result.ok) return false
    state.workspaces = normalizeWorkspaces(result.value)
    return true
  }

  async function loadHistory() {
    const result = await command('chat.history', {})
    if (!result.ok) return false
    state.history = result.value
    state.conversations = normalizeConversations(isRecord(result.value) ? result.value.body : null)
    state.badges = seedFromHistory(state.badges, state.conversations)
    return true
  }

  async function loadStoredWidth() {
    const result = await command('config.read', null)
    if (!result.ok || !isRecord(result.value)) return
    const ui = isRecord(result.value.ui) ? result.value.ui : null
    if (ui !== null && typeof ui.sidebar_width === 'number') state.storedWidth = clampWidth(ui.sidebar_width)
  }

  async function loadAll() {
    if (disposed) return
    state.loading = true
    state.error = null
    render()
    const [workspacesOk, historyOk] = await Promise.all([loadWorkspaces(), loadHistory(), loadStoredWidth()])
    if (disposed) return
    state.loading = false
    if (!workspacesOk) state.error = text('sidebar_dependency_missing')
    else if (!historyOk) state.error = text('sidebar_dependency_missing')
    applyViewport()
  }

  function scheduleReload() {
    if (reloadTimer !== null) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void loadHistory().then(() => {
        if (!disposed) render()
      })
    }, RELOAD_DEBOUNCE_MS)
  }

  // ---- 渲染 ----

  function currentId() {
    const body = state.history !== null && isRecord(state.history.body) ? state.history.body : null
    return body !== null && typeof body.current === 'string' ? body.current : null
  }

  function confirming(key) {
    return isConfirming(state.confirm, key, Date.now())
  }

  function render() {
    if (disposed) return
    container.dataset.collapsed = String(state.collapsed)
    const toggleLabel = state.collapsed ? text('sidebar_expand') : text('sidebar_collapse')
    toggleButton.setAttribute('aria-label', toggleLabel)
    toggleButton.title = toggleLabel
    toggleButton.replaceChildren(icon(doc, state.collapsed ? 'panel-left' : 'panel-left-close', 16, toggleLabel))
    resizer.hidden = state.collapsed || !canResize(window.innerWidth)
    addButton.disabled = state.pickerBusy
    addLabel.textContent = state.pickerBusy ? text('sidebar_waiting_picker') : text('sidebar_add_workspace')
    clear(listEl)
    if (state.error !== null) {
      const retry = iconButton(doc, 'rotate-ccw', text('sidebar_retry'), () => void loadAll(), 16)
      listEl.appendChild(el(doc, 'div', { class: 'sb-empty' }, [el(doc, 'div', { class: 'sb-empty-title', text: state.error }), retry]))
    } else if (state.loading && state.workspaces.length === 0 && state.conversations.length === 0) {
      listEl.appendChild(el(doc, 'div', { class: 'sb-empty' }, [el(doc, 'div', { class: 'sb-empty-title', text: text('sidebar_loading_more') })]))
    } else if (isEmptyView(state.workspaces, state.conversations, state.query)) {
      listEl.appendChild(
        el(doc, 'div', { class: 'sb-empty' }, [
          icon(doc, 'folder', 20),
          el(doc, 'div', { class: 'sb-empty-title', text: text('sidebar_empty_title') }),
          el(doc, 'div', { class: 'sb-empty-hint', text: text('sidebar_empty_hint') }),
        ]),
      )
    } else {
      const groups = groupConversations(state.workspaces, state.conversations, state.query)
      if (state.query.trim().length > 0 && groups.every((group) => group.sessions.length === 0)) {
        listEl.appendChild(el(doc, 'div', { class: 'sb-empty' }, [el(doc, 'div', { class: 'sb-empty-title', text: text('sidebar_no_match') })]))
      } else {
        for (const group of groups) listEl.appendChild(renderGroup(group, false))
      }
    }
    renderStatus()
    renderFlyout()
  }

  function renderGroup(group, forceExpand) {
    const workspace = group.workspace
    const collapsed = forceExpand ? false : state.collapsedGroups.has(workspace.id)
    const chevron = iconButton(doc, collapsed ? 'chevron-right' : 'chevron-down', collapsed ? text('sidebar_expand') : text('sidebar_collapse'), (event) => {
      event.stopPropagation()
      toggleGroup(workspace.id)
    }, 16)
    const newButton = iconButton(doc, 'pencil', text('sidebar_new_conversation'), (event) => {
      event.stopPropagation()
      void newConversation(workspace.id)
    }, 16)
    newButton.disabled = workspace.missing
    attachTooltip(newButton, text('sidebar_new_conversation'))
    const moreButton = iconButton(doc, 'more-horizontal', text('sidebar_remove_workspace'), (event) => {
      event.stopPropagation()
      openWorkspaceMenu(event.currentTarget, workspace)
    }, 16)
    const nameEl = el(doc, 'div', { class: 'sb-group-name', text: workspace.name })
    attachTooltip(nameEl, workspace.path.length > 0 ? workspace.path : workspace.name)
    const headRow = el(doc, 'div', {
      class: 'sb-group-head',
      dataset: { missing: String(workspace.missing) },
      attrs: { tabindex: '0', role: 'button', 'aria-expanded': String(!collapsed) },
      on: {
        click: () => toggleGroup(workspace.id),
        keydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleGroup(workspace.id)
          }
        },
      },
    }, [
      chevron,
      icon(doc, 'folder', 16),
      workspace.missing ? el(doc, 'span', { class: 'sb-missing-dot' }) : null,
      nameEl,
      el(doc, 'div', { class: 'sb-group-actions', dataset: { persist: 'false' } }, [newButton, moreButton]),
    ])
    if (workspace.missing) attachTooltip(headRow, text('sidebar_directory_missing'))
    const body = el(doc, 'div', { class: 'sb-group-body' })
    if (!collapsed) for (const session of group.sessions) body.appendChild(renderSession(session))
    return el(doc, 'div', { class: 'sb-group' }, [headRow, body])
  }

  function renderSession(session) {
    const isCurrent = currentId() === session.id
    const run = runningRun(state.badges, session.id)
    const row = el(doc, 'div', {
      class: 'sb-session',
      dataset: { current: String(isCurrent), id: session.id },
      attrs: { tabindex: '0', role: 'button', 'aria-label': session.title },
      on: {
        click: () => void selectSession(session.id),
        dblclick: () => startRename(session),
        keydown: (event) => {
          if (event.key === 'F2') {
            event.preventDefault()
            startRename(session)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            void selectSession(session.id)
          }
        },
      },
    })

    if (state.editing !== null && state.editing.id === session.id) {
      const input = el(doc, 'input', { class: 'sb-session-rename', attrs: { type: 'text', value: session.title, 'aria-label': text('sidebar_rename') } })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commitRename(session, input.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancelRename()
        }
      })
      input.addEventListener('blur', () => void commitRename(session, input.value))
      row.appendChild(input)
      row.appendChild(el(doc, 'div', { class: 'sb-session-actions', dataset: { persist: 'true' } }))
      queueMicrotask(() => {
        input.focus()
        input.select()
      })
      return row
    }

    if (confirming(`delete:${session.id}`)) {
      row.appendChild(confirmRow(text('sidebar_confirm_delete'), text('sidebar_delete'), () => void doDelete(session), () => cancelConfirm()))
      return row
    }
    if (confirming(`terminate:${session.id}`) && run !== null) {
      row.appendChild(confirmRow(text('sidebar_confirm_terminate'), text('sidebar_terminate'), () => void doTerminate(run), () => cancelConfirm()))
      return row
    }

    const titleEl = el(doc, 'div', { class: 'sb-session-title', text: session.title })
    if (state.query.trim().length > 0) highlight(titleEl, session.title, state.query)
    row.appendChild(titleEl)
    const badge = badgeFor(state.badges, session.id)
    if (badge !== null) row.appendChild(renderBadge(badge))
    const actions = el(doc, 'div', { class: 'sb-session-actions', dataset: { persist: 'false' } })
    if (run !== null) {
      actions.appendChild(iconButton(doc, 'square', text('sidebar_terminate'), (event) => {
        event.stopPropagation()
        requestTerminate(session)
      }, 16))
    } else {
      actions.appendChild(iconButton(doc, 'pencil-line', text('sidebar_rename'), (event) => {
        event.stopPropagation()
        startRename(session)
      }, 16))
    }
    actions.appendChild(iconButton(doc, 'more-horizontal', text('sidebar_export'), (event) => {
      event.stopPropagation()
      openSessionMenu(event.currentTarget, session)
    }, 16))
    row.appendChild(actions)
    return row
  }

  function confirmRow(question, primaryLabel, onPrimary, onCancel) {
    const primary = el(doc, 'button', { attrs: { type: 'button', 'data-primary': 'true' }, text: primaryLabel })
    const cancel = el(doc, 'button', { attrs: { type: 'button' }, text: text('sidebar_cancel') })
    primary.addEventListener('click', (event) => {
      event.stopPropagation()
      onPrimary()
    })
    cancel.addEventListener('click', (event) => {
      event.stopPropagation()
      onCancel()
    })
    return el(doc, 'div', { class: 'sb-confirm' }, [el(doc, 'span', { text: question }), primary, cancel])
  }

  function renderBadge(badge) {
    const node = el(doc, 'div', { class: 'sb-badge' })
    if (badge.kind === 'unread') {
      node.appendChild(el(doc, 'span', { class: 'sb-unread', text: String(badge.count), attrs: { 'aria-label': fmt('sidebar_unread_count', { count: badge.count }) } }))
      return node
    }
    const label = badge.kind === 'running' ? text('sidebar_running') : badge.kind === 'pending' ? text('sidebar_pending') : text('sidebar_failed')
    const dot = el(doc, 'span', { class: 'sb-dot', dataset: { kind: badge.kind }, attrs: { role: 'img', 'aria-label': label } })
    node.appendChild(dot)
    return node
  }

  function highlight(node, title, query) {
    const result = matchTitle(title, query)
    if (result.ranges.length === 0) {
      node.textContent = title
      return
    }
    let cursor = 0
    for (const [start, end] of result.ranges) {
      if (start > cursor) node.appendChild(doc.createTextNode(title.slice(cursor, start)))
      const mark = doc.createElement('mark')
      mark.textContent = title.slice(start, end)
      node.appendChild(mark)
      cursor = end
    }
    if (cursor < title.length) node.appendChild(doc.createTextNode(title.slice(cursor)))
  }

  function renderFlyout() {
    if (!state.collapsed) {
      flyout.hidden = true
      flyout.dataset.open = 'false'
      return
    }
    clear(flyout)
    const groups = groupConversations(state.workspaces, state.conversations, state.query)
    for (const group of groups) flyout.appendChild(renderGroup(group, true))
  }

  // ---- 交互 ----

  function toggleGroup(id) {
    if (state.collapsedGroups.has(id)) state.collapsedGroups.delete(id)
    else state.collapsedGroups.add(id)
    render()
  }

  async function selectSession(id) {
    state.confirm = clearConfirm()
    state.badges = clearUnread(state.badges, id)
    hideFlyout()
    await writeSlot({ kind: 'session.select', conversation: id })
    await command('session.select', null)
    await loadHistory()
    render()
  }

  async function newConversation(workspaceId) {
    await writeSlot({ kind: 'session.new', workspace_id: workspaceId })
    await command('session.new', null)
    await loadHistory()
    render()
  }

  function startRename(session) {
    state.editing = { id: session.id }
    state.confirm = clearConfirm()
    render()
  }

  function cancelRename() {
    state.editing = null
    render()
  }

  async function commitRename(session, value) {
    if (state.editing === null || state.editing.id !== session.id) return
    state.editing = null
    const title = typeof value === 'string' ? value.trim() : ''
    if (title.length === 0 || title === session.title) {
      render()
      return
    }
    await writeSlot({ kind: 'session.rename', conversation: session.id, title })
    await command('session.rename', null)
    await loadHistory()
    render()
  }

  function requestTerminate(session) {
    state.confirm = beginConfirm(state.confirm, `terminate:${session.id}`, Date.now())
    scheduleConfirmRefresh()
    render()
  }

  function cancelConfirm() {
    state.confirm = clearConfirm()
    render()
  }

  async function doTerminate(run) {
    state.confirm = clearConfirm()
    render()
    if (typeof api.cancel === 'function') {
      await api.cancel(run)
      return
    }
    await postJson('api/cancel', { run })
  }

  async function doDelete(session) {
    state.confirm = clearConfirm()
    await writeSlot({ kind: 'session.delete', conversation: session.id })
    await command('session.delete', null)
    await loadHistory()
    render()
    if (typeof api.toast === 'function') {
      api.toast({
        tone: 'info',
        text: text('sidebar_deleted'),
        action: { label: text('sidebar_undo'), run: () => void restoreSession(session.id) },
      })
    }
  }

  async function restoreSession(id) {
    await writeSlot({ kind: 'session.restore', conversation: id })
    await command('session.restore', null)
    await loadHistory()
    render()
  }

  async function removeWorkspace(id) {
    await writeSlot({ kind: 'workspace.remove', workspace: id })
    await command('workspace.remove', null)
    await loadAll()
  }

  async function revealWorkspace(id) {
    const workspaces = state.workspaces.map((item) => ({ id: item.id, path: item.path }))
    const result = await command('workspace.reveal', { workspace: id, workspaces })
    if (!result.ok) setStatus(result.message.length > 0 ? result.message : result.code)
    else if (isRecord(result.value) && result.value.ok === false && isRecord(result.value.error)) {
      setStatus(String(result.value.error.message ?? result.value.error.code ?? ''))
    }
  }

  async function addWorkspace() {
    if (state.pickerBusy) return
    state.pickerBusy = true
    render()
    const picked = await command('workspace.pick', null)
    state.pickerBusy = false
    render()
    if (!picked.ok) {
      setStatus(picked.code === 'picker_unavailable' ? text('sidebar_picker_unavailable') : picked.message)
      return
    }
    const value = isRecord(picked.value) ? picked.value : null
    if (value !== null && value.cancelled === true) return
    const path = value !== null && typeof value.path === 'string' && value.path.length > 0 ? value.path : null
    if (path === null) {
      setStatus(text('sidebar_picker_unavailable'))
      return
    }
    const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await writeSlot({ kind: 'workspace.add', workspace: id, path })
    await command('workspace.add', null)
    await loadAll()
  }

  async function branchSession(session) {
    const message = session.head
    if (message === null) {
      setStatus(text('sidebar_dependency_missing'))
      return
    }
    await writeSlot({ kind: 'session.branch', conversation: session.id, message })
    await command('session.branch', null)
    await loadAll()
  }

  async function exportSession(session, format) {
    const history = state.history
    if (history === null) return
    const messages = messagesOf(history, session.id)
    const body = exportBody(format, session, messages)
    const filename = exportFilename(session, format === 'json' ? 'json' : 'md')
    try {
      if (typeof URL.createObjectURL !== 'function') throw new Error('download unsupported')
      const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const anchor = doc.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      doc.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      if (typeof api.toast === 'function') api.toast({ tone: 'success', text: text('sidebar_exported') })
    } catch {
      if (typeof api.toast === 'function') api.toast({ tone: 'danger', text: text('sidebar_export_failed') })
    }
  }

  function toggleCollapsed() {
    state.userCollapsed = !state.userCollapsed
    applyViewport()
  }

  // ---- 弹层菜单 ----

  function openMenu(anchor, items) {
    closeMenu()
    menuAnchor = anchor
    clear(menuEl)
    for (const item of items) {
      const button = el(doc, 'button', { attrs: { type: 'button', role: 'menuitem' } }, [icon(doc, item.icon, 16), el(doc, 'span', { text: item.label })])
      if (item.danger === true) button.dataset.danger = 'true'
      if (item.disabled === true) button.disabled = true
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        closeMenu()
        item.run()
      })
      menuEl.appendChild(button)
    }
    menuEl.hidden = false
    const rect = anchor.getBoundingClientRect()
    const menuRect = menuEl.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))
    const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8)
    menuEl.style.left = `${Math.round(left)}px`
    menuEl.style.top = `${Math.round(top)}px`
    const first = menuEl.querySelector('button:not(:disabled)')
    if (first !== null) first.focus()
  }

  function closeMenu() {
    menuEl.hidden = true
    clear(menuEl)
    menuAnchor = null
  }

  /** `Esc` 关闭：把焦点归还触发按钮（全局 UI 规范），点外部关闭不抢焦点。 */
  function closeMenuAndRestoreFocus() {
    const anchor = menuAnchor
    closeMenu()
    if (anchor !== null && typeof anchor.focus === 'function' && doc.contains(anchor)) anchor.focus()
  }

  function openWorkspaceMenu(anchor, workspace) {
    openMenu(anchor, [
      { icon: 'folder-open', label: text('sidebar_open_in_explorer'), run: () => void revealWorkspace(workspace.id) },
      { icon: 'trash-2', label: text('sidebar_remove_workspace'), danger: true, run: () => void removeWorkspace(workspace.id) },
    ])
  }

  function openSessionMenu(anchor, session) {
    openMenu(anchor, [
      { icon: 'pencil-line', label: text('sidebar_rename'), run: () => startRename(session) },
      { icon: 'download', label: text('sidebar_export_md'), run: () => void exportSession(session, 'md') },
      { icon: 'download', label: text('sidebar_export_json'), run: () => void exportSession(session, 'json') },
      { icon: 'git-branch', label: text('sidebar_branch'), disabled: session.head === null, run: () => void branchSession(session) },
      { icon: 'trash-2', label: text('sidebar_delete'), danger: true, run: () => confirmDelete(session) },
    ])
  }

  function confirmDelete(session) {
    state.confirm = beginConfirm(state.confirm, `delete:${session.id}`, Date.now())
    scheduleConfirmRefresh()
    render()
  }

  function scheduleConfirmRefresh() {
    if (confirmTimer !== null) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      if (state.confirm.key !== null) {
        state.confirm = clearConfirm()
        render()
      }
    }, CONFIRM_MS + 50)
  }

  // ---- 收缩态 flyout ----

  function openFlyout() {
    if (!state.collapsed) return
    if (flyoutTimer !== null) clearTimeout(flyoutTimer)
    flyoutTimer = setTimeout(() => {
      flyoutTimer = null
      if (!state.collapsed || disposed) return
      renderFlyout()
      const rect = container.getBoundingClientRect()
      flyout.style.left = `${Math.round(rect.right)}px`
      flyout.style.top = `${Math.round(rect.top)}px`
      flyout.style.maxHeight = `${Math.round(rect.height)}px`
      flyout.hidden = false
      flyout.dataset.open = 'true'
    }, FLYOUT_OPEN_MS)
  }

  function hideFlyout() {
    if (flyoutTimer !== null) clearTimeout(flyoutTimer)
    flyout.dataset.open = 'false'
    flyoutTimer = setTimeout(() => {
      flyoutTimer = null
      if (flyout.dataset.open !== 'true') flyout.hidden = true
    }, FLYOUT_CLOSE_MS)
  }

  // ---- 宽度 / 断点 ----

  function applyViewport() {
    if (disposed) return
    state.collapsed = resolveCollapsed(window.innerWidth, state.userCollapsed)
    const width = canResize(window.innerWidth) ? effectiveWidth(window.innerWidth, state.storedWidth, state.collapsed) : WIDTH_COLLAPSED
    container.style.setProperty('--sb-width', `${width}px`)
    if (state.collapsed) hideFlyout()
    render()
  }

  function scheduleWidthWrite() {
    if (widthTimer !== null) clearTimeout(widthTimer)
    widthTimer = setTimeout(() => {
      widthTimer = null
      void persistWidth()
    }, WRITE_DEBOUNCE_MS)
  }

  async function persistWidth() {
    const result = await command('config.read', null)
    if (!result.ok || !isRecord(result.value)) return
    const config = result.value
    const ui = isRecord(config.ui) ? { ...config.ui } : {}
    ui.sidebar_width = clampWidth(state.storedWidth)
    const body = { ...config, ui }
    const directives = [
      {
        kind: 'write',
        request: {
          op: 'batch',
          args: {
            ops: [
              { op: 'put', args: { body } },
              { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
        },
      },
    ]
    await postJson('api/submit', { directives })
  }

  // ---- 事件订阅 ----

  function connectEvents() {
    try {
      source = new EventSource(new URL('events', BASE).href)
    } catch {
      return
    }
    source.onmessage = (event) => {
      let record
      try {
        record = JSON.parse(event.data)
      } catch {
        return
      }
      handleRecord(record)
    }
  }

  function handleRecord(record) {
    if (!isRecord(record)) return
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.topic === 'sidebar.state') {
      state.connected = payload.connected === true
      return
    }
    const before = JSON.stringify(state.badges)
    state.badges = applyEvent(state.badges, record.impl, record.topic, payload)
    if (record.topic === 'thread.updated' || record.topic === 'thread.opened' || record.topic === 'thread.closed' || record.topic === 'run.finished') {
      scheduleReload()
    }
    if (JSON.stringify(state.badges) !== before) render()
  }

  // ---- 事件绑定 ----

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value
    render()
  })
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = ''
      state.query = ''
      render()
    }
  })
  addButton.addEventListener('click', () => void addWorkspace())
  settingsButton.addEventListener('click', () => {
    if (api.uiState !== undefined && typeof api.uiState.set === 'function') api.uiState.set('settings_open', true)
  })
  listEl.addEventListener('mouseenter', openFlyout)
  listEl.addEventListener('mouseleave', hideFlyout)
  flyout.addEventListener('mouseenter', openFlyout)
  flyout.addEventListener('mouseleave', hideFlyout)
  doc.addEventListener('click', () => closeMenu())
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenuAndRestoreFocus()
  })
  window.addEventListener('resize', () => applyViewport())
  resizer.addEventListener('pointerdown', (event) => {
    if (!canResize(window.innerWidth) || state.collapsed) return
    event.preventDefault()
    drag = { startX: event.clientX, startWidth: effectiveWidth(window.innerWidth, state.storedWidth, false) }
    container.dataset.dragging = 'true'
    resizer.setPointerCapture?.(event.pointerId)
  })
  resizer.addEventListener('pointermove', (event) => {
    if (drag === null) return
    const width = widthFromDrag(drag.startWidth, event.clientX - drag.startX)
    state.storedWidth = width
    container.style.setProperty('--sb-width', `${width}px`)
  })
  const endDrag = () => {
    if (drag === null) return
    drag = null
    container.dataset.dragging = 'false'
    scheduleWidthWrite()
  }
  resizer.addEventListener('pointerup', endDrag)
  resizer.addEventListener('pointercancel', endDrag)

  // ---- 启动 ----

  connectEvents()
  applyViewport()
  await loadAll()

  return {
    unmount() {
      disposed = true
      if (source !== null) source.close()
      for (const timer of [tooltipTimer, flyoutTimer, reloadTimer, confirmTimer, widthTimer, statusTimer]) {
        if (timer !== null) clearTimeout(timer)
      }
      window.removeEventListener('resize', applyViewport)
      flyout.remove()
      menuEl.remove()
      tooltip.remove()
      root.replaceChildren()
    },
  }
}
