// 壳页面脚本：S0 启动 → 按挂载表装载各 slot 子应用；事件订阅（/events）、全局 toast、
// 跨 slot 视图状态（uiState）、主题、S6 断线横幅与静态资源降级。
// 与子应用同源、不共享运行时；壳只做布局 / 路由 / 桥接，不认识业务。

import { createUiState } from './ui-state.js'
import { createToastQueue, roleForTone } from './toast.js'
import { normalizeThemePref, resolveTheme } from './theme.js'
import { deriveBootMode } from './boot-mode.js'

const CONTRACT_VERSION = '1'
const BOOTSTRAP =
  typeof window.__CHRONO_SHELL__ === 'object' && window.__CHRONO_SHELL__ !== null
    ? window.__CHRONO_SHELL__
    : { mounts: [], headless: [], theme: 'system' }

/** 文案表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
const FALLBACK_MESSAGES = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。', action: '重试' },
  ui_boot_failed: { title: '界面加载失败', body: '这个界面未能启动。', action: '重试' },
  ui_version_mismatch: { title: '界面版本不符', body: '界面与壳的契约版本不一致。', action: '重试' },
  shell_tokens_fallback: { title: '样式降级', body: '设计 token 未能加载，已用最小样式兜底。' },
  shell_toast_close: { title: '关闭提示', body: '关闭' },
}

let messageTable = FALLBACK_MESSAGES

function msg(code) {
  const entry = messageTable[code]
  if (entry !== undefined) return entry
  const unknown = messageTable.unknown ?? FALLBACK_MESSAGES.unknown
  return { ...unknown, body: unknown.body.replace('{code}', code) }
}

async function loadMessages() {
  try {
    const response = await fetch('/assets/messages.v1.json')
    if (!response.ok) return
    const parsed = await response.json()
    if (parsed !== null && typeof parsed === 'object') {
      const table = {}
      for (const [code, entry] of Object.entries(parsed)) {
        if (code === 'locale') continue
        if (entry !== null && typeof entry === 'object' && typeof entry.title === 'string') {
          table[code] = entry
        }
      }
      if (Object.keys(table).length > 0) messageTable = table
    }
  } catch {
    // 保留内置最小表
  }
}

const uiState = createUiState()
const toastQueue = createToastQueue()
const toastRoot = document.getElementById('shell-toasts')
const banner = document.getElementById('shell-banner')
const bannerText = document.getElementById('shell-banner-text')
const bannerRetry = document.getElementById('shell-banner-retry')
const splash = document.getElementById('shell-splash')

const themeListeners = new Set()
let themePref = normalizeThemePref(BOOTSTRAP.theme)
let themeTouched = false

function systemPrefersDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolveTheme(themePref, systemPrefersDark()))
}

applyTheme()
if (window.matchMedia) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (themePref === 'system') applyTheme()
  }
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange)
  else if (typeof media.addListener === 'function') media.addListener(onChange)
}

// ---- 入站桥（同源 /api） ----

async function postJson(path, body) {
  try {
    const response = await fetch(path, {
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

const api = {
  tokens: {
    css: '/assets/tokens.v1.css',
    icons: '/assets/icons.v2.svg',
    messages: '/assets/messages.v1.json',
  },
  theme: {
    get: () => themePref,
    set: async (pref) => {
      themePref = normalizeThemePref(pref)
      themeTouched = true
      applyTheme()
      for (const callback of [...themeListeners]) callback(themePref)
      return postJson('/api/theme', { theme: themePref })
    },
    subscribe: (callback) => {
      themeListeners.add(callback)
      return () => themeListeners.delete(callback)
    },
  },
  navigate: (path) => {
    if (typeof path !== 'string' || path.length === 0) return
    window.history.pushState({ path }, '', path)
    window.dispatchEvent(new CustomEvent('shell:navigate', { detail: { path } }))
  },
  submit: (directive, options) => {
    const body = { thread: options && options.thread }
    if (Array.isArray(directive)) body.directives = directive
    else body.directive = directive
    return postJson('/api/submit', body)
  },
  command: (name, args, options) =>
    postJson('/api/command', { name, args: args ?? null, thread: options && options.thread }),
  cancel: (run) => postJson('/api/cancel', { run }),
  asset: {
    put: (mime, bytes) => postJson('/api/asset', { mime, bytes }),
    get: async (sha256) => {
      try {
        const response = await fetch(`/api/asset?sha256=${encodeURIComponent(sha256)}`)
        return await response.json()
      } catch (err) {
        return { ok: false, code: 'ui_unreachable', message: String(err) }
      }
    },
  },
  events: {
    subscribe: (topic, callback) => subscribeTopic(topic, callback),
    onAny: (callback) => subscribeAny(callback),
    connected: () => hostConnected,
  },
  toast: (input) => {
    const id = toastQueue.enqueue(input ?? {})
    renderToasts()
    return id
  },
  uiState,
}

// ---- 事件流（宿主事件原样重播 + 壳合成事件） ----

const topicListeners = new Map()
const anyListeners = new Set()
let hostConnected = false
let sawDisconnect = false

function subscribeTopic(topic, callback) {
  let subs = topicListeners.get(topic)
  if (subs === undefined) {
    subs = new Set()
    topicListeners.set(topic, subs)
  }
  subs.add(callback)
  return () => subs.delete(callback)
}

function subscribeAny(callback) {
  anyListeners.add(callback)
  return () => anyListeners.delete(callback)
}

function dispatchEvent(record) {
  for (const callback of [...anyListeners]) {
    try {
      callback(record)
    } catch {
      // 单个订阅者抛错不影响其余
    }
  }
  const subs = topicListeners.get(record.topic)
  if (subs === undefined) return
  for (const callback of [...subs]) {
    try {
      callback(record.payload, record)
    } catch {
      // 同上
    }
  }
}

function handleShellState(payload) {
  if (payload === null || typeof payload !== 'object') return
  hostConnected = payload.connected === true
  if (!themeTouched && typeof payload.theme === 'string') {
    const pref = normalizeThemePref(payload.theme)
    if (pref !== themePref) {
      themePref = pref
      applyTheme()
    }
  }
  if (hostConnected) {
    hideBanner()
    if (sawDisconnect) {
      sawDisconnect = false
      toastQueue.enqueue({ tone: 'success', text: msg('shell_reconnected').body })
      renderToasts()
    }
    void detectBootMode()
  } else {
    showBanner()
  }
}

function connectEvents() {
  let source
  try {
    source = new EventSource('/events')
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
    if (record === null || typeof record !== 'object') return
    if (record.impl === 'shell' && record.topic === 'shell.state') {
      handleShellState(record.payload)
      dispatchEvent(record)
      return
    }
    if (record.impl === 'shell' && record.topic === 'shell.disconnected') {
      sawDisconnect = true
      showBanner()
    }
    if (record.impl === 'shell' && record.topic === 'shell.reconnected') {
      hideBanner()
    }
    dispatchEvent(record)
  }
  source.onerror = () => {
    // 壳自身 SSE 断开：宿主连接态由 shell.state 决定，这里只保活重连（EventSource 自带）
  }
}

// ---- S6 断线横幅 ----

function showBanner() {
  if (banner === null) return
  const entry = msg('shell_disconnected')
  if (bannerText !== null) bannerText.textContent = `${entry.title}，${entry.body}`
  if (bannerRetry !== null) bannerRetry.textContent = entry.action ?? msg('ui_unreachable').action ?? ''
  banner.hidden = false
  document.body.classList.add('shell-disconnected')
}

function hideBanner() {
  if (banner === null) return
  banner.hidden = true
  document.body.classList.remove('shell-disconnected')
}

if (bannerRetry !== null) {
  bannerRetry.addEventListener('click', async () => {
    bannerRetry.disabled = true
    try {
      const response = await fetch('/api/state')
      const state = await response.json()
      if (state && state.connected === true) hideBanner()
      else showBanner()
    } catch {
      showBanner()
    } finally {
      bannerRetry.disabled = false
    }
  })
}

// ---- 全局 toast 渲染 ----

function renderToasts() {
  if (toastRoot === null) return
  // DOM 序兜底：toast 与 lightbox 同为 --z-70，把 toast 容器移到
  // <body> 末端，恒晚于子应用内后插入的 lightbox，确保 toast 在其之上可见。
  document.body.appendChild(toastRoot)
  const visible = toastQueue.visible()
  toastRoot.replaceChildren(
    ...visible.map((item) => {
      const card = document.createElement('div')
      card.className = 'shell-toast'
      card.dataset.tone = item.tone
      card.setAttribute('role', roleForTone(item.tone))
      card.addEventListener('mouseenter', () => toastQueue.hover(item.id, true))
      card.addEventListener('mouseleave', () => toastQueue.hover(item.id, false))
      const text = document.createElement('div')
      text.className = 'shell-toast-text'
      text.textContent = item.text
      card.appendChild(text)
      if (item.action) {
        const label = typeof item.action === 'string' ? item.action : item.action.label
        if (typeof label === 'string' && label.length > 0) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = label
          button.addEventListener('click', () => {
            if (typeof item.action === 'object' && typeof item.action.run === 'function') {
              try {
                item.action.run()
              } catch {
                // 动作失败不改 toast 生命周期
              }
            }
            toastQueue.dismiss(item.id)
            renderToasts()
          })
          card.appendChild(button)
        }
      }
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'shell-toast-close'
      close.setAttribute('aria-label', msg('shell_toast_close').body)
      close.textContent = '×'
      close.addEventListener('click', () => {
        toastQueue.dismiss(item.id)
        renderToasts()
      })
      card.appendChild(close)
      return card
    }),
  )
}

let lastVisibleIds = ''
setInterval(() => {
  toastQueue.tick()
  const ids = toastQueue
    .visible()
    .map((item) => item.id)
    .join(',')
  if (ids !== lastVisibleIds) {
    lastVisibleIds = ids
    renderToasts()
  }
}, 200)

// ---- slot 装载与失败隔离 ----

function isUnreachable(err) {
  const text = String(err && err.message ? err.message : err)
  return /Failed to fetch|dynamically imported module|NetworkError|502|404/i.test(text)
}

function renderSlotFailure(root, code, entry) {
  const card = document.createElement('div')
  card.className = 'shell-slot-failed'
  const title = document.createElement('div')
  title.className = 'shell-slot-failed-title'
  title.textContent = msg(code).title
  const body = document.createElement('div')
  body.textContent = msg(code).body
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = msg(code).action ?? msg('ui_unreachable').action ?? ''
  retry.addEventListener('click', () => {
    root.replaceChildren()
    void mountEntry(entry)
  })
  card.append(title, body, retry)
  root.replaceChildren(card)
}

async function mountEntry(entry) {
  const root = document.getElementById(`slot-${entry.slot}`)
  if (root === null) return
  try {
    const module = await import(`/p/${entry.id}/entry.js`)
    if (module.contract !== undefined && module.contract !== CONTRACT_VERSION) {
      renderSlotFailure(root, 'ui_version_mismatch', entry)
      return
    }
    if (typeof module.mount !== 'function') {
      renderSlotFailure(root, 'ui_boot_failed', entry)
      return
    }
    await module.mount(root, { ...api, slot: entry.slot })
  } catch (err) {
    renderSlotFailure(root, isUnreachable(err) ? 'ui_unreachable' : 'ui_boot_failed', entry)
  }
}
async function mountAll() {
  const entries = Array.isArray(BOOTSTRAP.mounts) ? BOOTSTRAP.mounts : []
  await Promise.allSettled(entries.map((entry) => mountEntry(entry)))
  const headless = Array.isArray(BOOTSTRAP.headless) ? BOOTSTRAP.headless : []
  await Promise.allSettled(
    headless.map(async (entry) => {
      try {
        const module = await importHeadless(entry.id)
        if (typeof module.mount === 'function') await module.mount(api)
      } catch {
        // headless 加载失败不影响 slot
      }
    }),
  )
}

/** 导入 headless 入口；首载 404（壳取字节未就绪）退避后带 cache-bust 重试一次。 */
async function importHeadless(id) {
  const url = `/assets/headless/${id}.js`
  try {
    return await import(url)
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return await import(`${url}?retry=1`)
  }
}

// ---- 无配置判据 ----

let bootModePending = false
let bootModeDirty = false

async function detectBootMode() {
  if (bootModePending) {
    // 读回在途时又来一次触发（如 config 写落账后的 shell.state 重推）：标记后串行补跑，
    // 保证最后一次判据用的是最新 config。
    bootModeDirty = true
    return
  }
  bootModePending = true
  try {
    const result = await api.command('config.read')
    if (result.ok) {
      uiState.set('boot_mode', deriveBootMode(result.value))
      const config = result.value
      if (!themeTouched && config && typeof config === 'object' && config.ui && config.ui.theme) {
        const pref = normalizeThemePref(config.ui.theme)
        if (pref !== themePref) {
          themePref = pref
          applyTheme()
        }
      }
    }
  } finally {
    bootModePending = false
    if (bootModeDirty) {
      bootModeDirty = false
      void detectBootMode()
    }
  }
}

// ---- 静态资源降级 ----

const tokensLink = document.getElementById('shell-tokens')
if (tokensLink !== null) {
  tokensLink.addEventListener('error', () => {
    const style = document.createElement('style')
    style.textContent =
      ':root{--c-bg:#FAFAF9;--c-surface:#FDFDFC;--c-text:#1F1E1C;--c-border:#E3E2DF;' +
      '--c-text-2:#6E6D69;--c-text-3:#9C9B96;--c-accent:#46548C;--c-accent-text:#FFFFFF;}'
    document.head.appendChild(style)
    toastQueue.enqueue({ tone: 'warning', text: msg('shell_tokens_fallback').body })
    renderToasts()
  })
}

// ---- 启动 ----

function updateNarrow() {
  document.body.classList.toggle('shell-narrow', window.innerWidth < 1024)
}
updateNarrow()
window.addEventListener('resize', updateNarrow)

async function boot() {
  await loadMessages()
  connectEvents()
  await mountAll()
  window.setTimeout(() => {
    if (splash !== null) splash.classList.add('shell-fade')
  }, 150)
}

void boot()
