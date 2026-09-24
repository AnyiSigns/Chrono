// 壳页面脚本：S0 启动 → 按挂载表装载各 slot 子应用；事件订阅（/events）、全局 toast、
// 跨 slot 视图状态（uiState）、主题、S6 断线横幅与静态资源降级。
// 与子应用同源、不共享运行时；壳只做布局 / 路由 / 桥接，不认识业务。

import { createUiState } from './ui-state.js'
import { createToastQueue, roleForTone } from './toast.js'
import { normalizeThemePref, resolveTheme } from './theme.js'
import { deriveBootMode } from './boot-mode.js'
import { identityBody } from './identity-shape.js'
import { createSlotHost } from './slots.js'

const CONTRACT_VERSION = '1'
/** slot 客户端半边契约版本（`register(ctx)` + `ctx.slots`）。 */
const SLOT_CONTRACT_VERSION = '2'
/** slot / headless 装载上限：模块抓取从严（连接被挤占时会一直 pending），mount 运行放宽到与宿主调用超时同量级。 */
const MOUNT_IMPORT_TIMEOUT_MS = 10000
const MOUNT_RUN_TIMEOUT_MS = 30000
/** slot 装载失败后的后台自愈退避：1s 起、指数增长、封顶 30s（换代窗口常达数秒）。 */
const SLOT_RETRY_BASE_MS = 1000
const SLOT_RETRY_MAX_MS = 30000
/** 启动就绪门禁：全部 slot 可装载前留在启动屏，静默重试；超时则落失败卡放行。 */
const BOOT_READY_TIMEOUT_MS = 180000
const BOOT_RETRY_DELAY_MS = 800
const BOOTSTRAP =
  typeof window.__CHRONO_SHELL__ === 'object' && window.__CHRONO_SHELL__ !== null
    ? window.__CHRONO_SHELL__
    : { mounts: [], headless: [], theme: 'system' }

/** 文案表读取失败时的内置最小表（错误码原样显示，不阻塞）。 */
const FALLBACK_MESSAGES = {
  unknown: { title: '出现问题', body: '错误码 {code} 暂无说明。' },
  ui_unreachable: { title: '宿主不可达', body: '与宿主的连接已断开。', action: '重试' },
  ui_load_failed: { title: '界面未能加载', body: '这个界面暂时不可用，正在自动重试…', action: '重试' },
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

// slot 宿主：插件客户端半边经 register(ctx) 注册组件；壳只提供 outlet 与 error boundary。
// `mountEpoch` 记每个 entry 的当前装载代号：超时重挂会换新代号，迟到的 register 据此被丢弃。
const mountEpoch = new Map()
const slotHost = createSlotHost({
  api,
  msg,
  currentEpoch: (id) => mountEpoch.get(id),
})

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
    retryFailedSlots()
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
      retryFailedSlots()
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

// 失败 slot 的后台自愈：宿主换代 / 目标插件重启窗口内，slot 资源会短暂抓不到（404）。
// 卡片不能永久停留——按指数退避自动重挂；宿主重连时立即重挂全部失败项。
const failedSlots = new Map()
/** 在途装载表：同一 entry 不并发二次装载（键 = entry 对象）。 */
const inFlightMounts = new Map()
/** 装载代号：每次实际装载自增，用于丢弃超时后迟到的 register。 */
let mountSeq = 0

function scheduleSlotRetry(entry) {
  let state = failedSlots.get(entry)
  if (state === undefined) {
    state = { attempt: 0, timer: null }
    failedSlots.set(entry, state)
  }
  if (state.timer !== null) return
  const delay = Math.min(SLOT_RETRY_MAX_MS, SLOT_RETRY_BASE_MS * 2 ** state.attempt)
  state.attempt += 1
  state.timer = setTimeout(() => {
    state.timer = null
    void mountEntry(entry)
  }, delay)
}

function cancelSlotRetry(entry) {
  const state = failedSlots.get(entry)
  if (state === undefined) return
  if (state.timer !== null) clearTimeout(state.timer)
  failedSlots.delete(entry)
}

/** 宿主连接恢复时立即重挂所有失败 slot（不等退避计时器）。 */
function retryFailedSlots() {
  for (const entry of [...failedSlots.keys()]) {
    cancelSlotRetry(entry)
    void mountEntry(entry)
  }
}

/** 给一个 promise 加上限；超时以错误结算（调用方按失败隔离）。 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mount timeout')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
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
    cancelSlotRetry(entry)
    root.replaceChildren()
    void mountEntry(entry)
  })
  card.append(title, body, retry)
  root.replaceChildren(card)
  // 抓不到模块多为换代窗口（宿主在跑、只是这一刻资源没就绪）：后台自动重挂，不靠用户手点。
  if (code === 'ui_load_failed') scheduleSlotRetry(entry)
}

// 模块抓取序号：浏览器按 URL 缓存「失败的动态导入」，同一 URL 再次 import 会直接复用失败结果。
// 因此每次重试必须换新 URL——用全局单调序号，而不是每次从 0 重新数（否则启动门禁的重试永远命中旧失败）。
let slotImportSeq = 0

/** 取 slot 客户端半边模块：字节缓存可能未热（首载 404），退避重试并带 cache-bust 绕开失败的模块缓存。 */
async function importSlotEntry(id) {
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    slotImportSeq += 1
    try {
      return await withTimeout(import(`/assets/ui/${id}.js?r=${slotImportSeq}`), MOUNT_IMPORT_TIMEOUT_MS)
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError ?? new Error('slot entry unavailable')
}

/** 装载一个 slot：成功返回 null，失败返回错误码。`silent` 时不渲染失败卡（启动期静默重试）。 */
async function mountEntry(entry, silent = false) {
  // 同一 entry 不并发二次装载：在途时复用同一 promise（超时重挂也排队，避免双份 register）。
  const pending = inFlightMounts.get(entry)
  if (pending !== undefined) return pending
  const task = doMountEntry(entry, silent)
  inFlightMounts.set(entry, task)
  try {
    return await task
  } finally {
    inFlightMounts.delete(entry)
  }
}

async function doMountEntry(entry, silent = false) {
  const root = document.getElementById(`slot-${entry.slot}`)
  if (root === null) return null
  cancelSlotRetry(entry)
  const epoch = (mountSeq += 1)
  mountEpoch.set(entry.id, epoch)
  const fail = (code) => {
    if (!silent) renderSlotFailure(root, code, entry)
    return code
  }
  const entryPath = typeof entry.entry === 'string' && entry.entry.length > 0 ? entry.entry : null
  try {
    if (entryPath !== null) {
      // slot 客户端半边：壳经 host.source.read 同源服务，模块把组件注册进命名 slot。
      const module = await importSlotEntry(entry.id)
      if (module.contract !== SLOT_CONTRACT_VERSION) return fail('ui_version_mismatch')
      if (typeof module.register !== 'function') return fail('ui_boot_failed')
      // register 内部按装载代号拒绝陈旧注册；迟到的 store.start 由插件在注册失败时自行 dispose。
      await withTimeout(Promise.resolve(module.register(slotHost.ctxFor(entry.id, epoch))), MOUNT_RUN_TIMEOUT_MS)
      return null
    }
    // 旧模型：插件自有端口反代 + mount(root, api)。
    const module = await withTimeout(import(`/p/${entry.id}/entry.js`), MOUNT_IMPORT_TIMEOUT_MS)
    if (module.contract !== undefined && module.contract !== CONTRACT_VERSION) {
      return fail('ui_version_mismatch')
    }
    if (typeof module.mount !== 'function') return fail('ui_boot_failed')
    await withTimeout(module.mount(root, { ...api, slot: entry.slot }), MOUNT_RUN_TIMEOUT_MS)
    return null
  } catch (err) {
    return fail(isUnreachable(err) ? 'ui_load_failed' : 'ui_boot_failed')
  }
}

/** headless 入口装载：失败不影响 slot，也不阻塞进入。 */
async function mountHeadless() {
  const headless = Array.isArray(BOOTSTRAP.headless) ? BOOTSTRAP.headless : []
  await Promise.allSettled(
    headless.map(async (entry) => {
      try {
        const module = await withTimeout(importHeadless(entry.id), MOUNT_IMPORT_TIMEOUT_MS)
        if (typeof module.mount === 'function') {
          await withTimeout(module.mount(api), MOUNT_RUN_TIMEOUT_MS)
        }
      } catch {
        // headless 加载失败不影响 slot
      }
    }),
  )
}

/**
 * 启动就绪门禁：宿主按依赖分层并发起服务，壳自身层级浅、先绑定端口，故「页面能开」≠
 * 「各 slot 就绪」。这里留在启动屏静默重试，全部 slot 装载成功才进入；永久不符的立即落卡，
 * 超过上限的按常规失败卡放行（不无限空转）。
 */
async function waitForSlotsReady() {
  const entries = Array.isArray(BOOTSTRAP.mounts) ? BOOTSTRAP.mounts : []
  const total = entries.length
  if (total === 0) return
  const deadline = Date.now() + BOOT_READY_TIMEOUT_MS
  let notReady = entries
  while (true) {
    const codes = await Promise.all(notReady.map((entry) => mountEntry(entry, true)))
    const retryable = []
    for (let index = 0; index < notReady.length; index += 1) {
      const code = codes[index]
      if (code === null) continue
      // 版本不符是永久性问题：立即落卡，不参与空转
      if (code === 'ui_version_mismatch') void mountEntry(notReady[index], false)
      else retryable.push(notReady[index])
    }
    if (retryable.length === 0) return
    if (Date.now() >= deadline) {
      for (const entry of retryable) void mountEntry(entry, false)
      return
    }
    notReady = retryable
    await new Promise((resolve) => setTimeout(resolve, BOOT_RETRY_DELAY_MS))
  }
}

/** 导入 headless 入口；首载 404（壳取字节未就绪）退避后换新 URL 重试一次（避开失败模块缓存）。 */
async function importHeadless(id) {
  slotImportSeq += 1
  try {
    return await import(`/assets/headless/${id}.js?r=${slotImportSeq}`)
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    slotImportSeq += 1
    return await import(`/assets/headless/${id}.js?r=${slotImportSeq}`)
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
      const config = identityBody(result.value)
      uiState.set('boot_mode', deriveBootMode(config))
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
  await waitForSlotsReady()
  await mountHeadless()
  window.setTimeout(() => {
    if (splash !== null) splash.classList.add('shell-fade')
  }, 150)
}

void boot()
