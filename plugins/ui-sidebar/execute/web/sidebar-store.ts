// 侧栏业务状态（React-free store）：唯一真源，`{getSnapshot, subscribe, commit}` 供壳 `ctx.useStore` 绑定。
// 组件只渲染快照、只调本 store 的动作；读面 = 入站命令 `chat.history`，写与命令一律经壳 api。
// 零 react import（可 grep 断言）；DOM 只出现在浮层测量 / 下载等动作里，不构建视图。

import type { SlotContext } from '@chrono/ui-contract'
import { applyEvent, clearUnread, createBadgeState, seedFromHistory } from './badges.ts'
import type { BadgeState } from './badges.ts'
import { beginConfirm, clearConfirm, CONFIRM_MS, createConfirmState, isConfirming } from './confirm.ts'
import type { ConfirmState } from './confirm.ts'
import { exportBody, exportFilename, messagesOf } from './export.ts'
import { formatText, messageText } from './messages.ts'
import type { MessageTable } from './messages.ts'
import {
  isRecord,
  identityActive,
  identityBody,
  identityDataGen,
  identityWriteDirective,
  isCodeGenFallbackBody,
  normalizeConversations,
  normalizeWorkspaces,
} from './sidebar-model.ts'
import type { Conversation, Workspace } from './sidebar-model.ts'
import {
  canResize,
  clampWidth,
  effectiveWidth,
  resolveCollapsed,
  widthFromDrag,
  WIDTH_COLLAPSED,
  WIDTH_EXPANDED,
  WRITE_DEBOUNCE_MS,
} from './width.ts'

const THREAD = '_main'
const TOOLTIP_DELAY_MS = 400
const FLYOUT_OPEN_MS = 150
const FLYOUT_CLOSE_MS = 300
/** 浮窗顶边相对窄栏顶边的下移量。 */
const FLYOUT_TOP_OFFSET = 8
/** 浮窗最大高度（超出由浮窗内部滚动）。 */
const FLYOUT_MAX_HEIGHT = 420
/** 浮窗最小高度下限（视口极小时兜底）。 */
const FLYOUT_MIN_HEIGHT = 120
/** 浮窗设计宽度 / 最小宽度（视口过窄时收窄，不横向溢出）。 */
const FLYOUT_WIDTH = 260
const FLYOUT_MIN_WIDTH = 160
/** 浮窗与窄栏 / 视口边缘的间隙。 */
const FLYOUT_GAP = 8
const RELOAD_DEBOUNCE_MS = 150
const STATUS_CLEAR_MS = 4000

export interface MenuItem {
  icon: string
  label: string
  danger?: boolean
  disabled?: boolean
  run: () => void
}

export interface MenuState {
  items: MenuItem[]
  anchor: HTMLElement | null
}

export interface TooltipState {
  label: string
  left: number
  top: number
}

export interface FlyoutState {
  left: number
  top: number
  maxHeight: number
  maxWidth: number
}

export interface SidebarSnapshot {
  messages: MessageTable
  icons: string
  workspaces: Workspace[]
  conversations: Conversation[]
  history: unknown
  query: string
  userCollapsed: boolean
  collapsed: boolean
  wide: boolean
  width: number
  storedWidth: number
  dragging: boolean
  collapsedGroups: Set<string>
  badges: BadgeState
  confirm: ConfirmState
  editing: string | null
  pickerBusy: boolean
  loading: boolean
  error: string | null
  status: string | null
  connected: boolean
  menu: MenuState | null
  tooltip: TooltipState | null
  flyout: FlyoutState
  flyoutOpen: boolean
}

interface CommandResult {
  ok: boolean
  value?: any
  code?: string
  message?: string
}

/** 写回包是否落账：`ok:true` 且非 `refused`（未就绪 / 拒写回 `{ok:false}`）。 */
function isWriteAccepted(result: unknown): boolean {
  return isRecord(result) && result['ok'] === true && result['status'] !== 'refused'
}

/** 侧栏 store：状态归约 + 命令编排 + 浮层定位。 */
export class SidebarStore {
  private readonly ctx: SlotContext
  private readonly listeners = new Set<(snapshot: SidebarSnapshot) => void>()
  private snapshot: SidebarSnapshot
  private root: HTMLElement | null = null
  private drag: { startX: number; startWidth: number } | null = null
  private dragWidth = 0
  private tooltipTimer: ReturnType<typeof setTimeout> | null = null
  private flyoutTimer: ReturnType<typeof setTimeout> | null = null
  /** 指针是否仍在浮窗簇（窄栏项 + 浮窗 + 子菜单）内；菜单关闭后据此判定父窗去留。 */
  private flyoutHover = false
  /** 焦点是否仍在浮窗簇内；键盘用户不因鼠标移出而被收起。 */
  private flyoutFocused = false
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private confirmTimer: ReturnType<typeof setTimeout> | null = null
  private widthTimer: ReturnType<typeof setTimeout> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private closeEvents: (() => void) | null = null
  private disposed = false
  private started = false
  /** 本地已读会话：选中即记；历史补种时不复活其未读角标。 */
  private readonly locallyRead = new Set<string>()
  /** 当前 tooltip 锚点元素：滚动 / 缩放时据此重算位置。 */
  private tooltipAnchor: HTMLElement | null = null
  /** 读面请求序号：并发 loadAll / loadHistory 时旧回包不覆盖新结果。 */
  private loadSeq = 0
  private historySeq = 0
  /** 会话切换序号：并发 selectSession 时旧回包不抢先改状态。 */
  private selectSeq = 0

  constructor(ctx: SlotContext, messages: MessageTable) {
    this.ctx = ctx
    this.snapshot = {
      messages,
      icons: ctx.tokens.icons,
      workspaces: [],
      conversations: [],
      history: null,
      query: '',
      userCollapsed: false,
      collapsed: false,
      wide: true,
      width: WIDTH_EXPANDED,
      storedWidth: WIDTH_EXPANDED,
      dragging: false,
      collapsedGroups: new Set(),
      badges: createBadgeState(),
      confirm: createConfirmState(),
      editing: null,
      pickerBusy: false,
      loading: true,
      error: null,
      status: null,
      connected: typeof ctx.events?.connected === 'function' ? ctx.events.connected() : false,
      menu: null,
      tooltip: null,
      flyout: { left: 0, top: 0, maxHeight: 0, maxWidth: FLYOUT_WIDTH },
      flyoutOpen: false,
    }
  }

  getSnapshot = (): SidebarSnapshot => this.snapshot

  subscribe = (listener: (snapshot: SidebarSnapshot) => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  text(code: string): string {
    return messageText(this.snapshot.messages, code)
  }

  fmt(code: string, vars: Record<string, unknown>): string {
    return formatText(this.snapshot.messages, code, vars)
  }

  /** 契约形状：整体替换快照并通知订阅者（`commit(next, meta?)`）。 */
  commit(next: SidebarSnapshot, _meta?: unknown): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener(this.snapshot)
  }

  private update(patch: Partial<SidebarSnapshot>): void {
    this.commit({ ...this.snapshot, ...patch })
  }

  // ---- 生命周期 ----

  attachRoot(element: HTMLElement | null): void {
    this.root = element
  }

  /** 启动（可重复：错误边界卸载后重挂会再次调用，`dispose` 不是终态）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.disposed = false
    this.applyViewport()
    this.closeEvents =
      typeof this.ctx.events?.onAny === 'function' ? this.ctx.events.onAny((record) => this.handleRecord(record)) : null
    window.addEventListener('resize', this.onResize)
    window.addEventListener('scroll', this.onScroll, true)
    document.addEventListener('click', this.onDocumentClick)
    document.addEventListener('keydown', this.onKeyDown)
    void this.loadAll()
  }

  dispose(): void {
    this.started = false
    this.disposed = true
    if (this.closeEvents !== null) {
      this.closeEvents()
      this.closeEvents = null
    }
    for (const timer of [
      this.tooltipTimer,
      this.flyoutTimer,
      this.reloadTimer,
      this.confirmTimer,
      this.widthTimer,
      this.statusTimer,
    ]) {
      if (timer !== null) clearTimeout(timer)
    }
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('scroll', this.onScroll, true)
    document.removeEventListener('click', this.onDocumentClick)
    document.removeEventListener('keydown', this.onKeyDown)
  }

  private onResize = (): void => {
    this.applyViewport()
    this.positionTooltip()
  }

  /** 滚动（捕获，含 `.sb-list` 内部滚动）：浮窗 / tooltip 贴回锚点；子菜单由组件自重算。 */
  private onScroll = (): void => {
    this.positionFlyout()
    this.positionTooltip()
  }

  private onDocumentClick = (): void => this.closeMenu()

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closeMenuAndRestoreFocus()
  }

  // ---- 命令面 ----

  private async command(name: string, args: unknown): Promise<CommandResult> {
    const result: any = await this.ctx.command(name, (args ?? null) as any, { thread: THREAD })
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      return {
        ok: false,
        code: typeof result?.code === 'string' ? result.code : 'ui_unreachable',
        message: typeof result?.message === 'string' ? result.message : '',
      }
    }
    return { ok: true, value: result.value }
  }

  private async writeSlot(slot: any): Promise<unknown> {
    const read = await this.command('input.read', { thread: THREAD })
    if (!read.ok) return { ok: false, code: 'not_loaded' }
    const body = identityBody(read.value)
    // 读到代码世代回落 body（无数据世代）→ 未就绪，拒写以免污染身份。
    if (!isRecord(body) || isCodeGenFallbackBody(body)) return { ok: false, code: 'not_loaded' }
    const slots = isRecord(body['slots']) ? { ...body['slots'], [THREAD]: slot } : { [THREAD]: slot }
    const directive = identityWriteDirective('input', body, { ...body, slots }, identityActive(read.value), identityDataGen(read.value))
    return this.ctx.submit([directive] as any, { thread: THREAD })
  }

  private async loadWorkspaces(): Promise<boolean> {
    const seq = this.loadSeq
    const result = await this.command('workspace.list', null)
    // 并发 loadAll：旧回包不覆盖新一轮已落的状态。
    if (seq !== this.loadSeq) return true
    if (!result.ok) return false
    this.update({ workspaces: normalizeWorkspaces(result.value) })
    return true
  }

  private async loadHistory(): Promise<boolean> {
    const seq = (this.historySeq += 1)
    const result = await this.command('chat.history', {})
    if (seq !== this.historySeq) return true
    if (!result.ok) return false
    const history = result.value
    const conversations = normalizeConversations(isRecord(history) ? history['body'] : null)
    this.update({
      history,
      conversations,
      badges: seedFromHistory(this.snapshot.badges, conversations, this.locallyRead),
    })
    return true
  }

  private async loadStoredWidth(): Promise<void> {
    const seq = this.loadSeq
    const result = await this.command('config.read', null)
    // 并发 loadAll：旧回包不覆盖新一轮已落的状态。
    if (seq !== this.loadSeq) return
    if (!result.ok) return
    const config = identityBody(result.value)
    if (!isRecord(config) || isCodeGenFallbackBody(config)) return
    const ui = isRecord(config['ui']) ? config['ui'] : null
    if (ui !== null && typeof ui['sidebar_width'] === 'number') {
      this.update({ storedWidth: clampWidth(ui['sidebar_width']) })
    }
  }

  async loadAll(): Promise<void> {
    if (this.disposed) return
    const seq = (this.loadSeq += 1)
    this.update({ loading: true, error: null })
    const [workspacesOk, historyOk] = await Promise.all([this.loadWorkspaces(), this.loadHistory(), this.loadStoredWidth()])
    if (this.disposed || seq !== this.loadSeq) return
    this.update({ loading: false, error: !workspacesOk || !historyOk ? this.text('sidebar_dependency_missing') : null })
    this.applyViewport()
  }

  private scheduleReload(): void {
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      void this.loadHistory()
    }, RELOAD_DEBOUNCE_MS)
  }

  private handleRecord(record: unknown): void {
    if (!isRecord(record)) return
    const payload = isRecord(record['payload']) ? record['payload'] : {}
    if (record['topic'] === 'shell.state') {
      this.update({ connected: payload['connected'] === true })
      return
    }
    const badges = applyEvent(this.snapshot.badges, record['impl'], record['topic'], payload)
    if (
      record['topic'] === 'thread.updated' ||
      record['topic'] === 'thread.opened' ||
      record['topic'] === 'thread.closed' ||
      record['topic'] === 'run.finished'
    ) {
      this.scheduleReload()
    }
    // `applyEvent` 无实际变更时回传入参引用，据此判变更（不再整体 JSON 序列化）。
    if (badges !== this.snapshot.badges) this.update({ badges })
  }

  // ---- 视图 ----

  currentId(): string | null {
    const history = this.snapshot.history
    const body = isRecord(history) && isRecord(history['body']) ? history['body'] : null
    return body !== null && typeof body['current'] === 'string' ? body['current'] : null
  }

  confirming(key: string): boolean {
    return isConfirming(this.snapshot.confirm, key, Date.now())
  }

  private applyViewport(): void {
    if (this.disposed) return
    const viewport = window.innerWidth
    const collapsed = resolveCollapsed(viewport, this.snapshot.userCollapsed)
    const wide = canResize(viewport)
    const width = wide ? effectiveWidth(viewport, this.snapshot.storedWidth, collapsed) : WIDTH_COLLAPSED
    this.update({ collapsed, wide, width })
    if (collapsed) this.hideFlyout()
  }

  setQuery(query: string): void {
    this.update({ query })
  }

  clearQuery(): void {
    this.update({ query: '' })
  }

  toggleCollapsed(): void {
    this.update({ userCollapsed: !this.snapshot.userCollapsed })
    this.applyViewport()
  }

  toggleGroup(id: string): void {
    const next = new Set(this.snapshot.collapsedGroups)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    this.update({ collapsedGroups: next })
  }

  setStatus(message: string | null): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer)
    if (message !== null) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null
        this.update({ status: null })
      }, STATUS_CLEAR_MS)
    }
    this.update({ status: message })
  }

  // ---- 会话 / 工作区动作 ----

  /**
   * 选中会话。`keepFlyout` 为真（窄栏浮窗内的行）时不收起浮窗：
   * 双击重命名需行存活到第二次点击；浮窗随鼠标移出 / 焦点离开自然收起。
   */
  async selectSession(id: string, keepFlyout = false): Promise<void> {
    const seq = (this.selectSeq += 1)
    this.locallyRead.add(id)
    this.update({ confirm: clearConfirm(), badges: clearUnread(this.snapshot.badges, id) })
    if (!keepFlyout) this.closeFlyout()
    const wrote = await this.writeSlot({ kind: 'session.select', conversation: id })
    if (this.disposed || seq !== this.selectSeq) return
    // 写未落账（身份未就绪 / 被拒）时不再发切换命令，避免切到旧槽或空槽。
    if (!isWriteAccepted(wrote)) {
      this.setStatus(this.text('sidebar_dependency_missing'))
      return
    }
    await this.command('session.select', null)
    if (this.disposed || seq !== this.selectSeq) return
    await this.loadHistory()
  }

  async newConversation(workspaceId: string): Promise<void> {
    await this.writeSlot({ kind: 'session.new', workspace_id: workspaceId })
    await this.command('session.new', null)
    await this.loadHistory()
  }

  startRename(session: Conversation): void {
    this.update({ editing: session.id, confirm: clearConfirm() })
  }

  cancelRename(): void {
    this.update({ editing: null })
    this.releaseFlyoutIfIdle()
  }

  async commitRename(session: Conversation, value: unknown): Promise<void> {
    if (this.snapshot.editing !== session.id) return
    this.update({ editing: null })
    this.releaseFlyoutIfIdle()
    const title = typeof value === 'string' ? value.trim() : ''
    if (title.length === 0 || title === session.title) return
    await this.writeSlot({ kind: 'session.rename', conversation: session.id, title })
    await this.command('session.rename', null)
    await this.loadHistory()
  }

  requestTerminate(session: Conversation): void {
    this.update({ confirm: beginConfirm(this.snapshot.confirm, `terminate:${session.id}`, Date.now()) })
    this.scheduleConfirmRefresh()
  }

  confirmDelete(session: Conversation): void {
    this.update({ confirm: beginConfirm(this.snapshot.confirm, `delete:${session.id}`, Date.now()) })
    this.scheduleConfirmRefresh()
  }

  cancelConfirm(): void {
    this.update({ confirm: clearConfirm() })
    this.releaseFlyoutIfIdle()
  }

  private scheduleConfirmRefresh(): void {
    if (this.confirmTimer !== null) clearTimeout(this.confirmTimer)
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null
      if (this.snapshot.confirm.key !== null) {
        this.update({ confirm: clearConfirm() })
        this.releaseFlyoutIfIdle()
      }
    }, CONFIRM_MS + 50)
  }

  /** 就地编辑 / 确认结束后，指针与焦点均已不在浮窗簇内则收起浮窗（避免保活残留）。 */
  private releaseFlyoutIfIdle(): void {
    if (!this.flyoutHover && !this.flyoutFocused) this.hideFlyout()
  }

  async doTerminate(run: string): Promise<void> {
    this.update({ confirm: clearConfirm() })
    this.releaseFlyoutIfIdle()
    if (typeof this.ctx.cancel === 'function') {
      await this.ctx.cancel(run)
      return
    }
  }

  async doDelete(session: Conversation): Promise<void> {
    this.update({ confirm: clearConfirm() })
    this.releaseFlyoutIfIdle()
    await this.writeSlot({ kind: 'session.delete', conversation: session.id })
    await this.command('session.delete', null)
    await this.loadHistory()
    this.ctx.toast({
      tone: 'info',
      text: this.text('sidebar_deleted'),
      action: { label: this.text('sidebar_undo'), run: () => void this.restoreSession(session.id) },
    })
  }

  async restoreSession(id: string): Promise<void> {
    await this.writeSlot({ kind: 'session.restore', conversation: id })
    await this.command('session.restore', null)
    await this.loadHistory()
  }

  async removeWorkspace(id: string): Promise<void> {
    await this.writeSlot({ kind: 'workspace.remove', workspace: id })
    await this.command('workspace.remove', null)
    await this.loadAll()
  }

  async revealWorkspace(id: string): Promise<void> {
    const workspaces = this.snapshot.workspaces.map((item) => ({ id: item.id, path: item.path }))
    const result = await this.command('workspace.reveal', { workspace: id, workspaces })
    if (!result.ok) {
      this.setStatus(result.message !== undefined && result.message.length > 0 ? result.message : result.code ?? '')
    } else if (isRecord(result.value) && result.value['ok'] === false && isRecord(result.value['error'])) {
      const error = result.value['error']
      this.setStatus(String(error['message'] ?? error['code'] ?? ''))
    }
  }

  async addWorkspace(): Promise<void> {
    if (this.snapshot.pickerBusy) return
    this.update({ pickerBusy: true })
    const picked = await this.command('workspace.pick', null)
    this.update({ pickerBusy: false })
    if (!picked.ok) {
      this.setStatus(picked.code === 'picker_unavailable' ? this.text('sidebar_picker_unavailable') : picked.message ?? '')
      return
    }
    const value = isRecord(picked.value) ? picked.value : null
    if (value !== null && value['cancelled'] === true) return
    const path = value !== null && typeof value['path'] === 'string' && value['path'].length > 0 ? value['path'] : null
    if (path === null) {
      this.setStatus(this.text('sidebar_picker_unavailable'))
      return
    }
    const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await this.writeSlot({ kind: 'workspace.add', workspace: id, path })
    await this.command('workspace.add', null)
    await this.loadAll()
  }

  async branchSession(session: Conversation): Promise<void> {
    const message = session.head
    if (message === null) {
      this.setStatus(this.text('sidebar_dependency_missing'))
      return
    }
    await this.writeSlot({ kind: 'session.branch', conversation: session.id, message })
    await this.command('session.branch', null)
    await this.loadAll()
  }

  async exportSession(session: Conversation, format: string): Promise<void> {
    const history = this.snapshot.history
    if (history === null) return
    const messages = messagesOf(history, session.id)
    const body = exportBody(format, session, messages)
    const filename = exportFilename(session, format === 'json' ? 'json' : 'md')
    try {
      if (typeof URL.createObjectURL !== 'function') throw new Error('download unsupported')
      const blob = new Blob([body], { type: format === 'json' ? 'application/json' : 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // 下载启动前不能撤 URL：放到下一个宏任务再撤，避免部分浏览器下载被中断。
      setTimeout(() => URL.revokeObjectURL(url), 0)
      this.ctx.toast({ tone: 'success', text: this.text('sidebar_exported') })
    } catch {
      this.ctx.toast({ tone: 'danger', text: this.text('sidebar_export_failed') })
    }
  }

  openSettings(): void {
    if (this.ctx.uiState !== undefined && typeof this.ctx.uiState.set === 'function') {
      this.ctx.uiState.set('settings_open', true)
    }
  }

  // ---- 弹层 ----

  openMenu(anchor: HTMLElement | null, items: MenuItem[]): void {
    // 菜单由浮窗内按钮开出：取消在途的浮窗收起，父窗随子菜单保活（子不先于父消失）。
    if (this.flyoutTimer !== null) {
      clearTimeout(this.flyoutTimer)
      this.flyoutTimer = null
    }
    this.update({ menu: { items, anchor } })
  }

  closeMenu(): void {
    if (this.snapshot.menu === null) return
    this.update({ menu: null })
    // 子菜单关闭后重新判定父浮窗：指针 / 焦点均已不在浮窗簇内则一并收起。
    if (!this.flyoutHover && !this.flyoutFocused) this.hideFlyout()
  }

  closeMenuAndRestoreFocus(): void {
    const anchor = this.snapshot.menu?.anchor ?? null
    this.closeMenu()
    if (anchor !== null && typeof anchor.focus === 'function' && document.contains(anchor)) anchor.focus()
  }

  openWorkspaceMenu(anchor: HTMLElement | null, workspace: Workspace): void {
    this.openMenu(anchor, [
      { icon: 'folder-open', label: this.text('sidebar_open_in_explorer'), run: () => void this.revealWorkspace(workspace.id) },
      { icon: 'trash-2', label: this.text('sidebar_remove_workspace'), danger: true, run: () => void this.removeWorkspace(workspace.id) },
    ])
  }

  openSessionMenu(anchor: HTMLElement | null, session: Conversation): void {
    this.openMenu(anchor, [
      { icon: 'pencil-line', label: this.text('sidebar_rename'), run: () => this.startRename(session) },
      { icon: 'download', label: this.text('sidebar_export_md'), run: () => void this.exportSession(session, 'md') },
      { icon: 'download', label: this.text('sidebar_export_json'), run: () => void this.exportSession(session, 'json') },
      {
        icon: 'git-branch',
        label: this.text('sidebar_branch'),
        disabled: session.head === null,
        run: () => void this.branchSession(session),
      },
      { icon: 'trash-2', label: this.text('sidebar_delete'), danger: true, run: () => this.confirmDelete(session) },
    ])
  }

  // ---- 收缩态 flyout ----

  openFlyout(): void {
    if (!this.snapshot.collapsed) return
    this.flyoutHover = true
    if (this.flyoutTimer !== null) clearTimeout(this.flyoutTimer)
    this.flyoutTimer = setTimeout(() => {
      this.flyoutTimer = null
      this.showFlyout()
    }, FLYOUT_OPEN_MS)
  }

  /** 浮窗簇内取得焦点：与悬浮同样保活，键盘用户不被收起。 */
  focusFlyout(): void {
    if (!this.snapshot.collapsed) return
    this.flyoutFocused = true
    if (this.flyoutTimer !== null) {
      clearTimeout(this.flyoutTimer)
      this.flyoutTimer = null
    }
    if (!this.snapshot.flyoutOpen) this.showFlyout()
  }

  /** 焦点离开浮窗簇（`relatedTarget` 不在簇内时由组件调用）。 */
  blurFlyout(): void {
    if (!this.flyoutFocused) return
    this.flyoutFocused = false
    this.hideFlyout()
  }

  /**
   * 浮窗定位：贴窄栏右缘，顶边下移一小段；限高取「视口余量 / 上限」较小者，超出走内部滚动。
   * 宽度按右侧余量收窄并夹取，保证不横向溢出视口。
   */
  private computeFlyout(): FlyoutState {
    const rect = this.root?.getBoundingClientRect()
    if (rect === undefined) return { left: 0, top: 0, maxHeight: 0, maxWidth: FLYOUT_WIDTH }
    const right = Math.round(rect.right)
    const top = Math.round(rect.top) + FLYOUT_TOP_OFFSET
    const maxHeight = Math.max(
      FLYOUT_MIN_HEIGHT,
      Math.min(FLYOUT_MAX_HEIGHT, Math.round(window.innerHeight) - top - FLYOUT_TOP_OFFSET),
    )
    const maxWidth = Math.max(
      FLYOUT_MIN_WIDTH,
      Math.min(FLYOUT_WIDTH, Math.round(window.innerWidth) - right - FLYOUT_GAP),
    )
    const left = Math.max(FLYOUT_GAP, Math.min(right, Math.round(window.innerWidth) - maxWidth - FLYOUT_GAP))
    return { left, top, maxHeight, maxWidth }
  }

  private showFlyout(): void {
    if (!this.snapshot.collapsed || this.disposed) return
    this.update({ flyout: this.computeFlyout(), flyoutOpen: true })
  }

  /** 视口 / 滚动变化时按实时根矩形重算浮窗位置（仅开着的浮窗；位置未变不重提交通知）。 */
  private positionFlyout(): void {
    if (!this.snapshot.flyoutOpen || !this.snapshot.collapsed) return
    const next = this.computeFlyout()
    const current = this.snapshot.flyout
    if (
      next.left === current.left &&
      next.top === current.top &&
      next.maxHeight === current.maxHeight &&
      next.maxWidth === current.maxWidth
    ) {
      return
    }
    this.update({ flyout: next })
  }

  /** 浮窗簇是否仍需保活：子菜单 / 焦点 / 就地编辑 / 二次确认（键盘触发的确认行在浮窗内）。 */
  private flyoutKeepAlive(): boolean {
    return (
      this.snapshot.menu !== null ||
      this.flyoutFocused ||
      this.snapshot.editing !== null ||
      this.snapshot.confirm.key !== null
    )
  }

  hideFlyout(): void {
    this.flyoutHover = false
    if (this.flyoutTimer !== null) clearTimeout(this.flyoutTimer)
    this.flyoutTimer = setTimeout(() => {
      this.flyoutTimer = null
      // 子菜单仍开 / 焦点仍在 / 编辑或确认进行中：父窗不先于交互消失。
      if (this.flyoutKeepAlive()) return
      if (this.snapshot.flyoutOpen) this.update({ flyoutOpen: false })
    }, FLYOUT_CLOSE_MS)
  }

  /** 立即收起浮窗与其子菜单（选中会话等确定性收场，不等延时）。 */
  closeFlyout(): void {
    if (this.flyoutTimer !== null) {
      clearTimeout(this.flyoutTimer)
      this.flyoutTimer = null
    }
    this.flyoutHover = false
    this.flyoutFocused = false
    if (this.snapshot.flyoutOpen || this.snapshot.menu !== null) {
      this.update({ flyoutOpen: false, menu: null })
    }
  }

  // ---- 宽度拖拽 ----

  beginResize(clientX: number): void {
    if (this.snapshot.collapsed || !this.snapshot.wide) return
    const startWidth = effectiveWidth(window.innerWidth, this.snapshot.storedWidth, false)
    this.drag = { startX: clientX, startWidth }
    this.dragWidth = startWidth
    this.update({ dragging: true })
  }

  dragResize(clientX: number): void {
    if (this.drag === null) return
    const width = widthFromDrag(this.drag.startWidth, clientX - this.drag.startX)
    this.dragWidth = width
    this.root?.style.setProperty('--sb-width', `${width}px`)
  }

  endResize(): void {
    if (this.drag === null) return
    this.drag = null
    const width = this.dragWidth
    this.update({ dragging: false, storedWidth: width, width })
    this.scheduleWidthWrite()
  }

  private scheduleWidthWrite(): void {
    if (this.widthTimer !== null) clearTimeout(this.widthTimer)
    this.widthTimer = setTimeout(() => {
      this.widthTimer = null
      void this.persistWidth()
    }, WRITE_DEBOUNCE_MS)
  }

  private async persistWidth(): Promise<void> {
    const result = await this.command('config.read', null)
    if (!result.ok) return
    const config = identityBody(result.value)
    // 读到代码世代回落 body（无数据世代）→ 未就绪，拒写以免污染身份。
    if (!isRecord(config) || isCodeGenFallbackBody(config)) return
    const ui = isRecord(config['ui']) ? { ...config['ui'] } : {}
    ui['sidebar_width'] = clampWidth(this.snapshot.storedWidth)
    const body = { ...config, ui }
    const directive = identityWriteDirective('config', config, body, identityActive(result.value), identityDataGen(result.value))
    await this.ctx.submit([directive] as any)
  }

  // ---- 提示 ----

  showTooltip(label: string, target: HTMLElement | null): void {
    if (typeof label !== 'string' || label.length === 0 || target === null) return
    if (this.tooltipTimer !== null) clearTimeout(this.tooltipTimer)
    this.tooltipTimer = setTimeout(() => {
      this.tooltipTimer = null
      this.tooltipAnchor = target
      const rect = target.getBoundingClientRect()
      this.update({ tooltip: { label, left: Math.round(rect.right + 8), top: Math.round(rect.top) } })
    }, TOOLTIP_DELAY_MS)
  }

  /** 滚动 / 缩放时按实时锚点矩形重算 tooltip 位置（锚点已离树 / 位置未变则不动）。 */
  private positionTooltip(): void {
    const tooltip = this.snapshot.tooltip
    if (tooltip === null) return
    const target = this.tooltipAnchor
    if (target === null || !document.contains(target)) return
    const rect = target.getBoundingClientRect()
    const left = Math.round(rect.right + 8)
    const top = Math.round(rect.top)
    if (tooltip.left === left && tooltip.top === top) return
    this.update({ tooltip: { label: tooltip.label, left, top } })
  }

  hideTooltip(): void {
    if (this.tooltipTimer !== null) clearTimeout(this.tooltipTimer)
    this.tooltipTimer = null
    this.tooltipAnchor = null
    if (this.snapshot.tooltip !== null) this.update({ tooltip: null })
  }
}
