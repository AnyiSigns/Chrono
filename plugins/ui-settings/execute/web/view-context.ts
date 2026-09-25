// 视图上下文：把壳 api + 本插件状态 / 动作装配成一个 React-free `vc`。
// React 组件只读 `vc.state` 并调用 `vc.*`；动作模块（provider-actions / memory-actions / ...）共用同一 vc。
// 原 `entry.js` 的编排（开合 / 订阅 / 渲染调度）整体搬到这里，DOM 构建层改由 React 组件承担。

import {
  configWriteCommand,
  emptyConfig,
  exportJson,
  identityBody,
  isCodeGenFallbackBody,
  isRecord,
  skillWriteCommand,
  slotWriteCommand,
  validateImport,
} from './config-model.ts'
import { applyTemplate, chooseEntry, defaultOnboarding } from './onboarding.ts'
import { FALLBACK_MESSAGES, formatText, loadMessages, messageText } from './messages.ts'
import { HEALTH_OK, healthView } from './health.ts'
import { loadHealth, loadOrchestration, loadTab, loadVendors, loadMemoryView } from './data-load.ts'
import { commitProvider, commitProviderEdit, fetchModels, saveProviderSecret } from './provider-actions.ts'
import { doMemoryEdit, doMemorySearch } from './memory-actions.ts'
import { handleNotifyState, loadNotify, requestPermission } from './notify-actions.ts'
import { currentThemePref, setTheme } from './theme-actions.ts'
import { connectEvents } from './sse.ts'
import { ensureStyles } from './styles.ts'
import { createStore } from './store.ts'

const THREAD_KEY = '_main'

/** 初始状态（与旧入口一致）。 */
export function initialState(): any {
  return {
    mode: 'closed',
    tab: 'general',
    config: null,
    identities: null,
    vendors: null,
    secrets: {},
    notify: null,
    permission: 'unknown',
    loading: false,
    loadingCount: 0,
    loadingNote: false,
    error: null,
    loadError: null,
    savedKey: null,
    pendingRemove: null,
    providerForm: null,
    editingProvider: null,
    skillProjection: null,
    skillForm: null,
    skillConfirmDelete: null,
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
      searchSeq: 0,
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
    liveText: '',
  }
}

/** 建视图上下文；返回 `{ vc, dispose }`。 */
export function createViewContext(api: any): { vc: any; dispose: () => void } {
  const doc = typeof document === 'undefined' ? null : document
  if (doc !== null) ensureStyles(doc)
  const store = createStore()
  const state = initialState()
  let table: any = FALLBACK_MESSAGES
  let loadingTimer: any = null
  /** 最近一次 `config.read` 读到的 active；写 config 时作 `expect_active`。 */
  let configActive: string | null | undefined = undefined
  const offs: (() => void)[] = []
  let disposed = false
  let announceTimer: any = null

  const vc: any = {
    api,
    doc,
    store,
    state,
    threadKey: THREAD_KEY,
    get configActive(): string | null | undefined {
      return configActive
    },
    set configActive(value: string | null | undefined) {
      configActive = value
    },
    text: (code: string, vars?: any) => (vars === undefined ? messageText(table, code) : formatText(table, code, vars)),
    render: () => store.commit(),
    announce: (message: string) => {
      state.liveText = ''
      store.commit()
      if (announceTimer !== null) clearTimeout(announceTimer)
      announceTimer = setTimeout(() => {
        announceTimer = null
        if (disposed) return
        state.liveText = message
        store.commit()
      }, 0)
    },
    defaultOnboarding,
    applyTemplate,
    chooseEntry,
  }

  // ---- 入站能力（经壳 api 按名路由；密钥经本插件只读命令代理） ----

  async function postJson(path: string, body: any): Promise<any> {
    try {
      if (path === 'api/command') {
        return await api.command(body.name, body.args ?? null, body.thread ? { thread: body.thread } : undefined)
      }
      if (path === 'api/submit') {
        return await api.submit(body.directives ?? body.directive, body.thread ? { thread: body.thread } : undefined)
      }
      if (path === 'api/secrets/put' || path === 'api/secrets/delete') {
        const args =
          path === 'api/secrets/put'
            ? { op: 'put', name: body.name, value: body.value }
            : { op: 'delete', name: body.name }
        const result = await api.command('ui-settings.secret', args)
        if (!result.ok) return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown' }
        const value = result.value
        if (isRecord(value) && value.ok === false) {
          return { ok: false, code: typeof value.code === 'string' ? value.code : 'settings_secret_failed' }
        }
        return { ok: true }
      }
      return { ok: false, code: 'unknown', message: `unknown path ${path}` }
    } catch (err: any) {
      return { ok: false, code: 'ui_unreachable', message: String(err && err.message ? err.message : err) }
    }
  }

  async function runCommand(name: string, args: any): Promise<any> {
    const result = await postJson('api/command', { name, args: args ?? null })
    if (result.ok !== true) {
      return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown', value: null, refused: false }
    }
    const refused = result.status === 'refused' || result.value === null
    return { ok: !refused, code: refused ? 'not_loaded' : '', value: result.value, refused }
  }

  async function applyWrite(directive: any, threadKey: string = THREAD_KEY): Promise<any> {
    const result = await postJson('api/submit', { directives: [directive], thread: threadKey })
    if (result.ok !== true) return { ok: false, code: typeof result.code === 'string' ? result.code : 'unknown' }
    if (result.status === 'refused') return { ok: false, code: 'bad_directive' }
    return { ok: true }
  }

  /** 槽写：`input.write` 命令（输入槽已出世界，服务按线程键写自有持久存储）。 */
  async function writeSlot(slot: any, threadKey: string = THREAD_KEY): Promise<any> {
    const built = slotWriteCommand(threadKey, slot)
    return runCommand(built.name, built.args)
  }

  /** config 写：`config.write` 命令（整份 body 交 owner 服务读-改-写自有存储）。 */
  async function writeConfig(body: any, key?: string | null): Promise<any> {
    // 拒 tree 基：绝不把代码世代回落 body 当配置数据写回。
    if (isCodeGenFallbackBody(body)) return { ok: false, code: 'not_loaded' }
    const built = configWriteCommand(body)
    const result = await runCommand(built.name, built.args)
    if (result.ok) {
      state.config = body
      state.savedKey = key ?? null
      vc.announce(vc.text('settings_saved'))
    }
    return result
  }

  async function writeSkillBody(body: any, key?: string | null): Promise<boolean> {
    const built = skillWriteCommand(body)
    const result = await runCommand(built.name, built.args)
    if (result.ok) {
      state.skillProjection = { body, refs: {}, active: null, gens: [] }
      state.savedKey = key ?? null
      state.error = null
    } else {
      state.error = { code: result.code, message: '' }
    }
    vc.render()
    return result.ok
  }

  function armLoadingNote(onNote: () => void): void {
    clearLoadingNote()
    loadingTimer = setTimeout(() => {
      loadingTimer = null
      onNote()
    }, 8000)
  }

  function clearLoadingNote(): void {
    if (loadingTimer !== null) clearTimeout(loadingTimer)
    loadingTimer = null
  }

  // ---- 编排回滚（入站面直接提交 set_active，二次确认） ----

  async function doRollback(): Promise<void> {
    const target = healthView(state.orch.health).rollback
    if (target === null) return
    state.rollbackBusy = true
    state.rollbackNote = null
    vc.render()
    try {
      const result = await applyWrite(
        { kind: 'write', request: { op: 'set_active', args: { id: 'loop-policy', active: target.payload } } },
        THREAD_KEY,
      )
      // 回灌缺失时无法逐字节验证：只显「回滚未验证」，不显成功。
      state.rollbackNote = result.ok
        ? { tone: 'muted', text: vc.text('settings_orch_rollback_unverified') }
        : { tone: 'danger', text: vc.text('settings_orch_rollback_failed') }
    } finally {
      state.rollbackBusy = false
      vc.render()
      void loadOrchestration(vc)
    }
  }

  /** 回滚两步走：首次调用只进入确认态，再次调用才真正执行。 */
  function requestRollback(): void {
    if (!state.rollbackConfirm) {
      state.rollbackConfirm = true
      vc.render()
      return
    }
    state.rollbackConfirm = false
    void doRollback()
  }

  // ---- 开合 ----

  async function openSettings(): Promise<void> {
    state.mode = 'settings'
    state.error = null
    state.loadError = null
    vc.render()
    void loadHealth(vc)
    await loadTab(vc, state.tab)
    vc.render()
  }

  function openOnboarding(): void {
    if (state.mode === 'onboarding') return
    state.mode = 'onboarding'
    state.onboarding = defaultOnboarding()
    vc.render()
    void (async () => {
      const templates = await loadVendors(vc)
      const form = state.onboarding
      if (form === null) return
      form.templates = templates
      vc.render()
    })()
  }

  function closeOverlay(): void {
    state.mode = 'closed'
    vc.render()
  }

  // ---- 配置导入 / 导出 ----

  function exportConfig(): void {
    if (doc === null) return
    const body = state.config ?? emptyConfig()
    const view = doc.defaultView
    if (view === null || view === undefined) return
    const blob = new view.Blob([exportJson(body)], { type: 'application/json' })
    const url = view.URL.createObjectURL(blob)
    const anchor = doc.createElement('a')
    anchor.href = url
    anchor.download = 'chrono-config.json'
    doc.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    view.URL.revokeObjectURL(url)
  }

  async function importConfig(file: any): Promise<void> {
    let content: string
    try {
      content = await file.text()
    } catch {
      state.error = { code: 'settings_import_bad_json', message: '' }
      vc.render()
      return
    }
    const checked = validateImport(content)
    if (!checked.ok) {
      state.error = { code: checked.code, message: '' }
      vc.render()
      return
    }
    const result = await writeConfig(checked.body, 'import')
    state.error = result.ok ? null : { code: result.code, message: '' }
    vc.render()
  }

  // ---- 装配动作 ----

  Object.assign(vc, {
    postJson,
    runCommand,
    applyWrite,
    writeSlot,
    writeConfig,
    writeSkillBody,
    armLoadingNote,
    clearLoadingNote,
    doRollback,
    requestRollback,
    closeOverlay,
    exportConfig,
    importConfig,
    markSaved: (key?: string | null) => {
      state.savedKey = key ?? null
    },
    updateHealthDot: () => store.commit(),
    currentThemePref: () => currentThemePref(vc),
    setTheme: (card: string) => setTheme(vc, card),
    commitProvider: (form: any, options: any) => commitProvider(vc, form, options),
    commitProviderEdit: (form: any, key: string) => commitProviderEdit(vc, form, key),
    saveProviderSecret: (name: any, value: any, key: any) => saveProviderSecret(vc, name, value, key),
    fetchModels: (form: any) => fetchModels(vc, form),
    loadTab: (tab: string) => loadTab(vc, tab),
    loadHealth: () => loadHealth(vc),
    loadVendors: () => loadVendors(vc),
    loadMemoryView: () => loadMemoryView(vc),
    doMemorySearch: () => doMemorySearch(vc),
    doMemoryEdit: (action: string, layer: string, id: string, patch: any) => doMemoryEdit(vc, action, layer, id, patch),
    requestPermission: () => requestPermission(vc),
  })

  // ---- 文案表（异步拉共享表，失败保留兜底） ----

  void loadMessages(fetch, api.tokens?.messages ?? '/assets/messages.v1.json').then((loaded: any) => {
    if (disposed) return
    if (loaded !== null) {
      table = loaded
      store.commit()
    }
  })

  // ---- uiState 订阅 ----

  const uiState = api.uiState
  if (uiState && typeof uiState.subscribe === 'function') {
    offs.push(
      uiState.subscribe('boot_mode', (value: any) => {
        if (value === 'onboarding') openOnboarding()
        else if (state.mode === 'onboarding') closeOverlay()
      }),
    )
    offs.push(
      uiState.subscribe('settings_open', (value: any) => {
        if (value === true) void openSettings()
        else if (state.mode === 'settings') closeOverlay()
      }),
    )
  }
  const initialBoot = uiState && typeof uiState.get === 'function' ? uiState.get('boot_mode') : undefined
  if (initialBoot === 'onboarding') openOnboarding()
  const initialSettings = uiState && typeof uiState.get === 'function' ? uiState.get('settings_open') : undefined
  if (initialSettings === true && state.mode === 'closed') void openSettings()

  // ---- 通知全局事件 + 本插件事件订阅 ----

  const onNotifyState = (event: any) => handleNotifyState(vc, event)
  const view = doc === null ? null : doc.defaultView
  if (view !== null && view !== undefined && typeof view.addEventListener === 'function') {
    view.addEventListener('chrono-notify:state', onNotifyState)
    offs.push(() => view.removeEventListener('chrono-notify:state', onNotifyState))
  }
  offs.push(connectEvents(api, vc))

  return {
    vc,
    dispose: () => {
      disposed = true
      if (announceTimer !== null) clearTimeout(announceTimer)
      announceTimer = null
      clearLoadingNote()
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch {
          // 退订失败不影响其余
        }
      }
    },
  }
}

export { HEALTH_OK }
