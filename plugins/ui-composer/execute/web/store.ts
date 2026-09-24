// `ui-composer` 业务状态：React-free store（快照 + subscribe），组件经 `ctx.useStore` 绑定。
// 住这里的是配置 / 输入 / 附件 / 待发队列 / 在途回合 / 用量；组件只渲染快照、调动作，不各自 fetch。
// 事件订阅（壳总线，按线程过滤）、uiState（active_thread）、命令 / 提交全部经壳 api。

import type { SlotContext } from '@chrono/ui-contract'
import { createClient } from './client.ts'
import type { IdentityRead, SubmitResult } from './client.ts'
import {
  attachmentKind,
  buildAttachment,
  bytesToBase64,
  guessMime,
  isParseable,
  normalizeRef,
} from './attach.ts'
import type { AssetRef, Attachment } from './attach.ts'
import { formatText, FALLBACK_MESSAGES, loadMessages, messageText } from './messages.ts'
import type { MessageTable } from './messages.ts'
import {
  buildMessageSlot,
  collapseReasoning,
  currentModelOf,
  currentReasoningOf,
  dequeue,
  enqueue,
  enqueueFront,
  isCodeGenFallbackBody,
  isRecord,
  matchesThread,
  mergeConfig,
  normalizePermission,
  queueCount,
  queueOf,
  reasoningOptionsFromConfig,
  removeFromQueue,
  runIdOf,
  runKeyOf,
  threadKeyOf,
} from './model.ts'
import {
  armWrite,
  beginWrite,
  clearExpecting,
  createRunState,
  endWrite,
  expectTurn,
  isThreadBusy,
  releaseWrite,
  trackRunFinished,
  trackRunStarted,
} from './run-model.ts'
import type { RunState } from './run-model.ts'

/** 等槽写 run 落账的上限；超时后仍派发，避免事件丢失把线程卡在「忙」。 */
const WRITE_WAIT_MS = 5000

export type ChipStatus = 'loading' | 'ready' | 'failed'

export interface Chip {
  id: string
  name: string
  mime: string
  kind: string
  status: ChipStatus
  source: AssetRef | null
  text: string | null
  error: string | null
  file: File
}

export interface ReasoningState {
  status: 'hidden' | 'fetching' | 'failed' | 'ready'
  options: string[]
  collapsed: boolean
  value: string | null
  error: string | null
}

export interface ComposerSnapshot {
  table: MessageTable
  activeThread: string | null
  text: string
  attachments: Chip[]
  attachExpanded: boolean
  pending: { [threadKey: string]: unknown }
  usage: { [threadKey: string]: unknown }
  config: unknown
  model: string | null
  reasoning: ReasoningState
  permission: string
  sending: boolean
  error: string | null
  running: boolean
  busy: boolean
  canSend: boolean
  queue: unknown[]
  queueCount: number
}

export interface ComposerStore {
  getSnapshot(): ComposerSnapshot
  subscribe(listener: (snapshot: ComposerSnapshot) => void): () => void
  init(): Promise<void>
  dispose(): void
  t(code: string, vars?: unknown): string
  setText(text: string): void
  addFiles(files: FileList | File[] | null | undefined): Promise<void>
  retryChip(id: string): Promise<void>
  removeChip(id: string): void
  expandAttachments(): void
  removePending(id: string): number
  refreshConfig(): Promise<unknown>
  selectModel(value: string): Promise<void>
  selectReasoning(value: string | null): Promise<void>
  selectPermission(value: string): Promise<void>
  ensureReasoning(): Promise<void>
  send(): Promise<void>
  stop(): Promise<void>
}

function hiddenReasoning(): ReasoningState {
  return { status: 'hidden', options: [], collapsed: false, value: null, error: null }
}

export function createComposerStore(ctx: SlotContext): ComposerStore {
  const client = createClient(ctx)
  const state = {
    table: FALLBACK_MESSAGES as MessageTable,
    activeThread: null as string | null,
    text: '',
    attachments: [] as Chip[],
    attachExpanded: false,
    pending: {} as { [threadKey: string]: unknown },
    usage: {} as { [threadKey: string]: unknown },
    config: null as unknown,
    model: null as string | null,
    reasoning: hiddenReasoning(),
    permission: 'review',
    sending: false,
    error: null as string | null,
  }

  let tracking: RunState = createRunState()
  let disposed = false
  let offEvents: (() => void) | null = null
  let offThread: (() => void) | null = null
  let reasoningSeq = 0
  const writeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<(snapshot: ComposerSnapshot) => void>()

  function buildSnapshot(): ComposerSnapshot {
    const threadKey = threadKeyOf(state.activeThread)
    return {
      table: state.table,
      activeThread: state.activeThread,
      text: state.text,
      attachments: state.attachments,
      attachExpanded: state.attachExpanded,
      pending: state.pending,
      usage: state.usage,
      config: state.config,
      model: state.model,
      reasoning: state.reasoning,
      permission: state.permission,
      sending: state.sending,
      error: state.error,
      running: typeof tracking.runs[threadKey] === 'string',
      busy: isThreadBusy(tracking, threadKey),
      canSend:
        state.text.trim().length > 0 ||
        state.attachments.some((chip) => chip.status === 'ready' && chip.source !== null),
      queue: queueOf(state.pending, threadKey),
      queueCount: queueCount(state.pending, threadKey),
    }
  }

  let snapshot = buildSnapshot()

  function publish(): void {
    snapshot = buildSnapshot()
    for (const listener of [...listeners]) listener(snapshot)
  }

  function t(code: string, vars?: unknown): string {
    return vars === undefined
      ? messageText(state.table, code)
      : formatText(state.table, code, vars)
  }

  function nextId(): string {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function toAttachment(chip: Chip): Attachment {
    const source = chip.source
    if (source === null) throw new Error('bad_asset')
    return buildAttachment({
      name: chip.name,
      mime: chip.mime,
      sha256: source.sha256,
      size: source.size,
      text: chip.text,
    })
  }

  function clearSentInput(sent: Chip[], sentText: string): void {
    // 跨 await 期间用户可能已输入新文本：仅当文本仍等于发送时快照才清空。
    if (state.text === sentText) state.text = ''
    const sentIds = new Set(sent.map((chip) => chip.id))
    state.attachments = state.attachments.filter((chip) => !sentIds.has(chip.id))
  }

  // ---- 附件 ----

  async function uploadChip(chip: Chip): Promise<void> {
    chip.status = 'loading'
    chip.error = null
    publish()
    try {
      const asset = ctx.asset
      if (asset === undefined || typeof asset.put !== 'function') throw new Error('ui_unreachable')
      const buffer = await chip.file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const result = await asset.put(chip.mime, bytesToBase64(bytes))
      if (!isRecord(result) || result.ok !== true) {
        throw new Error(isRecord(result) && typeof result.code === 'string' ? result.code : 'bad_asset')
      }
      const ref = normalizeRef(result.ref, chip.mime, bytes.length)
      if (ref === null) throw new Error('bad_asset')
      const text = isParseable(chip.mime, chip.name)
        ? await chip.file.text().catch(() => null)
        : null
      chip.source = ref
      chip.text = text
      chip.status = 'ready'
    } catch (err) {
      chip.status = 'failed'
      chip.error = String(err && (err as Error).message ? (err as Error).message : err)
    }
    if (!disposed) publish()
  }

  async function addFiles(files: FileList | File[] | null | undefined): Promise<void> {
    for (const file of Array.from(files ?? [])) {
      if (file === null || file === undefined) continue
      const mime =
        typeof file.type === 'string' && file.type.length > 0 ? file.type : guessMime(file.name)
      const chip: Chip = {
        id: nextId(),
        name: typeof file.name === 'string' ? file.name : 'file',
        mime,
        kind: attachmentKind(mime, file.name),
        status: 'loading',
        source: null,
        text: null,
        error: null,
        file,
      }
      state.attachments = [...state.attachments, chip]
      publish()
      void uploadChip(chip)
    }
  }

  function removeChip(id: string): void {
    state.attachments = state.attachments.filter((chip) => chip.id !== id)
    publish()
  }

  async function retryChip(id: string): Promise<void> {
    const chip = state.attachments.find((item) => item.id === id)
    if (chip !== undefined) await uploadChip(chip)
  }

  // ---- 配置（模型 / 推理强度 / 权限） ----

  /**
   * 写配置的公共路径：先 `config.read` 读回最新整份 body，只改本插件负责的字段，再整值 `put` + `add_gen`。
   * 不基于本地缓存写——否则会把同进程内其它写者（主题 / 侧栏宽度）的改动整份覆盖掉。
   * 读回 `active` 作 `expect_active`：两次往返间世界换代则内核 `stale_active` 拒写。
   */
  async function readConfigReady(): Promise<IdentityRead> {
    let read = await client.readConfigState()
    for (let attempt = 0; attempt < 3 && isCodeGenFallbackBody(read.body); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt))
      if (disposed) return read
      read = await client.readConfigState()
    }
    return read
  }

  async function commitConfig(change: unknown): Promise<SubmitResult> {
    const fresh = await readConfigReady()
    if (disposed) return { ok: false, code: 'disposed', run: null }
    // 代码世代回落 body（配置身份尚无数据世代）→ 未就绪，退避后仍如此则不写。
    if (isCodeGenFallbackBody(fresh.body)) return { ok: false, code: 'not_loaded', run: null }
    const base = fresh.body !== null ? fresh.body : state.config
    if (base === null || isCodeGenFallbackBody(base)) return { ok: false, code: 'not_loaded', run: null }
    state.config = mergeConfig(base, change)
    publish()
    return client.writeConfig(state.config, fresh.active)
  }

  function applyReasoningOptions(options: string[]): void {
    const collapsed = collapseReasoning(options)
    const current = currentReasoningOf(state.config)
    const value =
      typeof current === 'string' && options.includes(current)
        ? current
        : collapsed.collapsed
          ? (collapsed.value ?? options[0])
          : options[0]
    state.reasoning = {
      status: 'ready',
      options,
      collapsed: collapsed.collapsed,
      value: value ?? null,
      error: null,
    }
    publish()
  }

  async function ensureReasoning(): Promise<void> {
    // 请求序号：模型 / 配置在拉取期间可能已切换，旧回包不得覆盖新状态。
    const seq = (reasoningSeq += 1)
    if (state.config === null || state.model === null) {
      state.reasoning = hiddenReasoning()
      publish()
      return
    }
    const fromConfig = reasoningOptionsFromConfig(state.config)
    if (fromConfig !== null && fromConfig.length > 0) {
      applyReasoningOptions(fromConfig)
      return
    }
    state.reasoning = {
      status: 'fetching',
      options: [],
      collapsed: false,
      value: null,
      error: null,
    }
    publish()
    const profile = await client.fetchProfile()
    if (disposed || seq !== reasoningSeq) return
    if (!profile.ok) {
      state.reasoning = {
        status: 'failed',
        options: [],
        collapsed: false,
        value: null,
        error: profile.code,
      }
      publish()
      return
    }
    const config = await client.readConfig()
    if (disposed || seq !== reasoningSeq) return
    if (config !== null) state.config = config
    const options = reasoningOptionsFromConfig(state.config)
    if (options === null || options.length === 0) {
      state.reasoning = hiddenReasoning()
      publish()
      return
    }
    applyReasoningOptions(options)
  }

  async function loadConfig(): Promise<void> {
    const config = await client.readConfig()
    if (disposed) return
    state.config = config
    state.model = config === null ? null : currentModelOf(config)
    state.permission =
      config === null ? 'review' : normalizePermission(isRecord(config) ? config.permission : null)
    publish()
    await ensureReasoning()
  }

  /** 轻量重读：只刷新模型列表与当前选择，不触发推理档拉取（供打开模型下拉前用）。 */
  async function refreshConfig(): Promise<unknown> {
    const config = await client.readConfig()
    if (disposed || config === null) return config
    state.config = config
    state.model = currentModelOf(config)
    state.permission = normalizePermission(isRecord(config) ? config.permission : null)
    publish()
    return config
  }

  async function selectModel(value: string): Promise<void> {
    if (state.config === null) return
    const separator = value.indexOf('::')
    if (separator <= 0) return
    const vendor = value.slice(0, separator)
    const model = value.slice(separator + 2)
    if (vendor.length === 0 || model.length === 0) return
    state.model = model
    state.reasoning = hiddenReasoning()
    publish()
    const wrote = await commitConfig({ vendor, model })
    if (disposed) return
    state.model = currentModelOf(state.config)
    if (!wrote.ok) {
      state.error = wrote.code
      publish()
      return
    }
    await ensureReasoning()
  }

  async function selectReasoning(value: string | null): Promise<void> {
    if (state.config === null) return
    const wrote = await commitConfig({ reasoning: value })
    if (disposed) return
    if (wrote.ok && state.reasoning.status === 'ready' && state.reasoning.options.length > 0) {
      applyReasoningOptions(state.reasoning.options)
      return
    }
    publish()
    if (!wrote.ok) {
      state.error = wrote.code
      publish()
    }
  }

  async function selectPermission(value: string): Promise<void> {
    if (state.config === null) return
    state.permission = normalizePermission(value)
    publish()
    const wrote = await commitConfig({ permission: value })
    if (disposed) return
    state.permission = normalizePermission(isRecord(state.config) ? state.config.permission : null)
    publish()
    if (!wrote.ok) {
      state.error = wrote.code
      publish()
    }
  }

  // ---- 发送 / 终止 / 待发队列 ----

  /** 触发 `chat.send`：不等回合结束（进度由宿主事件驱动）；`transport_failed` 是长回合超时的正常现象。 */
  function dispatchSend(threadKey: string): void {
    tracking = expectTurn(tracking, threadKey)
    publish()
    void client.triggerSend(threadKey).then((result) => {
      if (disposed) return
      tracking = clearExpecting(tracking, threadKey)
      if (!result.ok && result.code !== 'transport_failed') state.error = result.code
      publish()
    })
  }

  function clearWriteTimer(threadKey: string): void {
    const timer = writeTimers.get(threadKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      writeTimers.delete(threadKey)
    }
  }

  /** 写 run 落账（或等待超时）：解除线程忙态并触发 `chat.send`。 */
  function releaseWriteAndSend(threadKey: string, run: string): void {
    clearWriteTimer(threadKey)
    tracking = releaseWrite(tracking, threadKey, run)
    dispatchSend(threadKey)
  }

  /** 槽写已受理后武装发送：等写 run 落账（否则 `chat.send` 可能读到旧槽）再触发命令。 */
  function armSend(threadKey: string, run: string | null): void {
    if (typeof run !== 'string' || run.length === 0) {
      dispatchSend(threadKey)
      return
    }
    const armed = armWrite(tracking, threadKey, run)
    tracking = armed.state
    publish()
    if (armed.dispatch) {
      clearWriteTimer(threadKey)
      dispatchSend(threadKey)
      return
    }
    const timer = setTimeout(() => {
      writeTimers.delete(threadKey)
      releaseWriteAndSend(threadKey, run)
    }, WRITE_WAIT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    writeTimers.set(threadKey, timer)
  }

  async function send(): Promise<void> {
    if (state.sending) return
    const threadKey = threadKeyOf(state.activeThread)
    const ready = state.attachments.filter(
      (chip) => chip.status === 'ready' && chip.source !== null,
    )
    if (state.text.trim().length === 0 && ready.length === 0) return
    const sentText = state.text
    const slot = buildMessageSlot(state.text, ready.map(toAttachment))
    if (isThreadBusy(tracking, threadKey)) {
      state.pending = enqueue(state.pending, threadKey, { id: nextId(), slot })
      clearSentInput(ready, sentText)
      publish()
      return
    }
    state.sending = true
    state.error = null
    tracking = beginWrite(tracking, threadKey)
    publish()
    const wrote = await client.writeSlot(threadKey, slot)
    if (disposed) return
    tracking = endWrite(tracking, threadKey)
    state.sending = false
    if (!wrote.ok) {
      state.error = wrote.code
      publish()
      return
    }
    clearSentInput(ready, sentText)
    publish()
    armSend(threadKey, wrote.run)
  }

  async function stop(): Promise<void> {
    const run = tracking.runs[threadKeyOf(state.activeThread)]
    if (typeof run !== 'string') return
    const result = await client.cancelRun(run)
    if (disposed) return
    if (!result.ok) {
      state.error = result.code.length > 0 ? result.code : 'unknown'
      publish()
    }
  }

  async function continueQueue(threadKey: string): Promise<void> {
    // 同线程已有写 / 回合在途时不抢跑：等其结束的 run.finished 再续。
    if (isThreadBusy(tracking, threadKey)) return
    if (queueCount(state.pending, threadKey) === 0) return
    const result = dequeue(state.pending, threadKey)
    if (result.message === null) return
    state.pending = result.queue
    publish()
    tracking = beginWrite(tracking, threadKey)
    const wrote = await client.writeSlot(threadKey, result.message)
    if (disposed) return
    tracking = endWrite(tracking, threadKey)
    if (!wrote.ok) {
      state.pending = enqueueFront(state.pending, threadKey, result.message)
      state.error = wrote.code
      publish()
      return
    }
    armSend(threadKey, wrote.run)
  }

  function removePending(id: string): number {
    const threadKey = threadKeyOf(state.activeThread)
    state.pending = removeFromQueue(state.pending, threadKey, id)
    publish()
    return queueCount(state.pending, threadKey)
  }

  // ---- 事件（壳事件总线；按线程过滤） ----

  function onRecord(record: { topic: string; payload: unknown }): void {
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.topic === 'run.started') {
      const tracked = trackRunStarted(tracking, runIdOf(payload), runKeyOf(payload))
      tracking = tracked.state
      if (tracked.turnStarted && matchesThread(payload.thread, state.activeThread)) publish()
      return
    }
    if (record.topic === 'run.finished') {
      const key = runKeyOf(payload)
      const tracked = trackRunFinished(tracking, runIdOf(payload), key)
      tracking = tracked.state
      // 槽写 run 落账：此刻才触发 `chat.send`（此时它才读得到新槽）。
      if (tracked.kind === 'write') {
        clearWriteTimer(key)
        dispatchSend(key)
        return
      }
      // 回合 run 结束：按线程键清空（后台线程也要清），再续发该线程队列。
      if (tracked.kind === 'turn') {
        if (matchesThread(payload.thread, state.activeThread)) publish()
        void continueQueue(key)
      }
      return
    }
    if (record.topic === 'context.assembled') {
      if (!matchesThread(payload.thread, state.activeThread)) return
      state.usage = { ...state.usage, [runKeyOf(payload)]: payload }
      publish()
    }
  }

  function applyActiveThread(value: unknown): void {
    state.activeThread = typeof value === 'string' && value.length > 0 ? value : null
    publish()
  }

  async function init(): Promise<void> {
    const loaded = await loadMessages((url) => fetch(url), ctx.tokens.messages)
    if (disposed) return
    state.table = loaded
    const initial =
      typeof ctx.uiState?.get === 'function' ? ctx.uiState.get('active_thread') : undefined
    state.activeThread = typeof initial === 'string' && initial.length > 0 ? initial : null
    if (typeof ctx.uiState?.subscribe === 'function') {
      offThread = ctx.uiState.subscribe('active_thread', applyActiveThread)
    }
    if (typeof ctx.events?.onAny === 'function') {
      offEvents = ctx.events.onAny((record) => onRecord(record))
    }
    publish()
    await loadConfig()
  }

  function dispose(): void {
    disposed = true
    if (offEvents !== null) offEvents()
    if (offThread !== null) offThread()
    for (const timer of writeTimers.values()) clearTimeout(timer)
    writeTimers.clear()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    init,
    dispose,
    t,
    setText(text) {
      state.text = typeof text === 'string' ? text : ''
      publish()
    },
    addFiles,
    retryChip,
    removeChip,
    expandAttachments() {
      state.attachExpanded = true
      publish()
    },
    removePending,
    refreshConfig,
    selectModel,
    selectReasoning,
    selectPermission,
    ensureReasoning,
    send,
    stop,
  }
}
