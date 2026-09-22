// `ui-approval` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约）。
// dock 槽：待审批停靠带——0 高度起步，有待审批项才渲染；多条按队列 + 计数 + 整批裁决。
// 卡片态由宿主事件（`approval.pending` / `approval.decided`）驱动；裁决经本插件服务写 `#1` 槽后调无参命令。

import { ensureStyles } from './styles.js'
import { el, icon, clear, textButton } from './dom.js'
import { formatText, loadMessages, messageText } from './messages.js'
import {
  armConfirm,
  clearConfirm,
  confirmArmed,
  CONFIRM_APPROVE_ALL,
  CONFIRM_DENY_ALL,
  createConfirmState,
  defaultExpanded,
  elapsedMs,
  formatWait,
  isPending,
  itemTone,
  KIND_ORCHESTRATION_CHANGE,
  KIND_PLUGIN_WRITE,
  verdictOf,
  viewOf,
  waitWarning,
} from './model.js'
import { decide, runCommand } from './client.js'
import { connectEvents } from './sse.js'

export const contract = '1'

/** 整批裁决的线程键（缺 `id` = 全部；槽写在本键下）。 */
const BATCH_THREAD = '_main'

/** 挂载子应用；返回 `{unmount}`（壳会 await 本函数）。 */
export async function mount(root, api) {
  const doc = root.ownerDocument
  ensureStyles(doc)
  const table = await loadMessages(fetch, '/assets/messages.v1.json')
  const t = (code, vars) =>
    vars === undefined ? messageText(table, code) : formatText(table, code, vars)

  const state = {
    items: [],
    refs: {},
    loading: true,
    error: null,
    expanded: new Set(),
    busy: null,
    itemErrors: new Map(),
    lastBatch: null,
    decided: new Set(),
    confirm: createConfirmState(),
    connected: false,
    announced: -1,
  }

  let disposed = false
  let confirmTimer = null
  let tickTimer = null
  let waitEl = null

  const container = el(doc, 'div', { class: 'approval-root' })
  const liveRegion = el(doc, 'div', {
    class: 'approval-sr',
    attrs: { 'aria-live': 'assertive', 'aria-atomic': 'true' },
  })
  root.replaceChildren(container)

  function announce(message) {
    liveRegion.textContent = ''
    setTimeout(() => {
      liveRegion.textContent = message
    }, 0)
  }

  function resetConfirm() {
    if (confirmTimer !== null) clearTimeout(confirmTimer)
    confirmTimer = null
    state.confirm = clearConfirm()
  }

  function armOrRun(kind, run) {
    const now = Date.now()
    if (confirmArmed(state.confirm, kind, now)) {
      resetConfirm()
      void run()
      return
    }
    state.confirm = armConfirm(state.confirm, kind, now)
    if (confirmTimer !== null) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      state.confirm = clearConfirm()
      render()
    }, 3000)
    render()
  }

  // ---- 数据 ----

  async function loadList() {
    const result = await runCommand('approval.list', null, null)
    if (disposed) return
    state.loading = false
    if (!result.ok) {
      state.error = { code: result.code, message: '' }
      render()
      return
    }
    const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
    state.error = value.ok === false ? { code: value.error && value.error.code ? value.error.code : 'unknown', message: '' } : null
    state.items = Array.isArray(value.items) ? value.items : []
    state.refs = value.refs !== null && typeof value.refs === 'object' ? value.refs : {}
    for (const item of state.items) {
      if (defaultExpanded(item) && typeof item.id === 'string') state.expanded.add(item.id)
    }
    render()
  }

  async function submitItem(item, action) {
    const verdict = verdictOf(action)
    const id = typeof item.id === 'string' ? item.id : ''
    if (verdict === null || id.length === 0) return
    state.busy = id
    state.itemErrors.delete(id)
    render()
    const threadKey = typeof item.thread === 'string' && item.thread.length > 0 ? item.thread : BATCH_THREAD
    const result = await decide(threadKey, { kind: 'approval.decide', id, verdict })
    if (disposed) return
    state.busy = null
    if (!result.ok) {
      // 续跑回合可能超出命令等待上限；已收到 `approval.decided` 的条目按成功处理，不显假失败。
      if (state.decided.has(id)) {
        void loadList()
        return
      }
      state.itemErrors.set(id, { code: result.code || 'unknown', action })
      render()
      return
    }
    state.itemErrors.delete(id)
    void loadList()
  }

  async function submitAll(verdict) {
    state.busy = 'all'
    state.error = null
    state.lastBatch = verdict
    render()
    const result = await decide(BATCH_THREAD, { kind: 'approval.decide', verdict })
    if (disposed) return
    state.busy = null
    if (!result.ok) {
      if (state.decided.size > 0) {
        void loadList()
        return
      }
      state.error = { code: result.code || 'unknown', message: '' }
      render()
      return
    }
    void loadList()
  }

  // ---- 渲染 ----

  function oldestPending() {
    let oldest = null
    for (const item of state.items) {
      if (!isPending(item)) continue
      const at = typeof item.at === 'string' ? Date.parse(item.at) : NaN
      if (!Number.isFinite(at)) continue
      if (oldest === null || at < oldest) oldest = at
    }
    return oldest
  }

  function render() {
    if (disposed) return
    clear(container)
    waitEl = null
    const pending = state.items.filter(isPending)
    if (state.loading && state.items.length === 0) {
      container.appendChild(loadingCard())
      return
    }
    if (pending.length === 0) {
      // 无待审批项：不占高度、不渲染（0 高度只在无任何项时成立）。
      root.setAttribute('data-empty', 'true')
      return
    }
    root.removeAttribute('data-empty')
    container.appendChild(renderDock(pending))
    announceCount(pending.length)
  }

  function announceCount(count) {
    if (state.announced === count) return
    state.announced = count
    announce(t('approval_waiting', { count }))
  }

  function loadingCard() {
    return el(doc, 'div', { class: 'approval-dock' }, [
      el(doc, 'div', { class: 'approval-head' }, [
        el(doc, 'span', { class: 'approval-head-count', text: t('approval_loading') }),
      ]),
    ])
  }

  function renderDock(pending) {
    const head = el(doc, 'div', { class: 'approval-head' })
    const count = el(doc, 'span', { class: 'approval-head-count' })
    count.appendChild(icon(doc, 'list', 16))
    count.appendChild(el(doc, 'span', { text: t('approval_waiting', { count: pending.length }) }))
    head.appendChild(count)

    waitEl = el(doc, 'span', { class: 'approval-head-wait' })
    head.appendChild(waitEl)
    head.appendChild(el(doc, 'span', { class: 'approval-head-spacer' }))

    head.appendChild(renderHeadButton(CONFIRM_DENY_ALL, pending.length, 'danger', () => submitAll('deny')))
    head.appendChild(renderHeadButton(CONFIRM_APPROVE_ALL, pending.length, 'accent', () => submitAll('approve')))

    const list = el(doc, 'div', { class: 'approval-list' })
    for (const item of pending) list.appendChild(renderItem(item))

    const children = [head]
    if (state.error !== null) children.push(renderBatchError())
    children.push(list)
    const dock = el(doc, 'div', { class: 'approval-dock', attrs: { role: 'region', 'aria-label': t('approval_dock_label') } }, children)
    updateWait()
    return dock
  }

  function renderBatchError() {
    const retry = textButton(doc, t('approval_retry'), () => {
      if (state.lastBatch !== null) void submitAll(state.lastBatch)
    }, { disabled: state.busy !== null })
    return el(doc, 'div', { class: 'approval-danger-inline', dataset: { role: 'batch-error' } }, [
      el(doc, 'span', { text: t('approval_failed') }),
      retry,
    ])
  }

  function renderHeadButton(kind, count, tone, run) {
    const armed = confirmArmed(state.confirm, kind, Date.now())
    const label = armed
      ? kind === CONFIRM_APPROVE_ALL
        ? t('approval_confirm_approve', { count })
        : t('approval_confirm_deny')
      : kind === CONFIRM_APPROVE_ALL
        ? t('approval_all_approve')
        : t('approval_all_deny')
    const button = textButton(doc, label, () => armOrRun(kind, run), {
      tone,
      busy: state.busy === 'all',
      busyLabel: t('approval_submitting'),
      disabled: state.busy !== null,
    })
    if (armed) button.dataset.armed = 'true'
    if (kind === CONFIRM_DENY_ALL) {
      button.title = t('approval_all_deny_hint')
      button.setAttribute('aria-label', `${t('approval_all_deny')}，${t('approval_all_deny_hint')}`)
    }
    return button
  }

  function renderItem(item) {
    const id = typeof item.id === 'string' ? item.id : ''
    const view = viewOf(item, state.refs)
    const expanded = state.expanded.has(id)
    const busy = state.busy === id
    const row = el(doc, 'div', { class: 'approval-item', dataset: { tone: itemTone(item), kind: view.kind } })

    const main = el(doc, 'div', { class: 'approval-item-main' })
    const toggle = el(doc, 'button', {
      class: 'approval-item-toggle',
      attrs: {
        type: 'button',
        'aria-expanded': expanded ? 'true' : 'false',
        'aria-label': expanded ? t('approval_collapse') : t('approval_expand'),
      },
      on: {
        click: () => {
          if (expanded) state.expanded.delete(id)
          else state.expanded.add(id)
          render()
        },
      },
    })
    toggle.appendChild(el(doc, 'span', { class: 'approval-item-tool', text: summaryLead(view) }))
    toggle.appendChild(el(doc, 'span', { class: 'approval-item-summary', text: summaryText(view) }))
    if (itemTone(item) === 'expired') {
      toggle.appendChild(el(doc, 'span', { class: 'approval-tag', text: t('approval_expired_label') }))
    }
    main.appendChild(toggle)
    main.appendChild(renderItemActions(item, id, busy))
    row.appendChild(main)

    const detail = renderDetail(item, view)
    detail.hidden = !expanded
    row.appendChild(detail)

    const error = state.itemErrors.get(id)
    if (error !== undefined) {
      const retry = textButton(doc, t('approval_retry'), () => submitItem(item, error.action), {
        class: 'approval-btn',
        disabled: busy,
      })
      row.appendChild(
        el(doc, 'div', { class: 'approval-danger-inline' }, [
          el(doc, 'span', { text: t('approval_failed') }),
          retry,
        ]),
      )
    }
    return row
  }

  function renderItemActions(item, id, busy) {
    const actions = el(doc, 'span', { class: 'approval-item-actions' })
    const deny = textButton(doc, t('approval_deny'), () => submitItem(item, 'deny'), {
      tone: 'danger',
      busy,
      busyLabel: t('approval_submitting'),
      disabled: busy,
    })
    deny.title = t('approval_deny_hint')
    deny.setAttribute('aria-label', `${t('approval_deny')}，${t('approval_deny_hint')}`)
    const approve = textButton(doc, t('approval_approve'), () => submitItem(item, 'approve'), {
      tone: 'accent',
      busy,
      busyLabel: t('approval_submitting'),
      disabled: busy,
    })
    actions.appendChild(deny)
    actions.appendChild(approve)
    return actions
  }

  function summaryLead(view) {
    if (view.kind === KIND_ORCHESTRATION_CHANGE) return t('approval_orchestration_change')
    if (view.kind === KIND_PLUGIN_WRITE) return t('approval_plugin_write')
    return view.tool !== null ? view.tool : t('approval_tool_call')
  }

  function summaryText(view) {
    if (view.kind === KIND_ORCHESTRATION_CHANGE) return view.title || diffLabel(view.diff)
    if (view.kind === KIND_PLUGIN_WRITE) return pluginWriteSummary(view)
    return view.args || t('approval_no_args')
  }

  function diffLabel(diff) {
    if (diff === null) return ''
    const nodes = signed(diff.nodesAdded) + signed(diff.nodesRemoved)
    const edges = signed(diff.edgesAdded) + signed(diff.edgesRemoved)
    return t('approval_nodes_edges', { nodes, edges })
  }

  function pluginWriteSummary(view) {
    const parts = []
    if (view.plugin !== null) parts.push(view.plugin)
    if (view.count !== null) parts.push(t('approval_files_count', { count: view.count }))
    if (view.validate === true) parts.push(t('approval_validate_ok'))
    if (view.validate === false) parts.push(t('approval_validate_failed'))
    return parts.join(' · ')
  }

  function renderDetail(item, view) {
    const detail = el(doc, 'div', { class: 'approval-item-detail' })
    if (view.kind === KIND_ORCHESTRATION_CHANGE) {
      renderShadow(detail, view)
      return detail
    }
    if (view.kind === KIND_PLUGIN_WRITE) {
      renderPluginWrite(detail, view)
      return detail
    }
    detail.textContent = view.args || t('approval_no_args')
    return detail
  }

  function renderShadow(detail, view) {
    if (view.rounds !== null) {
      detail.appendChild(el(doc, 'div', { class: 'approval-shadow-title', text: t('approval_shadow_title') }))
      detail.appendChild(el(doc, 'div', { class: 'approval-note', text: t('approval_shadow_rounds', { count: view.rounds }) }))
    }
    if (view.rows.length > 0) {
      const rows = el(doc, 'div', { class: 'approval-shadow-rows' })
      for (const row of view.rows) {
        rows.appendChild(
          el(doc, 'span', { class: 'approval-shadow-row' }, [
            el(doc, 'span', { class: 'label', text: t(row.code) }),
            el(doc, 'span', { class: 'from', text: row.fromText }),
            el(doc, 'span', { class: 'arrow', text: '→' }),
            el(doc, 'span', { class: 'to', text: row.toText }),
            el(doc, 'span', { class: 'delta', dataset: { tone: row.tone }, text: row.delta }),
          ]),
        )
      }
      detail.appendChild(rows)
    }
    if (view.diff !== null) {
      detail.appendChild(el(doc, 'div', { class: 'approval-note', text: `${t('approval_graph_diff')}：${diffLabel(view.diff)}` }))
      for (const entry of view.diff.items) {
        detail.appendChild(el(doc, 'div', { class: 'approval-note', text: diffItemText(entry) }))
      }
    }
  }

  function diffItemText(entry) {
    if (typeof entry.summary === 'string') return entry.summary
    if (typeof entry.op === 'string' && typeof entry.path === 'string') return `${entry.op} ${entry.path}`
    return JSON.stringify(entry)
  }

  function renderPluginWrite(detail, view) {
    for (const file of view.files) {
      const path = typeof file.path === 'string' ? file.path : JSON.stringify(file)
      detail.appendChild(el(doc, 'div', { class: 'approval-note', text: path }))
    }
    if (view.validate === true) detail.appendChild(el(doc, 'div', { class: 'approval-note', dataset: { tone: 'success' }, text: t('approval_validate_ok') }))
    if (view.validate === false) detail.appendChild(el(doc, 'div', { class: 'approval-note', dataset: { tone: 'danger' }, text: t('approval_validate_failed') }))
    detail.appendChild(el(doc, 'div', { class: 'approval-danger-inline', text: t('approval_isolation_risk') }))
  }

  function signed(value) {
    return value >= 0 ? `+${value}` : `${value}`
  }

  function updateWait() {
    if (waitEl === null) return
    const oldest = oldestPending()
    if (oldest === null) {
      waitEl.textContent = ''
      return
    }
    const waited = elapsedMs({ at: new Date(oldest).toISOString() }, Date.now())
    waitEl.textContent = t('approval_waited', { time: formatWait(waited) })
    waitEl.dataset.warn = waitWarning(waited) ? 'true' : 'false'
  }

  // ---- 键盘 / 焦点 ----

  function onDocClick(event) {
    if (state.confirm.armed === null) return
    const armedButton = container.querySelector('.approval-btn[data-armed="true"]')
    if (armedButton !== null && armedButton.contains(event.target)) return
    resetConfirm()
    render()
  }

  function onKeydown(event) {
    if (event.key !== 'Escape' || state.confirm.armed === null) return
    resetConfirm()
    render()
  }

  doc.addEventListener('click', onDocClick)
  doc.addEventListener('keydown', onKeydown)

  // ---- 事件 / 计时 ----

  const closeEvents = connectEvents((record) => {
    if (record.topic === 'ui-approval.state') {
      const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
      const wasConnected = state.connected
      state.connected = payload.connected === true
      if (state.connected && !wasConnected && state.error !== null) void loadList()
      return
    }
    if (record.topic === 'approval.pending' || record.topic === 'approval.decided') {
      if (record.topic === 'approval.decided') {
        const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
        if (typeof payload.id === 'string' && payload.id.length > 0) state.decided.add(payload.id)
      }
      void loadList()
    }
  })

  tickTimer = setInterval(updateWait, 1000)

  await loadList()

  return {
    unmount() {
      disposed = true
      closeEvents()
      if (confirmTimer !== null) clearTimeout(confirmTimer)
      if (tickTimer !== null) clearInterval(tickTimer)
      doc.removeEventListener('click', onDocClick)
      doc.removeEventListener('keydown', onKeydown)
      root.removeAttribute('data-empty')
      root.replaceChildren()
    },
  }
}
