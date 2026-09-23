// `ui-chat` 子应用入口：`mount(root, api) -> {unmount()}`（slot 应用契约）。
// 本模块只编排：DOM 骨架、滚动 / 窗口化、事件订阅（自己服务的 `/events`）、线程切换。
// 渲染源 = 入站命令 `chat.history` 的全量消息；写与命令一律经本插件服务的入站面。

import { ensureStyles } from './styles.js'
import { createRenderers } from './render-dom.js'
import { el, icon, iconButton, clear } from './dom.js'
import { formatText, loadMessages, lookupMessage, UI_TEXT } from './messages.js'
import {
  dataChangeTarget,
  finishesCurrentStream,
  isPeriodicRun,
  loadConversation,
  matchesThread,
  messageText,
  threadKind,
} from './history-model.js'
import { partViewModel } from './render-parts.js'
import { toolCardViewModel } from './tool-card.js'
import { buildDateSeparators } from './date-sep.js'
import {
  createNewMessageState,
  dismissNew,
  hasOlder,
  initialWindow,
  olderWindow,
  onNewContent,
  pillLabel,
  shouldWindow,
} from './windowing.js'
import { createLightboxState } from './lightbox.js'
import { groupViewModel } from './group.js'
import { workflowViewModel, statusIcon, statusText } from './workflow.js'
import { createCopyState, COPY_HOLD_MS } from './copy.js'

export const contract = '1'

const BASE = new URL('.', import.meta.url)

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

  const state = {
    history: null,
    conversation: null,
    messages: [],
    kind: 'main',
    viewThread: null,
    window: { start: 0, end: 0 },
    atBottom: true,
    loading: false,
    reloading: false,
    loadingNote: false,
    loadingOlder: false,
    finalizeAnnounce: false,
    error: null,
    newMsg: createNewMessageState(),
    stream: null,
    liveTools: new Map(),
    group: { unreadIds: new Set(), anchorIndex: -1, anchorEl: null },
    workflowStep: null,
    connected: typeof api.events?.connected === 'function' ? api.events.connected() : false,
  }

  let streamTimer = null
  let announceTimer = null
  let loadingTimer = null
  let disposed = false

  const assetUrl = (source) => {
    if (source === null || source === undefined) return null
    if (source.kind === 'ext') return source.url
    const url = new URL('api/asset', BASE)
    url.searchParams.set('sha256', source.sha256)
    if (typeof source.mime === 'string' && source.mime.length > 0) url.searchParams.set('mime', source.mime)
    return url.href
  }

  // ---- DOM 骨架 ----

  const statusBar = el(doc, 'div', { class: 'chat-status', attrs: { hidden: true } }, [
    el(doc, 'div', { class: 'chat-breathe' }),
  ])
  const list = el(doc, 'div', { class: 'chat-list' })
  const liveHost = el(doc, 'div', { class: 'chat-live' })
  const scroll = el(doc, 'div', { class: 'chat-scroll' }, [list, liveHost])
  const pill = el(doc, 'button', {
    class: 'chat-pill',
    attrs: { type: 'button', hidden: true, 'aria-live': 'polite', 'aria-atomic': 'true' },
  })
  const liveRegion = el(doc, 'div', { class: 'chat-sr', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } })
  const container = el(doc, 'div', { class: 'chat-root' }, [statusBar, scroll, pill, liveRegion])
  root.replaceChildren(container)

  const renderers = createRenderers({
    doc,
    assetUrl,
    table,
    onQuestionSubmit: (vm, answers) => submitQuestion(vm, answers),
    onOpenLightbox: (source, alt, thumb) => openLightbox(source, alt, thumb),
    onOpenVideo: (source) => openVideo(source),
    onCopy: (button, def) => wireCopy(button, def),
    onRetry: () => retryTurn(),
  })

  function announce(text) {
    liveRegion.textContent = ''
    if (announceTimer !== null) clearTimeout(announceTimer)
    announceTimer = setTimeout(() => {
      liveRegion.textContent = text
      announceTimer = setTimeout(() => {
        liveRegion.textContent = ''
      }, 1500)
    }, 0)
  }

  function renderStatus() {
    statusBar.hidden = !state.loading && !state.reloading
  }

  // ---- 渲染 ----

  function render() {
    clear(list)
    if (state.error !== null) {
      list.appendChild(renderers.errorBar(state.error, () => loadHistory(state.viewThread)))
      updatePill()
      return
    }
    if (state.loading) {
      list.appendChild(
        el(doc, 'div', { class: 'chat-block-loading' }, [
          el(doc, 'div', { class: 'chat-breathe' }),
          el(doc, 'div', { class: 'chat-workflow-meta', hidden: state.loadingNote !== true, text: lookupMessage(table, 'chat_loading').body }),
        ]),
      )
      updatePill()
      return
    }
    if (state.kind === 'group') renderGroup()
    else if (state.kind === 'workflow') renderWorkflow()
    else renderConversation()
    updatePill()
  }

  function renderConversation() {
    if (state.kind === 'subagent') list.appendChild(subagentHeader())
    if (state.messages.length === 0) {
      list.appendChild(
        el(doc, 'div', { class: 'chat-empty' }, [
          el(doc, 'div', { class: 'chat-empty-title', text: lookupMessage(table, 'chat_empty_title').body }),
          el(doc, 'div', { class: 'chat-empty-hint', text: lookupMessage(table, 'chat_empty_hint').body }),
        ]),
      )
      return
    }
    const windowed = shouldWindow(state.messages.length)
    if (windowed) {
      if (hasOlder(state.window)) {
        list.appendChild(el(doc, 'div', { class: 'chat-top-notice' }, [el(doc, 'div', { class: 'chat-breathe chat-breathe-inline' })]))
      } else {
        list.appendChild(el(doc, 'div', { class: 'chat-date', text: lookupMessage(table, 'chat_no_more').body }))
      }
    }
    const slice = state.messages.slice(state.window.start, state.window.end)
    const lastEntry = state.messages.length > 0 ? state.messages[state.messages.length - 1] : null
    for (const item of buildDateSeparators(slice, new Date())) {
      if (item.type === 'date') {
        list.appendChild(el(doc, 'div', { class: 'chat-date', text: item.label }))
        continue
      }
      const node = renderers.message(item.entry)
      if (state.finalizeAnnounce && item.entry === lastEntry && isAssistantEntry(item.entry)) {
        // 回合定稿：对整条助手消息 aria-live 一次性播报（不逐字播报）
        node.setAttribute('aria-live', 'polite')
      }
      list.appendChild(node)
    }
    state.finalizeAnnounce = false
  }

  function isAssistantEntry(entry) {
    const def = entry !== null && typeof entry === 'object' ? entry.def : null
    const role = def !== null && typeof def.role === 'string' ? def.role : 'assistant'
    return role !== 'user' && role !== 'system'
  }

  function subagentHeader() {
    const conversation = state.conversation
    const refs = state.history !== null && typeof state.history.refs === 'object' && state.history.refs !== null ? state.history.refs : {}
    const agentDef = conversation !== null && conversation.agent !== undefined && conversation.agent !== null ? conversation.agent.def : null
    const agentName = typeof agentDef === 'string' && typeof refs[agentDef] === 'object' && refs[agentDef] !== null && typeof refs[agentDef].name === 'string' ? refs[agentDef].name : UI_TEXT.chat_subagent
    const parentDef = conversation !== null && conversation.parent !== undefined && conversation.parent !== null ? conversation.parent.def : null
    let parentName = ''
    if (typeof parentDef === 'string') {
      const list0 = Array.isArray(state.history?.body?.conversations) ? state.history.body.conversations : []
      const parent = list0.find((item) => item.id === parentDef || item.id === parentDef)
      parentName = parent !== undefined && typeof parent.title === 'string' ? parent.title : parentDef
    }
    const text = parentName.length > 0 ? `${agentName} · 由 ${parentName} 触发` : agentName
    return el(doc, 'div', { class: 'chat-subagent-head', text })
  }

  function renderGroup() {
    const refs = state.history !== null && typeof state.history.refs === 'object' && state.history.refs !== null ? state.history.refs : {}
    const vm = groupViewModel({
      conversation: state.conversation,
      messages: state.messages,
      refs,
      streaming: state.stream !== null,
      unreadIds: state.group.unreadIds,
    })
    state.group.anchorIndex = vm.anchorIndex
    state.group.anchorEl = null
    vm.items.forEach((item, index) => {
      if (index === vm.anchorIndex && vm.anchorIndex >= 0) {
        const anchor = el(doc, 'div', { class: 'chat-anchor', text: lookupMessage(table, 'chat_new_messages').body })
        state.group.anchorEl = anchor
        list.appendChild(anchor)
      }
      if (item.isMe) {
        list.appendChild(
          el(doc, 'div', { class: 'chat-msg chat-msg-user' }, [
            el(doc, 'div', { class: 'chat-bubble-user', text: item.text }),
          ]),
        )
        return
      }
      const avatar = el(doc, 'div', { class: 'chat-group-avatar', dataset: { current: String(item.current) }, text: item.initial })
      const body = el(doc, 'div', { class: 'chat-group-body' }, [
        item.showName ? el(doc, 'div', { class: 'chat-group-name', text: item.speakerName }) : null,
        el(doc, 'div', { class: 'chat-group-bubble' }, [renderItemNode(item)]),
      ])
      list.appendChild(el(doc, 'div', { class: 'chat-group-item' }, [avatar, body]))
    })
  }

  function renderItemNode(item) {
    const def = item.def
    const items = Array.isArray(def?.parts) && def.parts.length > 0 ? def.parts : null
    if (items === null) {
      const node = el(doc, 'div', { class: 'chat-md' })
      renderers.setMarkdown(doc, node, item.text)
      return node
    }
    const wrapper = el(doc, 'div', {})
    for (const part of items) wrapper.appendChild(renderers.renderItem(partViewModel(part)))
    return wrapper
  }

  function renderWorkflow() {
    const refs = state.history !== null && typeof state.history.refs === 'object' && state.history.refs !== null ? state.history.refs : {}
    const graphRef = state.conversation !== null && state.conversation.workflow !== undefined && state.conversation.workflow !== null ? state.conversation.workflow.graph : null
    const graphDef = graphRef !== null && typeof graphRef.def === 'string' ? refs[graphRef.def] : null
    const vm = workflowViewModel({ conversation: state.conversation, graphDef, step: state.workflowStep })
    const fill = el(doc, 'div', { class: 'chat-workflow-fill' })
    if (vm.total > 0) fill.style.width = `${Math.min(100, Math.round(((vm.index + 1) / vm.total) * 100))}%`
    const card = el(doc, 'div', { class: 'chat-workflow' }, [
      el(doc, 'div', { class: 'chat-workflow-title', text: vm.title }),
      el(doc, 'div', { class: 'chat-workflow-meta' }, [
        el(doc, 'span', { text: vm.total > 0 ? formatText('chat_step_progress', { index: vm.index + 1, total: vm.total }) : '' }),
        el(doc, 'span', { text: ` · ${statusText(vm.status)}` }),
      ]),
      el(doc, 'div', { class: 'chat-workflow-track' }, [fill]),
    ])
    const details = el(doc, 'details', {}, [el(doc, 'summary', { text: lookupMessage(table, 'chat_node_list').body })])
    for (const node of vm.nodes) {
      details.appendChild(
        el(doc, 'div', { class: 'chat-workflow-node', dataset: { status: node.status } }, [
          icon(doc, statusIcon(node.status), 16),
          el(doc, 'span', { text: `#${node.index} ${node.name}` }),
          el(doc, 'span', { class: 'chat-workflow-meta', text: node.impl }),
          el(doc, 'span', { text: statusText(node.status) }),
        ]),
      )
    }
    card.appendChild(details)
    if (vm.rejectCode !== null) {
      const retry = el(doc, 'button', { class: 'chat-btn', text: lookupMessage(table, 'chat_retry').body })
      retry.addEventListener('click', () => retryTurn())
      card.appendChild(
        el(doc, 'div', { class: 'chat-error' }, [
          el(doc, 'div', { text: lookupMessage(table, vm.rejectCode).body }),
          retry,
        ]),
      )
    }
    list.appendChild(card)
  }

  // ---- 数据 ----

  async function loadHistory(conversationId, options = {}) {
    if (disposed) return
    const resetView = options.resetView !== false
    // 块级加载只用于首屏（尚无任何历史）；其余一律 quiet reload：保留 state.messages，
    // 只在顶部显示细呼吸条（statusBar），不遮消息、不整屏遮罩。
    const firstScreen = state.history === null && state.messages.length === 0
    state.error = null
    if (firstScreen) {
      state.loading = true
      state.loadingNote = false
    } else {
      state.reloading = true
    }
    renderStatus()
    render()
    if (firstScreen) {
      if (loadingTimer !== null) clearTimeout(loadingTimer)
      loadingTimer = setTimeout(() => {
        if (state.loading) {
          state.loadingNote = true
          render()
        }
      }, 8000)
    }
    const args = typeof conversationId === 'string' && conversationId.length > 0 ? { conversation: conversationId } : {}
    const result = await postJson('api/command', { name: 'chat.history', args, thread: state.viewThread })
    if (disposed) return
    if (loadingTimer !== null) clearTimeout(loadingTimer)
    loadingTimer = null
    state.loading = false
    state.reloading = false
    state.loadingNote = false
    renderStatus()
    if (result.ok !== true) {
      state.error = { code: typeof result.code === 'string' ? result.code : 'unknown', message: typeof result.message === 'string' ? result.message : '' }
      render()
      return
    }
    state.history = result.value
    const loaded = loadConversation(state.history, conversationId)
    state.conversation = loaded.conversation
    state.messages = loaded.messages
    state.kind = threadKind(loaded.conversation)
    const base = initialWindow(state.messages.length)
    state.window = resetView ? base : { start: Math.min(state.window.start, base.start), end: state.messages.length }
    if (resetView) {
      state.group.unreadIds = new Set()
      state.workflowStep = null
    }
    state.finalizeAnnounce = options.announceFinal === true
    render()
    if (resetView) scrollToBottom()
  }

  async function submitQuestion(vm, answers) {
    if (vm.itemId === null) return { ok: false, code: 'bad_args', message: 'missing question id' }
    return postJson('api/question/answer', { id: vm.itemId, answers, thread: state.viewThread })
  }

  async function retryTurn() {
    const result = await postJson('api/command', { name: 'chat.send', args: null, thread: state.viewThread })
    if (result.ok !== true) showTransientError(typeof result.code === 'string' ? result.code : 'unknown')
  }

  function showTransientError(code) {
    liveHost.appendChild(renderers.errorBar({ code }, () => retryTurn()))
  }

  // ---- 流式 ----

  function beginStream(run, thread) {
    if (state.stream !== null) finishStream('replaced')
    const textEl = el(doc, 'div', { class: 'chat-md chat-stream-text' })
    const breathing = el(doc, 'div', { class: 'chat-breathe' })
    const note = el(doc, 'div', { class: 'chat-workflow-meta', hidden: true, text: lookupMessage(table, 'chat_generating').body })
    const body = el(doc, 'div', { class: 'chat-msg chat-msg-assistant', attrs: { 'aria-busy': 'true' } }, [breathing, note, textEl])
    liveHost.appendChild(body)
    state.stream = { run, thread, text: '', firstToken: false, cancelled: false, el: body, textEl, breathing, note }
    if (streamTimer !== null) clearTimeout(streamTimer)
    streamTimer = setTimeout(() => {
      if (state.stream !== null && !state.stream.firstToken) {
        state.stream.note.hidden = false
      }
    }, 8000)
  }

  function appendDelta(payload) {
    if (state.stream === null) beginStream(payload.run ?? null, payload.thread ?? null)
    const text = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : typeof payload.chunk === 'string' ? payload.chunk : ''
    if (text.length === 0) return
    const stream = state.stream
    if (!stream.firstToken) {
      stream.firstToken = true
      stream.breathing.hidden = true
      stream.note.hidden = true
      if (streamTimer !== null) clearTimeout(streamTimer)
    }
    stream.text += text
    stream.textEl.textContent = stream.text
    stream.textEl.appendChild(el(doc, 'span', { class: 'chat-cursor' }))
    afterAppend()
  }

  function finishStream(status) {
    const stream = state.stream
    if (stream === null) return
    if (streamTimer !== null) clearTimeout(streamTimer)
    streamTimer = null
    state.stream = null
    stream.el.setAttribute('aria-busy', 'false')
    if (status === 'cancelled') {
      stream.breathing.hidden = true
      stream.note.hidden = false
      stream.note.textContent = lookupMessage(table, 'chat_cancelled').body
      return
    }
    stream.el.remove()
  }

  // ---- live 工具卡 ----

  function openLiveTool(payload) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
    const vm = {
      type: 'tool',
      callId,
      tool: typeof payload.tool === 'string' ? payload.tool : '',
      render: typeof payload.render === 'object' && payload.render !== null ? payload.render : null,
      args: payload.args ?? null,
      result: null,
    }
    const card = renderers.toolCard(toolCardViewModel(vm))
    const detail = card.querySelector('.chat-tool-detail')
    if (detail !== null) {
      detail.hidden = false
      const terminal = el(doc, 'div', { class: 'chat-terminal' }, [el(doc, 'div', { class: 'chat-terminal-stdout' })])
      detail.replaceChildren(terminal)
    }
    liveHost.appendChild(card)
    state.liveTools.set(callId, { card, detail })
    afterAppend()
  }

  function appendToolDelta(payload) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
    const entry = state.liveTools.get(callId)
    if (entry === undefined) return
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : typeof payload.text === 'string' ? payload.text : ''
    const stdout = entry.detail.querySelector('.chat-terminal-stdout')
    if (stdout !== null) stdout.textContent += chunk
    afterAppend()
  }

  function closeLiveTool(payload) {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
    const entry = state.liveTools.get(callId)
    if (entry === undefined) return
    entry.card.dataset.live = 'done'
  }

  function clearLive() {
    state.liveTools.clear()
    clear(liveHost)
  }

  // ---- 滚动 / 窗口化 ----

  function isAtBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24
  }

  function scrollToBottom() {
    scroll.scrollTop = scroll.scrollHeight
    state.atBottom = true
    state.newMsg = dismissNew()
    updatePill()
  }

  function updatePill() {
    if (state.atBottom) {
      pill.hidden = true
      return
    }
    pill.hidden = false
    pill.textContent = state.newMsg.count > 0 ? pillLabel(state.newMsg.count) : lookupMessage(table, 'chat_pill_more').body
  }

  function afterAppend() {
    if (isAtBottom()) {
      scrollToBottom()
    } else {
      state.newMsg = onNewContent(state.newMsg, false)
      updatePill()
    }
  }

  function loadOlder() {
    if (state.loadingOlder || !shouldWindow(state.messages.length) || !hasOlder(state.window)) return
    state.loadingOlder = true
    const previousHeight = scroll.scrollHeight
    state.window = olderWindow(state.window)
    render()
    scroll.scrollTop += scroll.scrollHeight - previousHeight
    state.loadingOlder = false
  }

  scroll.addEventListener('scroll', () => {
    state.atBottom = isAtBottom()
    if (state.atBottom) state.newMsg = dismissNew()
    updatePill()
    if (state.group.anchorEl !== null && state.group.anchorEl !== undefined) {
      const anchor = state.group.anchorEl
      if (scroll.scrollTop > anchor.offsetTop + 40) anchor.style.opacity = '0'
    }
    if (scroll.scrollTop < 32) loadOlder()
  })
  pill.addEventListener('click', () => {
    state.atBottom = true
    state.newMsg = dismissNew()
    scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' })
    updatePill()
  })

  // ---- lightbox / 视频 ----

  function openOverlay(content, returnFocus) {
    const overlay = el(doc, 'div', { class: 'chat-lightbox', attrs: { role: 'dialog', 'aria-modal': 'true' } })
    const closeButton = iconButton(doc, 'x', lookupMessage(table, 'chat_close').body, () => close())
    overlay.appendChild(closeButton)
    overlay.appendChild(content)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close()
    })
    const onKey = (event) => {
      if (event.key === 'Escape') {
        close()
        return
      }
      if (event.key !== 'Tab') return
      // 焦点陷阱：Tab 在 overlay 内循环，焦点不滞留背景。
      const focusables = overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = doc.activeElement
      if (event.shiftKey) {
        if (active === first || !overlay.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !overlay.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    doc.addEventListener('keydown', onKey)
    const previousOverflow = doc.body.style.overflow
    doc.body.style.overflow = 'hidden'
    doc.body.appendChild(overlay)
    closeButton.focus()
    function close() {
      doc.removeEventListener('keydown', onKey)
      doc.body.style.overflow = previousOverflow
      overlay.remove()
      if (returnFocus !== null && typeof returnFocus.focus === 'function') returnFocus.focus()
    }
    return close
  }

  function openLightbox(source, alt, thumb) {
    const url = assetUrl(source)
    if (url === null) return
    const machine = createLightboxState()
    machine.open(url, alt)
    const img = el(doc, 'img', { class: 'chat-lightbox-img', attrs: { src: url, alt } })
    const apply = () => {
      const snapshot = machine.get()
      img.style.transform = `translate(${snapshot.tx}px, ${snapshot.ty}px) scale(${snapshot.scale})`
    }
    img.addEventListener('wheel', (event) => {
      event.preventDefault()
      const snapshot = machine.get()
      machine.zoomAt(snapshot.scale * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX - window.innerWidth / 2, event.clientY - window.innerHeight / 2)
      apply()
    })
    img.addEventListener('dblclick', (event) => {
      machine.toggleDoubleClick(event.clientX - window.innerWidth / 2, event.clientY - window.innerHeight / 2)
      apply()
    })
    let dragging = false
    let lastX = 0
    let lastY = 0
    img.addEventListener('pointerdown', (event) => {
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      img.dataset.dragging = 'true'
      img.setPointerCapture?.(event.pointerId)
    })
    img.addEventListener('pointermove', (event) => {
      if (!dragging) return
      machine.pan(event.clientX - lastX, event.clientY - lastY)
      lastX = event.clientX
      lastY = event.clientY
      apply()
    })
    const stop = () => {
      dragging = false
      img.dataset.dragging = 'false'
    }
    img.addEventListener('pointerup', stop)
    img.addEventListener('pointercancel', stop)
    openOverlay(img, thumb)
  }

  function openVideo(source) {
    const url = assetUrl(source)
    if (url === null) return
    const video = el(doc, 'video', { class: 'chat-lightbox-img', attrs: { src: url, controls: true, preload: 'metadata' } })
    openOverlay(video, null)
  }

  // ---- 复制 / 重试脚注 ----

  function wireCopy(button, def) {
    const machine = createCopyState()
    const use = button.querySelector('use')
    const setIcon = (name) => {
      if (use !== null) use.setAttribute('href', `/assets/icons.v2.svg#${name}`)
    }
    button.addEventListener('click', async () => {
      const text = messageText(def)
      try {
        if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
          throw new Error('clipboard unavailable')
        }
        await navigator.clipboard.writeText(text)
        machine.success()
        button.dataset.copy = 'check'
        setIcon('check')
        announce(lookupMessage(table, 'chat_copied').body)
        setTimeout(() => {
          machine.tick()
          button.dataset.copy = 'idle'
          setIcon('copy')
        }, COPY_HOLD_MS)
      } catch {
        machine.fail()
        button.dataset.copy = 'error'
        setIcon('alert-circle')
        const footnoteNode = button.parentElement
        if (footnoteNode !== null) {
          footnoteNode.appendChild(el(doc, 'span', { class: 'chat-danger-inline', text: lookupMessage(table, 'chat_copy_failed').body }))
        }
      }
    })
  }

  // ---- 事件（壳事件总线） ----

  function connectEvents() {
    return typeof api.events?.onAny === 'function' ? api.events.onAny(handleRecord) : () => {}
  }

  function handleRecord(record) {
    const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {}
    if (record.topic === 'shell.state') {
      const wasConnected = state.connected
      state.connected = payload.connected === true
      // 首屏若在入站连接建立前拉过历史：连上后自动补拉一次（禁静默无限等待）。
      if (state.connected && !wasConnected && state.error !== null && state.error.code === 'ui_unreachable') {
        void loadHistory(state.viewThread)
      }
      return
    }
    if (record.topic === 'model.delta') {
      if (matchesThread(payload.thread, state.viewThread)) appendDelta(payload)
      return
    }
    if (record.topic === 'tool.start') {
      if (matchesThread(payload.thread, state.viewThread)) openLiveTool(payload)
      return
    }
    if (record.topic === 'tool.delta') {
      if (matchesThread(payload.thread, state.viewThread)) appendToolDelta(payload)
      return
    }
    if (record.topic === 'tool.end') {
      if (matchesThread(payload.thread, state.viewThread)) closeLiveTool(payload)
      return
    }
    if (record.topic === 'run.started') {
      // 周期 run 不是对话回合：不建流；其余匹配线程的 run 可起流。
      if (isPeriodicRun(payload.origin)) return
      if (matchesThread(payload.thread, state.viewThread)) beginStream(payload.run ?? null, payload.thread ?? null)
      return
    }
    if (record.topic === 'run.finished') {
      // 只有本轮流式的 run 终局才收束并重拉历史；其它 run 的终局忽略（否则会被任意 run 反复触发重拉）。
      if (!finishesCurrentStream(state.stream, payload.run)) return
      if (payload.status === 'cancelled') {
        finishStream('cancelled')
        return
      }
      finishStream('done')
      clearLive()
      void loadHistory(state.viewThread, { resetView: false, announceFinal: true })
      return
    }
    if (record.topic === 'group.message') {
      if (!matchesThread(dataChangeTarget(payload), state.viewThread)) return
      const id = typeof payload.id === 'string' ? payload.id : typeof payload.message === 'string' ? payload.message : ''
      if (id.length > 0) state.group.unreadIds.add(id)
      void loadHistory(state.viewThread, { resetView: false })
      return
    }
    if (record.topic === 'workflow.step') {
      if (!matchesThread(dataChangeTarget(payload), state.viewThread)) return
      state.workflowStep = payload
      render()
      return
    }
    if (record.topic === 'thread.updated' || record.topic === 'thread.opened' || record.topic === 'thread.closed') {
      if (!matchesThread(dataChangeTarget(payload), state.viewThread)) return
      void loadHistory(state.viewThread, { resetView: false })
    }
  }

  // ---- uiState（线程切换） ----

  const offThread = typeof api.uiState?.subscribe === 'function'
    ? api.uiState.subscribe('active_thread', (value) => {
        state.viewThread = typeof value === 'string' && value.length > 0 ? value : null
        list.style.opacity = '0'
        void loadHistory(state.viewThread).then(() => {
          list.style.opacity = '1'
        })
      })
    : () => {}

  const initialThread = typeof api.uiState?.get === 'function' ? api.uiState.get('active_thread') : undefined
  state.viewThread = typeof initialThread === 'string' && initialThread.length > 0 ? initialThread : null

  const closeEvents = connectEvents()
  await loadHistory(state.viewThread)

  return {
    unmount() {
      disposed = true
      offThread()
      closeEvents()
      if (streamTimer !== null) clearTimeout(streamTimer)
      if (announceTimer !== null) clearTimeout(announceTimer)
      if (loadingTimer !== null) clearTimeout(loadingTimer)
      root.replaceChildren()
    },
  }
}
