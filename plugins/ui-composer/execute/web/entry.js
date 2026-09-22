// `ui-composer` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约，slot = composer）。
// 本模块只编排：DOM 骨架、输入卡渲染、附件上传、三个锚定下拉、待发队列、上下文用量行、
// 事件订阅（自己服务的 `/events`，按线程过滤）。命令 / 提交 / 终止走本插件自己的入站连接；
// 跨 slot 视图态（`active_thread`）与附件字节入库借用壳的 `api.uiState` / `api.asset`。

import { ensureStyles } from './styles.js'
import { clear, el, icon } from './dom.js'
import { formatText, loadMessages, messageText } from './messages.js'
import {
  buildMessageSlot,
  collapseReasoning,
  currentModelOf,
  currentReasoningOf,
  dequeue,
  enqueue,
  enqueueFront,
  isRecord,
  matchesThread,
  mergeConfig,
  messageSummary,
  modelsOf,
  normalizePermission,
  permissionDescCode,
  permissionIcon,
  permissionLabelCode,
  PERMISSIONS,
  queueCount,
  queueOf,
  reasoningOptionsFromConfig,
  removeFromQueue,
  runIdOf,
  runKeyOf,
  sourceRows,
  threadKeyOf,
  trimmedRows,
  usageView,
} from './model.js'
import {
  attachmentKind,
  buildAttachment,
  bytesToBase64,
  guessMime,
  isParseable,
  normalizeRef,
} from './attach.js'
import {
  closeDropdown as closeDropdownState,
  createDropdownState,
  isActiveIndex,
  moveActive,
  openDropdown as openDropdownState,
  optionId,
} from './dropdown.js'
import {
  cancelRun,
  fetchProfile,
  readConfig,
  triggerSend,
  writeConfig,
  writeSlot,
} from './client.js'
import { connectEvents } from './sse.js'
import * as runs from './run-model.js'

export const contract = '1'

const BASE = new URL('.', import.meta.url)
const MAX_CHIPS = 4
const TOOLTIP_DELAY_MS = 400
/** 等槽写 run 落账的上限；超时后仍派发，避免事件丢失把线程卡在「忙」。 */
const WRITE_WAIT_MS = 5000

export async function mount(root, api) {
  const doc = root.ownerDocument
  ensureStyles(doc)
  const table = await loadMessages(fetch, '/assets/messages.v1.json')
  const t = (code, vars) =>
    vars === undefined ? messageText(table, code) : formatText(table, code, vars)

  const state = {
    activeThread: null,
    text: '',
    attachments: [],
    attachExpanded: false,
    pending: {},
    usage: {},
    config: null,
    model: null,
    reasoning: { status: 'hidden', options: [], collapsed: false, value: null, error: null },
    permission: 'review',
    sending: false,
    error: null,
  }

  let tracking = runs.createRunState()
  let disposed = false
  let composing = false
  let contextTipTimer = null
  let openDd = null
  let pendingOpen = false

  // ---- DOM 骨架 ----

  const container = el(doc, 'div', { class: 'composer-root' })
  const mask = el(doc, 'div', { class: 'composer-mask', attrs: { hidden: true } })
  const card = el(doc, 'div', { class: 'composer-card' })

  const pendingWrap = el(doc, 'div', { class: 'composer-pending-wrap' })
  const pendingChip = el(doc, 'button', {
    class: 'composer-pending',
    attrs: { type: 'button', hidden: true, 'aria-live': 'polite', 'aria-atomic': 'true' },
  })
  const pendingPopover = el(doc, 'div', {
    class: 'composer-popover',
    dataset: { placement: 'below' },
    attrs: {
      role: 'dialog',
      tabindex: '-1',
      hidden: true,
      'aria-label': t('composer_pending_title'),
    },
  })
  pendingWrap.append(pendingChip, pendingPopover)

  const attachRow = el(doc, 'div', { class: 'composer-attach-row', attrs: { hidden: true } })
  const input = el(doc, 'textarea', {
    class: 'composer-input',
    attrs: {
      rows: '1',
      placeholder: t('composer_placeholder'),
      'aria-label': t('composer_placeholder'),
    },
  })

  const toolbar = el(doc, 'div', { class: 'composer-toolbar' })
  const left = el(doc, 'div', { class: 'composer-toolbar-left' })
  const right = el(doc, 'div', { class: 'composer-toolbar-right' })

  const fileInput = el(doc, 'input', { attrs: { type: 'file', multiple: true, hidden: true } })

  const contextRow = el(doc, 'div', {
    class: 'composer-context',
    attrs: {
      hidden: true,
      tabindex: '0',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'aria-describedby': 'composer-context-tip',
    },
  })
  const contextText = el(doc, 'span', { class: 'composer-context-text' })
  const contextTip = el(doc, 'div', {
    class: 'composer-popover',
    dataset: { placement: 'above' },
    attrs: { role: 'tooltip', id: 'composer-context-tip', hidden: true },
  })
  contextRow.append(contextText, contextTip)

  // ---- 下拉弹层（模型 / 推理强度 / 权限） ----

  function closeOverlays(returnFocus) {
    mask.hidden = true
    if (pendingOpen) {
      pendingOpen = false
      pendingPopover.hidden = true
      if (returnFocus) pendingChip.focus()
    }
    if (openDd !== null) {
      const dd = openDd
      openDd = null
      dd.state = closeDropdownState()
      dd.popover.hidden = true
      dd.trigger.setAttribute('aria-expanded', 'false')
      if (returnFocus) dd.trigger.focus()
    }
  }

  function createDropdown(spec) {
    const wrap = el(doc, 'div', { class: 'composer-tool-wrap' })
    const trigger = el(doc, 'button', {
      class: 'composer-tool',
      attrs: {
        type: 'button',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
        'aria-label': spec.label,
        title: spec.label,
      },
    })
    const iconSlot = el(doc, 'span', { class: 'composer-tool-icon' })
    const valueSlot = el(doc, 'span', { class: 'composer-tool-value' })
    const chevron = el(doc, 'span', { class: 'composer-tool-chevron' }, [
      icon(doc, 'chevron-down', 16),
    ])
    trigger.append(iconSlot, valueSlot, chevron)
    const popover = el(doc, 'div', {
      class: 'composer-popover',
      dataset: { placement: 'below' },
      attrs: { role: 'listbox', tabindex: '-1', hidden: true, 'aria-label': spec.label },
    })
    wrap.append(trigger, popover)

    const dd = {
      wrap,
      trigger,
      iconSlot,
      valueSlot,
      chevron,
      popover,
      spec,
      state: createDropdownState(),
      options: [],
    }
    trigger.addEventListener('click', (event) => {
      event.stopPropagation()
      if (typeof spec.onTrigger === 'function') {
        spec.onTrigger(event, dd)
        return
      }
      if (dd.state.open) closeOverlays(false)
      else {
        closeOverlays(false)
        showDropdown(dd)
      }
    })
    popover.addEventListener('keydown', (event) => onDropdownKey(event, dd))
    return dd
  }

  function showDropdown(dd) {
    dd.options = dd.spec.options()
    if (dd.options.length === 0) return
    const selected = dd.options.findIndex((option) => option.value === dd.spec.value())
    dd.state = openDropdownState(dd.state, selected, dd.options.length)
    renderDropdown(dd)
    dd.popover.hidden = false
    dd.trigger.setAttribute('aria-expanded', 'true')
    mask.hidden = false
    openDd = dd
    dd.popover.focus()
  }

  function renderDropdown(dd) {
    clear(dd.popover)
    const selectedValue = dd.spec.value()
    dd.options.forEach((option, index) => {
      const node = el(doc, 'div', {
        class: 'composer-option',
        attrs: {
          role: 'option',
          id: optionId(dd.spec.prefix, index),
          'aria-selected': String(option.value === selectedValue),
          'data-active': String(isActiveIndex(dd.state, index)),
        },
        on: {
          click: () => {
            dd.spec.select(option.value)
            closeOverlays(true)
          },
        },
      })
      if (typeof option.icon === 'string') {
        node.append(
          el(doc, 'span', { class: 'composer-option-icon' }, [icon(doc, option.icon, 16)]),
        )
      }
      node.append(
        el(doc, 'span', { class: 'composer-option-body' }, [
          el(doc, 'span', { class: 'composer-option-label', text: option.label }),
          typeof option.description === 'string' && option.description.length > 0
            ? el(doc, 'span', { class: 'composer-option-desc', text: option.description })
            : null,
        ]),
      )
      if (option.value === selectedValue) node.append(icon(doc, 'check', 16))
      dd.popover.append(node)
    })
    const active = dd.state.activeIndex
    if (active >= 0 && active < dd.options.length) {
      dd.popover.setAttribute('aria-activedescendant', optionId(dd.spec.prefix, active))
    } else {
      dd.popover.removeAttribute('aria-activedescendant')
    }
  }

  function onDropdownKey(event, dd) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      dd.state = moveActive(dd.state, event.key === 'ArrowDown' ? 1 : -1, dd.options.length)
      renderDropdown(dd)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = dd.options[dd.state.activeIndex]
      if (option !== undefined) {
        dd.spec.select(option.value)
        closeOverlays(true)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeOverlays(true)
    }
  }

  const modelDd = createDropdown({
    prefix: 'composer-model',
    label: t('composer_model'),
    options: () =>
      modelsOf(state.config).map((item) => ({
        value: `${item.vendor}::${item.id}`,
        label: item.name,
        description: item.vendor,
      })),
    value: () => {
      const vendor =
        state.config !== null && typeof state.config.vendor === 'string' ? state.config.vendor : ''
      const model = currentModelOf(state.config)
      return vendor.length > 0 && model !== null ? `${vendor}::${model}` : null
    },
    select: (value) => void selectModel(value),
  })

  const reasoningDd = createDropdown({
    prefix: 'composer-reasoning',
    label: t('composer_reasoning'),
    options: () => state.reasoning.options.map((value) => ({ value, label: value })),
    value: () => (state.reasoning.status === 'ready' ? state.reasoning.value : null),
    select: (value) => void selectReasoning(value),
    onTrigger: (event, dd) => {
      if (state.reasoning.status !== 'ready') return
      if (state.reasoning.collapsed) {
        const on = currentReasoningOf(state.config) === state.reasoning.value
        void selectReasoning(on ? null : state.reasoning.value)
        return
      }
      if (dd.state.open) closeOverlays(false)
      else {
        closeOverlays(false)
        showDropdown(dd)
      }
    },
  })

  const permissionDd = createDropdown({
    prefix: 'composer-permission',
    label: t('composer_permission'),
    options: () =>
      PERMISSIONS.map((value) => ({
        value,
        label: t(permissionLabelCode(value)),
        description: t(permissionDescCode(value)),
        icon: permissionIcon(value),
      })),
    value: () => state.permission,
    select: (value) => void selectPermission(value),
  })

  const attachButton = el(
    doc,
    'button',
    {
      class: 'composer-tool',
      attrs: { type: 'button', 'aria-label': t('composer_attach'), title: t('composer_attach') },
    },
    [icon(doc, 'plus', 20)],
  )

  const reasoningError = el(doc, 'span', {
    class: 'composer-inline-error',
    attrs: { hidden: true },
  })
  const reasoningErrorText = el(doc, 'span')
  const reasoningRetry = el(doc, 'button', {
    class: 'composer-inline-retry',
    attrs: { type: 'button' },
    text: t('composer_retry'),
  })
  reasoningRetry.addEventListener('click', () => void ensureReasoning())
  reasoningError.append(reasoningErrorText, reasoningRetry)

  const sendError = el(doc, 'span', { class: 'composer-inline-error', attrs: { hidden: true } })

  const sendButton = el(doc, 'button', { class: 'composer-send', attrs: { type: 'button' } })
  sendButton.append(
    el(doc, 'span', { class: 'composer-send-icon', dataset: { icon: 'send' } }, [
      icon(doc, 'arrow-up', 20),
    ]),
    el(doc, 'span', { class: 'composer-send-icon', dataset: { icon: 'stop' } }, [
      icon(doc, 'square', 20),
    ]),
  )

  left.append(attachButton, modelDd.wrap, reasoningDd.wrap, reasoningError, sendError)
  right.append(permissionDd.wrap, sendButton)
  toolbar.append(left, right)
  card.append(pendingWrap, attachRow, input, toolbar)
  container.append(mask, card, contextRow, fileInput)
  root.replaceChildren(container)

  // ---- 基础交互 ----

  function autoGrow() {
    input.style.height = 'auto'
    input.style.height = `${input.scrollHeight}px`
  }

  function nextId() {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function isRunning(threadKey) {
    return typeof tracking.runs[threadKey] === 'string'
  }

  function isBusy(threadKey) {
    return runs.isThreadBusy(tracking, threadKey)
  }

  /** 标记 / 解除「本线程槽写请求在途」：挡住同线程并发的读-改-写。 */
  function beginWrite(threadKey) {
    tracking = runs.beginWrite(tracking, threadKey)
  }

  function endWrite(threadKey) {
    tracking = runs.endWrite(tracking, threadKey)
  }

  function hasReadyAttachment() {
    return state.attachments.some((chip) => chip.status === 'ready' && chip.source !== null)
  }

  function canSend() {
    return state.text.trim().length > 0 || hasReadyAttachment()
  }

  function assetUrl(source) {
    // 壳反代 `/p/<id>/*` 不保留查询串，故走路径段：`api/asset/<sha256>/<encodeURIComponent(mime)>`。
    const sha256 = encodeURIComponent(source.sha256)
    const mime =
      typeof source.mime === 'string' && source.mime.length > 0
        ? `/${encodeURIComponent(source.mime)}`
        : ''
    return new URL(`api/asset/${sha256}${mime}`, BASE).href
  }

  input.addEventListener('input', () => {
    state.text = input.value
    autoGrow()
    renderSend()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || composing) return
    event.preventDefault()
    void onSend()
  })
  input.addEventListener('compositionstart', () => {
    composing = true
  })
  input.addEventListener('compositionend', () => {
    composing = false
  })

  card.addEventListener('focusin', () => {
    card.dataset.focus = 'true'
  })
  card.addEventListener('focusout', () => {
    card.dataset.focus = 'false'
  })

  attachButton.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    void addFiles(fileInput.files)
    fileInput.value = ''
  })

  card.addEventListener('dragover', (event) => {
    event.preventDefault()
    card.dataset.dragover = 'true'
  })
  card.addEventListener('dragleave', () => {
    card.dataset.dragover = 'false'
  })
  card.addEventListener('drop', (event) => {
    event.preventDefault()
    card.dataset.dragover = 'false'
    if (event.dataTransfer !== null) void addFiles(event.dataTransfer.files)
  })
  input.addEventListener('paste', (event) => {
    const items = event.clipboardData !== null ? event.clipboardData.items : null
    if (items === null) return
    const files = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file !== null) files.push(file)
      }
    }
    if (files.length > 0) void addFiles(files)
  })

  sendButton.addEventListener('click', () => {
    if (isRunning(threadKeyOf(state.activeThread))) void onStop()
    else void onSend()
  })

  pendingChip.addEventListener('click', (event) => {
    event.stopPropagation()
    if (pendingOpen) {
      closeOverlays(false)
      return
    }
    closeOverlays(false)
    openPending()
  })
  pendingPopover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    closeOverlays(true)
  })
  mask.addEventListener('click', () => closeOverlays(false))

  function onDocKeydown(event) {
    if (event.key !== 'Escape') return
    if (openDd === null && !pendingOpen) return
    event.preventDefault()
    closeOverlays(true)
  }
  doc.addEventListener('keydown', onDocKeydown)

  // ---- 附件 ----

  async function addFiles(files) {
    for (const file of Array.from(files ?? [])) {
      if (file === null || file === undefined) continue
      const mime =
        typeof file.type === 'string' && file.type.length > 0 ? file.type : guessMime(file.name)
      const chip = {
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
      renderAttachments()
      void uploadChip(chip)
    }
  }

  async function uploadChip(chip) {
    chip.status = 'loading'
    chip.error = null
    renderAttachments()
    try {
      const asset = isRecord(api) ? api.asset : null
      if (!isRecord(asset) || typeof asset.put !== 'function') throw new Error('ui_unreachable')
      const buffer = await chip.file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const result = await asset.put(chip.mime, bytesToBase64(bytes))
      if (!isRecord(result) || result.ok !== true) {
        throw new Error(typeof result?.code === 'string' ? result.code : 'bad_asset')
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
      chip.error = String(err && err.message ? err.message : err)
    }
    if (!disposed) renderAttachments()
  }

  function toAttachment(chip) {
    return buildAttachment({
      name: chip.name,
      mime: chip.mime,
      sha256: chip.source.sha256,
      size: chip.source.size,
      text: chip.text,
    })
  }

  function clearSentInput(sent) {
    state.text = ''
    input.value = ''
    autoGrow()
    const sentIds = new Set(sent.map((chip) => chip.id))
    state.attachments = state.attachments.filter((chip) => !sentIds.has(chip.id))
  }

  // ---- 发送 / 终止 / 待发队列 ----

  /** 触发 `chat.send`：不等回合结束（进度由宿主事件驱动）；`transport_failed` 是长回合超时的正常现象。 */
  function dispatchSend(threadKey) {
    tracking = runs.expectTurn(tracking, threadKey)
    renderSend()
    void triggerSend(threadKey).then((result) => {
      if (disposed) return
      tracking = runs.clearExpecting(tracking, threadKey)
      if (!result.ok && result.code !== 'transport_failed') state.error = result.code
      renderSend()
      renderError()
    })
  }

  const writeTimers = new Map()

  function clearWriteTimer(threadKey) {
    const timer = writeTimers.get(threadKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      writeTimers.delete(threadKey)
    }
  }

  /** 写 run 落账（或等待超时）：解除线程忙态并触发 `chat.send`。 */
  function releaseWrite(threadKey, run) {
    clearWriteTimer(threadKey)
    tracking = runs.releaseWrite(tracking, threadKey, run)
    dispatchSend(threadKey)
  }

  /** 槽写已受理后武装发送：等写 run 落账（否则 `chat.send` 可能读到旧槽）再触发命令。 */
  function armSend(threadKey, run) {
    if (typeof run !== 'string' || run.length === 0) {
      dispatchSend(threadKey)
      return
    }
    const armed = runs.armWrite(tracking, threadKey, run)
    tracking = armed.state
    renderSend()
    if (armed.dispatch) {
      clearWriteTimer(threadKey)
      dispatchSend(threadKey)
      return
    }
    const timer = setTimeout(() => {
      writeTimers.delete(threadKey)
      releaseWrite(threadKey, run)
    }, WRITE_WAIT_MS)
    timer.unref?.()
    writeTimers.set(threadKey, timer)
  }

  async function onSend() {
    if (state.sending) return
    const threadKey = threadKeyOf(state.activeThread)
    const ready = state.attachments.filter(
      (chip) => chip.status === 'ready' && chip.source !== null,
    )
    if (state.text.trim().length === 0 && ready.length === 0) return
    const slot = buildMessageSlot(state.text, ready.map(toAttachment))
    if (isBusy(threadKey)) {
      state.pending = enqueue(state.pending, threadKey, { id: nextId(), slot })
      clearSentInput(ready)
      renderAll()
      return
    }
    state.sending = true
    state.error = null
    beginWrite(threadKey)
    renderAll()
    const wrote = await writeSlot(threadKey, slot)
    if (disposed) return
    endWrite(threadKey)
    state.sending = false
    if (!wrote.ok) {
      state.error = wrote.code
      renderAll()
      return
    }
    clearSentInput(ready)
    renderAll()
    armSend(threadKey, wrote.run)
  }

  async function onStop() {
    const run = tracking.runs[threadKeyOf(state.activeThread)]
    if (typeof run !== 'string') return
    const result = await cancelRun(run)
    if (disposed) return
    if (!result.ok) {
      state.error = result.code.length > 0 ? result.code : 'unknown'
      renderError()
    }
  }

  async function continueQueue(threadKey) {
    // 同线程已有写 / 回合在途时不抢跑：等其结束的 run.finished 再续。
    if (isBusy(threadKey)) return
    if (queueCount(state.pending, threadKey) === 0) return
    const result = dequeue(state.pending, threadKey)
    if (result.message === null) return
    state.pending = result.queue
    renderPending()
    beginWrite(threadKey)
    const wrote = await writeSlot(threadKey, result.message.slot)
    if (disposed) return
    endWrite(threadKey)
    if (!wrote.ok) {
      state.pending = enqueueFront(state.pending, threadKey, result.message)
      state.error = wrote.code
      renderPending()
      renderError()
      return
    }
    armSend(threadKey, wrote.run)
  }

  function openPending() {
    const threadKey = threadKeyOf(state.activeThread)
    const list = queueOf(state.pending, threadKey)
    if (list.length === 0) return
    clear(pendingPopover)
    pendingPopover.append(
      el(doc, 'div', { class: 'composer-popover-title', text: t('composer_pending_title') }),
    )
    for (const message of list) {
      const summary = messageSummary(message.slot)
      const label =
        summary.count > 0
          ? summary.text.length > 0
            ? `${summary.text} · ${t('composer_attachment', { count: summary.count })}`
            : t('composer_attachment', { count: summary.count })
          : summary.text
      const remove = el(
        doc,
        'button',
        {
          class: 'composer-popover-remove',
          attrs: { type: 'button', 'aria-label': t('composer_pending_remove') },
        },
        [icon(doc, 'x', 16)],
      )
      remove.addEventListener('click', () => {
        state.pending = removeFromQueue(state.pending, threadKey, message.id)
        if (queueCount(state.pending, threadKey) === 0) closeOverlays(true)
        else openPending()
        renderPending()
      })
      pendingPopover.append(
        el(doc, 'div', { class: 'composer-popover-row' }, [
          el(doc, 'span', { class: 'composer-popover-row-text', text: label }),
          remove,
        ]),
      )
    }
    pendingPopover.hidden = false
    mask.hidden = false
    pendingOpen = true
    pendingPopover.focus()
  }

  // ---- 配置写入（模型 / 推理强度 / 权限） ----

  /**
   * 写配置的公共路径：先 `config.read` 读回最新整份 body，只改本插件负责的字段，再整值 `put` + `add_gen`。
   * 不基于本地缓存写——否则会把同进程内其它写者（主题 / 侧栏宽度）的改动整份覆盖掉。
   */
  async function commitConfig(change) {
    const fresh = await readConfig()
    if (disposed) return { ok: false, code: 'disposed', run: null }
    const base = fresh !== null ? fresh : state.config
    if (base === null) return { ok: false, code: 'input_unavailable', run: null }
    state.config = mergeConfig(base, change)
    renderToolbar()
    return writeConfig(state.config)
  }

  async function selectModel(value) {
    if (state.config === null) return
    const separator = value.indexOf('::')
    if (separator <= 0) return
    const vendor = value.slice(0, separator)
    const model = value.slice(separator + 2)
    if (vendor.length === 0 || model.length === 0) return
    state.model = model
    state.reasoning = { status: 'hidden', options: [], collapsed: false, value: null, error: null }
    renderToolbar()
    renderError()
    const wrote = await commitConfig({ vendor, model })
    if (disposed) return
    state.model = currentModelOf(state.config)
    if (!wrote.ok) {
      state.error = wrote.code
      renderToolbar()
      renderError()
      return
    }
    await ensureReasoning()
  }

  async function selectReasoning(value) {
    if (state.config === null) return
    const wrote = await commitConfig({ reasoning: value })
    if (disposed) return
    if (wrote.ok && state.reasoning.status === 'ready' && state.reasoning.options.length > 0) {
      applyReasoningOptions(state.reasoning.options)
      return
    }
    renderToolbar()
    if (!wrote.ok) {
      state.error = wrote.code
      renderError()
    }
  }

  async function selectPermission(value) {
    if (state.config === null) return
    state.permission = normalizePermission(value)
    renderToolbar()
    const wrote = await commitConfig({ permission: value })
    if (disposed) return
    state.permission = normalizePermission(state.config.permission)
    renderToolbar()
    if (!wrote.ok) {
      state.error = wrote.code
      renderError()
    }
  }

  async function loadConfig() {
    const config = await readConfig()
    if (disposed) return
    state.config = config
    state.model = config === null ? null : currentModelOf(config)
    state.permission = config === null ? 'review' : normalizePermission(config.permission)
    renderToolbar()
    renderSend()
    await ensureReasoning()
  }

  function applyReasoningOptions(options) {
    const collapsed = collapseReasoning(options)
    const current = currentReasoningOf(state.config)
    const value =
      typeof current === 'string' && options.includes(current)
        ? current
        : collapsed.collapsed
          ? collapsed.value
          : options[0]
    state.reasoning = {
      status: 'ready',
      options,
      collapsed: collapsed.collapsed,
      value,
      error: null,
    }
    renderToolbar()
    renderError()
  }

  async function ensureReasoning() {
    if (state.config === null || state.model === null) {
      state.reasoning = {
        status: 'hidden',
        options: [],
        collapsed: false,
        value: null,
        error: null,
      }
      renderToolbar()
      renderError()
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
    renderToolbar()
    renderError()
    const profile = await fetchProfile()
    if (disposed) return
    if (!profile.ok) {
      state.reasoning = {
        status: 'failed',
        options: [],
        collapsed: false,
        value: null,
        error: profile.code,
      }
      renderToolbar()
      renderError()
      return
    }
    const config = await readConfig()
    if (disposed) return
    if (config !== null) state.config = config
    const options = reasoningOptionsFromConfig(state.config)
    if (options === null || options.length === 0) {
      state.reasoning = {
        status: 'hidden',
        options: [],
        collapsed: false,
        value: null,
        error: null,
      }
      renderToolbar()
      renderError()
      return
    }
    applyReasoningOptions(options)
  }

  // ---- 渲染 ----

  function renderSend() {
    const running = isRunning(threadKeyOf(state.activeThread))
    sendButton.dataset.mode = running ? 'stop' : 'send'
    const label = running ? t('composer_stop') : t('composer_send')
    sendButton.setAttribute('aria-label', label)
    sendButton.title = label
    sendButton.disabled = state.sending || (!running && !canSend())
  }

  function renderReasoning() {
    const reasoning = state.reasoning
    if (reasoning.status === 'hidden' || reasoning.status === 'failed') {
      reasoningDd.wrap.hidden = true
      return
    }
    reasoningDd.wrap.hidden = false
    reasoningDd.trigger.disabled = reasoning.status !== 'ready' || state.config === null
    if (reasoning.status === 'fetching') {
      const fetching = t('composer_reasoning_fetching')
      reasoningDd.iconSlot.replaceChildren(el(doc, 'span', { class: 'composer-chip-breathe' }))
      reasoningDd.valueSlot.textContent = fetching
      reasoningDd.trigger.title = `${t('composer_reasoning')} ${fetching}`
      reasoningDd.chevron.hidden = true
      return
    }
    reasoningDd.iconSlot.replaceChildren(icon(doc, 'gauge', 20))
    if (reasoning.collapsed) {
      const on = currentReasoningOf(state.config) === reasoning.value
      const stateText = on ? t('composer_reasoning_on') : t('composer_reasoning_off')
      reasoningDd.valueSlot.textContent = stateText
      reasoningDd.trigger.title = `${t('composer_reasoning')} ${stateText}`
      reasoningDd.chevron.hidden = true
      reasoningDd.trigger.setAttribute('aria-pressed', String(on))
      return
    }
    // 显示生效档位：config 缺 `params.reasoning` 时回落推导出的默认档（推理默认开）。
    const current =
      typeof reasoning.value === 'string' ? reasoning.value : currentReasoningOf(state.config)
    reasoningDd.valueSlot.textContent = typeof current === 'string' ? current : ''
    reasoningDd.trigger.title = `${t('composer_reasoning')} ${typeof current === 'string' ? current : ''}`
    reasoningDd.chevron.hidden = false
    reasoningDd.trigger.removeAttribute('aria-pressed')
  }

  function renderToolbar() {
    modelDd.iconSlot.replaceChildren(icon(doc, 'cpu', 20))
    const modelValue = state.model !== null ? state.model : t('composer_no_model')
    modelDd.valueSlot.textContent = modelValue
    // 窄屏只留图标（值由样式隐藏），当前值随名称进 tooltip，避免窄屏丢信息。
    modelDd.trigger.title = `${t('composer_model')} ${modelValue}`
    modelDd.trigger.disabled = state.config === null
    const permissionValue = t(permissionLabelCode(state.permission))
    permissionDd.iconSlot.replaceChildren(icon(doc, permissionIcon(state.permission), 20))
    permissionDd.valueSlot.textContent = permissionValue
    permissionDd.trigger.title = `${t('composer_permission')} ${permissionValue}`
    permissionDd.trigger.disabled = state.config === null
    renderReasoning()
    renderSend()
  }

  function renderAttachments() {
    clear(attachRow)
    if (state.attachments.length === 0) {
      attachRow.hidden = true
      return
    }
    attachRow.hidden = false
    const expanded = state.attachExpanded || state.attachments.length <= MAX_CHIPS
    const visible = expanded ? state.attachments : state.attachments.slice(0, MAX_CHIPS)
    for (const chip of visible) attachRow.append(renderChip(chip))
    if (!expanded) {
      const more = el(doc, 'button', {
        class: 'composer-chip',
        attrs: { type: 'button' },
        text: t('composer_more_chip', { count: state.attachments.length - MAX_CHIPS }),
      })
      more.addEventListener('click', () => {
        state.attachExpanded = true
        renderAttachments()
      })
      attachRow.append(more)
    }
  }

  function renderChip(chip) {
    const node = el(doc, 'div', {
      class: 'composer-chip',
      dataset: { status: chip.status, kind: chip.kind },
    })
    if (chip.kind === 'image' && chip.status === 'ready' && chip.source !== null) {
      node.append(
        el(doc, 'img', {
          class: 'composer-chip-thumb',
          attrs: { src: assetUrl(chip.source), alt: chip.name, loading: 'lazy' },
        }),
      )
    } else {
      node.append(icon(doc, 'paperclip', 16))
      node.append(el(doc, 'span', { class: 'composer-chip-name', text: chip.name }))
    }
    if (chip.status === 'loading') node.append(el(doc, 'span', { class: 'composer-chip-breathe' }))
    if (chip.status === 'failed') {
      const reason =
        chip.error !== null ? messageText(table, chip.error) : t('composer_attach_failed')
      node.title = reason
      node.setAttribute('aria-label', `${chip.name} · ${reason}`)
      node.addEventListener('click', () => void uploadChip(chip))
    }
    const remove = el(
      doc,
      'button',
      {
        class: 'composer-chip-remove',
        attrs: { type: 'button', 'aria-label': t('composer_remove_attachment') },
      },
      [icon(doc, 'x', 16)],
    )
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      state.attachments = state.attachments.filter((item) => item.id !== chip.id)
      renderAttachments()
    })
    node.append(remove)
    return node
  }

  function renderPending() {
    const count = queueCount(state.pending, threadKeyOf(state.activeThread))
    pendingChip.hidden = count === 0
    const label = count > 0 ? t('composer_pending', { count }) : ''
    pendingChip.textContent = label
    if (count > 0) pendingChip.setAttribute('aria-label', label)
    else pendingChip.removeAttribute('aria-label')
  }

  function buildContextTip(usage) {
    clear(contextTip)
    for (const row of sourceRows(usage)) {
      contextTip.append(
        el(doc, 'div', { class: 'composer-tooltip-row' }, [
          el(doc, 'span', { text: row.code !== null ? t(row.code) : row.key }),
          el(doc, 'span', { text: row.text }),
        ]),
      )
    }
    const trimmed = trimmedRows(usage)
    if (trimmed.length > 0) {
      contextTip.append(
        el(doc, 'div', {
          class: 'composer-tooltip-note',
          text: t('composer_trimmed', { count: trimmed.length }),
        }),
      )
      for (const item of trimmed) {
        const label = item.label.length > 0 ? item.label : t('composer_trimmed')
        const text =
          item.reason.length > 0 ? t('composer_trimmed_reason', { reason: item.reason }) : label
        contextTip.append(el(doc, 'div', { class: 'composer-tooltip-note', text }))
      }
    }
  }

  function renderContext() {
    const usage = state.usage[threadKeyOf(state.activeThread)]
    const view = usageView(usage)
    if (view === null) {
      contextRow.hidden = true
      hideContextTip()
      return
    }
    contextRow.hidden = false
    contextRow.dataset.tone = view.tone
    contextText.textContent = view.full
      ? t('composer_context_full', { used: view.usedText, budget: view.budgetText })
      : t('composer_context', { used: view.usedText, budget: view.budgetText })
    if (!contextTip.hidden) buildContextTip(usage)
  }

  function scheduleContextTip() {
    const usage = state.usage[threadKeyOf(state.activeThread)]
    if (!isRecord(usage)) return
    if (contextTipTimer !== null) clearTimeout(contextTipTimer)
    contextTipTimer = setTimeout(() => {
      contextTipTimer = null
      buildContextTip(usage)
      if (contextTip.childElementCount === 0) return
      contextTip.hidden = false
    }, TOOLTIP_DELAY_MS)
  }

  function hideContextTip() {
    if (contextTipTimer !== null) {
      clearTimeout(contextTipTimer)
      contextTipTimer = null
    }
    contextTip.hidden = true
  }

  contextRow.addEventListener('mouseenter', scheduleContextTip)
  contextRow.addEventListener('mouseleave', hideContextTip)
  contextRow.addEventListener('focus', scheduleContextTip)
  contextRow.addEventListener('blur', hideContextTip)

  function renderError() {
    const failed = state.reasoning.status === 'failed'
    reasoningError.hidden = !failed
    reasoningErrorText.textContent = failed ? t('composer_reasoning_failed') : ''
    sendError.hidden = state.error === null
    sendError.textContent = state.error !== null ? messageText(table, state.error) : ''
  }

  function renderAll() {
    renderToolbar()
    renderAttachments()
    renderPending()
    renderContext()
    renderSend()
    renderError()
  }

  // ---- 事件（自己服务的 SSE；按线程过滤） ----

  const closeEvents = connectEvents((record) => {
    const payload = isRecord(record.payload) ? record.payload : {}
    if (record.topic === 'run.started') {
      const tracked = runs.trackRunStarted(tracking, runIdOf(payload), runKeyOf(payload))
      tracking = tracked.state
      if (tracked.turnStarted && matchesThread(payload.thread, state.activeThread)) renderSend()
      return
    }
    if (record.topic === 'run.finished') {
      const key = runKeyOf(payload)
      const tracked = runs.trackRunFinished(tracking, runIdOf(payload), key)
      tracking = tracked.state
      // 槽写 run 落账：此刻才触发 `chat.send`（此时它才读得到新槽）。
      if (tracked.kind === 'write') {
        clearWriteTimer(key)
        dispatchSend(key)
        return
      }
      // 回合 run 结束：按线程键清空（后台线程也要清），再续发该线程队列。
      if (tracked.kind === 'turn') {
        if (matchesThread(payload.thread, state.activeThread)) renderSend()
        void continueQueue(key)
      }
      return
    }
    if (record.topic === 'context.assembled') {
      if (!matchesThread(payload.thread, state.activeThread)) return
      state.usage = { ...state.usage, [runKeyOf(payload)]: payload }
      renderContext()
    }
  })

  // ---- uiState（跨 slot 视图态：active_thread） ----

  function applyActiveThread(value) {
    state.activeThread = typeof value === 'string' && value.length > 0 ? value : null
    renderPending()
    renderContext()
    renderSend()
  }

  const offThread =
    isRecord(api) && isRecord(api.uiState) && typeof api.uiState.subscribe === 'function'
      ? api.uiState.subscribe('active_thread', applyActiveThread)
      : () => {}

  const initialThread =
    isRecord(api) && isRecord(api.uiState) && typeof api.uiState.get === 'function'
      ? api.uiState.get('active_thread')
      : undefined
  state.activeThread =
    typeof initialThread === 'string' && initialThread.length > 0 ? initialThread : null

  // ---- 启动 ----

  autoGrow()
  await loadConfig()
  if (!disposed) renderAll()

  return {
    unmount() {
      disposed = true
      offThread()
      closeEvents()
      hideContextTip()
      closeOverlays(false)
      for (const timer of writeTimers.values()) clearTimeout(timer)
      writeTimers.clear()
      doc.removeEventListener('keydown', onDocKeydown)
      root.replaceChildren()
    },
  }
}
