// `ui-settings` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约）。
// overlay 槽：引导页（无配置时）+ 设置模态（通用 / 模型 / 插件 / 技能 / 记忆 / 编排 / 关于）。
// 本文件只做编排：状态 / 入站网络 / 开合 / 订阅；各页渲染与动作住同目录视图 / 动作模块。
// 命令 / 提交一律经本插件自己的入站连接（失败隔离：本 slot 内错误占位 + 重试）。

import { ensureStyles } from './styles.js'
import { el, icon, iconButton, clear } from './dom.js'
import { formatText, loadMessages, messageText } from './messages.js'
import { batchWriteDirective, configWriteDirective } from './config-model.js'
import { applyTemplate, defaultOnboarding } from './onboarding.js'
import { HEALTH_OK, healthView } from './health.js'
import { TABS, normalizeTab } from './settings-model.js'
import { blockLoading, errorBar } from './ui-parts.js'
import { renderOnboarding } from './view-onboarding.js'
import { renderGeneral } from './view-general.js'
import { renderModel } from './view-model.js'
import { renderPlugins } from './view-plugins.js'
import { renderSkills } from './view-skills.js'
import { renderMemory } from './view-memory.js'
import { renderOrchestration } from './view-orchestration.js'
import { renderAbout } from './view-about.js'
import { currentThemePref, setTheme } from './theme-actions.js'
import { handleNotifyState, loadNotify, requestPermission } from './notify-actions.js'
import { exportConfig, importConfig } from './config-io.js'
import { commitProvider, commitProviderEdit, fetchModels, refreshProvider, saveProviderSecret } from './provider-actions.js'
import { loadHealth, loadOrchestration, loadTab, loadVendors } from './data-load.js'
import { doMemoryEdit, doMemorySearch } from './memory-actions.js'
import { applyWrite, postJson, readSlots, runCommand } from './client.js'
import { connectEvents } from './sse.js'

export const contract = '1'

const THREAD_KEY = '_main'

/** 挂载子应用；返回 `{unmount}`（壳会 await 本函数）。 */
export async function mount(root, api) {
  const doc = root.ownerDocument
  ensureStyles(doc)
  const table = await loadMessages(fetch, '/assets/messages.v1.json')
  const text = (code, vars) => (vars === undefined ? messageText(table, code) : formatText(table, code, vars))

  const state = {
    mode: 'closed',
    tab: 'general',
    config: null,
    identities: null,
    vendors: null,
    secrets: {},
    notify: null,
    permission: 'unknown',
    loading: false,
    loadingNote: false,
    error: null,
    savedKey: null,
    pendingRemove: null,
    providerForm: null,
    editingProvider: null,
    skillProjection: null,
    skillForm: null,
    onboarding: null,
    orch: { graph: null, scopes: null, health: null, degraded: { graph: false, scopes: false, health: false } },
    memory: {
      layer: 'l1',
      workspace: '',
      view: null,
      viewDegraded: false,
      query: '',
      search: null,
      searchDegraded: false,
      searchBusy: false,
      identitiesStale: false,
      edit: null,
      editError: null,
      confirmDelete: null,
      busy: false,
    },
    ledgerOpen: null,
    rollbackConfirm: false,
    rollbackBusy: false,
    rollbackNote: null,
    contentFade: false,
  }

  let disposed = false
  let returnFocus = null
  let loadingTimer = null

  const container = el(doc, 'div', { class: 'settings-root', attrs: { hidden: true } })
  const liveRegion = el(doc, 'div', { class: 'settings-sr', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } })
  container.appendChild(liveRegion)
  root.replaceChildren(container)

  function announce(message) {
    liveRegion.textContent = ''
    setTimeout(() => {
      liveRegion.textContent = message
    }, 0)
  }

  // ---- 入站能力 ----

  async function writeConfig(body, key) {
    const result = await applyWrite(configWriteDirective(body), THREAD_KEY)
    if (result.ok) {
      state.config = body
      state.savedKey = key ?? null
      announce(text('settings_saved'))
    }
    return result
  }

  function markSaved(key) {
    state.savedKey = key ?? null
  }

  async function writeSkillBody(body, key) {
    const result = await applyWrite(batchWriteDirective('skill', body), THREAD_KEY)
    if (result.ok) {
      state.skillProjection = { body, refs: {}, active: null, gens: [] }
      state.savedKey = key ?? null
    } else {
      state.error = { code: result.code, message: '' }
    }
    render()
  }

  function armLoadingNote(onNote) {
    clearLoadingNote()
    loadingTimer = setTimeout(() => {
      loadingTimer = null
      onNote()
    }, 8000)
  }

  function clearLoadingNote() {
    if (loadingTimer !== null) clearTimeout(loadingTimer)
    loadingTimer = null
  }

  // ---- 编排回滚（入站面直接提交 set_active，二次确认） ----

  async function doRollback() {
    const target = healthView(state.orch.health).rollback
    if (target === null) return
    state.rollbackBusy = true
    state.rollbackNote = null
    render()
    try {
      const result = await applyWrite(
        {
          kind: 'write',
          request: { op: 'set_active', args: { id: 'loop-policy', active: target.payload } },
        },
        THREAD_KEY,
      )
      // 回灌缺失时无法逐字节验证：只显「回滚未验证」，不显成功（验收 9）。
      state.rollbackNote = result.ok
        ? { tone: 'muted', text: text('settings_orch_rollback_unverified') }
        : { tone: 'danger', text: text('settings_orch_rollback_failed') }
    } finally {
      state.rollbackBusy = false
      render()
      void loadOrchestration(ctx)
    }
  }

  // ---- 保存高亮 / 健康角标 ----

  function applySavedHighlight() {
    if (state.savedKey === null) return
    const key = state.savedKey
    state.savedKey = null
    const node = container.querySelector(`[data-saved-key="${key}"]`)
    if (node === null) return
    node.dataset.saved = 'true'
    setTimeout(() => {
      if (node.isConnected) node.dataset.saved = 'false'
    }, 150)
  }

  function shouldWarnHealth() {
    if (state.orch.degraded.health === true) return false
    return healthView(state.orch.health).status !== HEALTH_OK
  }

  /** 就地增删编排 tab 的 warning 小圆点（不整页重渲染，避免丢焦点）。 */
  function updateHealthDot() {
    const button = container.querySelector('[data-tab="orchestration"]')
    if (button === null) return
    const existing = button.querySelector('.settings-tab-dot')
    const warn = shouldWarnHealth()
    if (warn && existing === null) button.appendChild(el(doc, 'span', { class: 'settings-tab-dot' }))
    else if (!warn && existing !== null) existing.remove()
  }

  // ---- 渲染骨架 ----

  function render() {
    if (disposed) return
    if (state.mode === 'closed') {
      container.hidden = true
      clear(container)
      container.appendChild(liveRegion)
      return
    }
    container.hidden = false
    clear(container)
    container.appendChild(liveRegion)
    if (state.mode === 'onboarding') container.appendChild(renderOnboarding(ctx))
    else container.appendChild(renderSettings())
    applySavedHighlight()
  }

  function renderSettings() {
    const nav = el(doc, 'div', { class: 'settings-nav' })
    const head = el(doc, 'div', { class: 'settings-nav-head' }, [
      el(doc, 'span', { class: 'settings-nav-title', text: text('settings_title') }),
      iconButton(doc, 'x', text('settings_close'), () => closeOverlay()),
    ])
    nav.appendChild(head)
    const tablist = el(doc, 'div', { attrs: { role: 'tablist' } })
    for (const tab of TABS) {
      const selected = state.tab === tab.id
      const button = el(doc, 'button', {
        class: 'settings-tab',
        attrs: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', 'data-tab': tab.id },
      })
      button.appendChild(icon(doc, tab.icon, 16))
      button.appendChild(el(doc, 'span', { text: text(`settings_tab_${tab.id}`) }))
      if (tab.id === 'orchestration' && shouldWarnHealth()) {
        button.appendChild(el(doc, 'span', { class: 'settings-tab-dot' }))
      }
      button.addEventListener('click', () => {
        state.tab = normalizeTab(tab.id)
        state.error = null
        state.rollbackConfirm = false
        state.contentFade = true
        render()
        void loadTab(ctx, state.tab)
      })
      tablist.appendChild(button)
    }
    nav.appendChild(tablist)

    const content = el(doc, 'div', { class: 'settings-content', attrs: { role: 'tabpanel' } })
    renderTabContent(content)
    const modal = el(
      doc,
      'div',
      { class: 'settings-modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': text('settings_title') } },
      [nav, content],
    )
    const backdrop = el(doc, 'div', { class: 'settings-backdrop', on: { click: () => closeOverlay() } })
    return el(doc, 'div', { class: 'settings-root' }, [backdrop, modal])
  }

  function renderTabContent(content) {
    if (state.loading) {
      content.appendChild(blockLoading(ctx, state.loadingNote))
      return
    }
    if (state.error !== null && state.error.code !== null) {
      content.appendChild(
        errorBar(ctx, state.error, () => {
          state.error = null
          render()
          void loadTab(ctx, state.tab)
        }),
      )
      return
    }
    // tab 切换后的最终内容 150ms 淡入（不滑动）；同一 tab 的后续重渲染不重复动画。
    if (state.contentFade) {
      content.classList.add('settings-content-fade')
      state.contentFade = false
    }
    switch (state.tab) {
      case 'general':
        renderGeneral(ctx, content)
        return
      case 'model':
        renderModel(ctx, content)
        return
      case 'plugins':
        renderPlugins(ctx, content)
        return
      case 'skills':
        renderSkills(ctx, content)
        return
      case 'memory':
        renderMemory(ctx, content)
        return
      case 'orchestration':
        renderOrchestration(ctx, content)
        return
      default:
        renderAbout(ctx, content)
    }
  }

  // ---- 键盘 / 焦点 / 背景 ----

  function onKeydown(event) {
    if (state.mode === 'closed') return
    if (event.key === 'Escape') {
      if (state.mode === 'settings') closeOverlay()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = container.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = doc.activeElement
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }
  doc.addEventListener('keydown', onKeydown)

  function focusFirst() {
    const focusable = container.querySelector(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable !== null && typeof focusable.focus === 'function') focusable.focus()
  }

  const bgHidden = new Map()

  /** 模态打开时把背景（壳应用等）标 `aria-hidden`，关闭时还原。 */
  function setBackgroundHidden(on) {
    const body = doc.body
    if (body === null) return
    if (on) {
      for (const node of body.children) {
        if (node === root.parentElement) continue
        if (node === container || node.contains(container)) continue
        if (node.id === 'shell-toasts' || node.id === 'shell-banner' || node.id === 'shell-splash') continue
        if (!bgHidden.has(node)) bgHidden.set(node, node.getAttribute('aria-hidden'))
        node.setAttribute('aria-hidden', 'true')
      }
      return
    }
    for (const [node, previous] of bgHidden) {
      if (previous === null) node.removeAttribute('aria-hidden')
      else node.setAttribute('aria-hidden', previous)
    }
    bgHidden.clear()
  }

  // ---- 开合 ----

  async function openSettings() {
    returnFocus = doc.activeElement
    state.mode = 'settings'
    state.error = null
    setBackgroundHidden(true)
    render()
    focusFirst()
    void loadHealth(ctx)
    await loadTab(ctx, state.tab)
    focusFirst()
  }

  function openOnboarding() {
    if (state.mode === 'onboarding') return
    returnFocus = doc.activeElement
    state.mode = 'onboarding'
    state.onboarding = defaultOnboarding()
    setBackgroundHidden(true)
    render()
    focusFirst()
    void (async () => {
      const templates = await loadVendors(ctx)
      const form = state.onboarding
      if (form === null) return
      form.templates = templates
      if (form.templateIdentity === '') applyTemplate(form, 'custom')
      render()
      focusFirst()
    })()
  }

  function closeOverlay() {
    state.mode = 'closed'
    setBackgroundHidden(false)
    render()
    const focus = returnFocus
    returnFocus = null
    if (focus !== null && focus !== undefined && typeof focus.focus === 'function' && doc.contains(focus)) {
      focus.focus()
    }
  }

  // ---- 视图上下文（视图 / 动作模块共用） ----

  const ctx = {
    doc,
    api,
    text,
    table,
    state,
    threadKey: THREAD_KEY,
    render,
    announce,
    postJson,
    runCommand,
    applyWrite: (directive) => applyWrite(directive, THREAD_KEY),
    readSlots: () => readSlots(THREAD_KEY),
    writeConfig,
    writeSkillBody,
    markSaved,
    armLoadingNote,
    clearLoadingNote,
    updateHealthDot,
    closeOverlay,
    doRollback,
    defaultOnboarding,
    applyTemplate,
    currentThemePref: () => currentThemePref(ctx),
    setTheme: (card) => setTheme(ctx, card),
    commitProvider: (form, options) => commitProvider(ctx, form, options),
    commitProviderEdit: (form, key) => commitProviderEdit(ctx, form, key),
    refreshProvider: (key) => refreshProvider(ctx, key),
    saveProviderSecret: (name, value, key) => saveProviderSecret(ctx, name, value, key),
    fetchModels: (form) => fetchModels(ctx, form),
    loadTab: (tab) => loadTab(ctx, tab),
    loadHealth: () => loadHealth(ctx),
    loadVendors: () => loadVendors(ctx),
    doMemorySearch: () => doMemorySearch(ctx),
    doMemoryEdit: (action, layer, id, patch) => doMemoryEdit(ctx, action, layer, id, patch),
    requestPermission: () => requestPermission(ctx),
    exportConfig: () => exportConfig(ctx),
    importConfig: () => importConfig(ctx),
  }

  // ---- uiState 订阅 ----

  const offBoot =
    typeof api?.uiState?.subscribe === 'function'
      ? api.uiState.subscribe('boot_mode', (value) => {
          if (value === 'onboarding') openOnboarding()
          else if (state.mode === 'onboarding') closeOverlay()
        })
      : () => {}
  const offSettings =
    typeof api?.uiState?.subscribe === 'function'
      ? api.uiState.subscribe('settings_open', (value) => {
          if (value === true) void openSettings()
          else if (state.mode === 'settings') closeOverlay()
        })
      : () => {}

  const initialBoot = typeof api?.uiState?.get === 'function' ? api.uiState.get('boot_mode') : undefined
  if (initialBoot === 'onboarding') openOnboarding()
  const initialSettings = typeof api?.uiState?.get === 'function' ? api.uiState.get('settings_open') : undefined
  if (initialSettings === true && state.mode === 'closed') void openSettings()

  // ---- 通知全局事件 + 本插件 SSE ----

  const onNotifyState = (event) => handleNotifyState(ctx, event)
  const notifyView = doc.defaultView
  if (notifyView !== null && notifyView !== undefined && typeof notifyView.addEventListener === 'function') {
    notifyView.addEventListener('chrono-notify:state', onNotifyState)
  }
  const closeEvents = connectEvents(ctx)

  return {
    unmount() {
      disposed = true
      offBoot()
      offSettings()
      closeEvents()
      clearLoadingNote()
      setBackgroundHidden(false)
      if (notifyView !== null && notifyView !== undefined && typeof notifyView.removeEventListener === 'function') {
        notifyView.removeEventListener('chrono-notify:state', onNotifyState)
      }
      doc.removeEventListener('keydown', onKeydown)
      root.replaceChildren()
    },
  }
}
