// ui-notify 浏览器侧 headless 入口（ESM、零依赖）。
//
// 由壳经插件源码读面取字节、以同源静态路径加载（不占 slot、不占端口、不导出 mount）。
// 本文件自初始化：读 `notify.state` 拿开关 → 连壳 `/events` SSE → 按规则调浏览器
// `Notification` API → 5s 合并 / 同屏上限排队 → 把权限状态发布到同页全局供设置页消费。
//
// 壳按 headless 清单的单个 `{id, entry}` 只服务一个静态文件，故本 bundle 不 import 兄弟模块；
// 纯逻辑以命名导出暴露，便于在 Node 里直接单测。

/** 开关键与缺键默认值（缺键 = true）。 */
export const DEFAULT_SWITCHES = Object.freeze({
  approval_pending: true,
  run_finished: true,
  run_failed: true,
  model_error: true,
  disconnected: true,
  orchestration_change: true,
  plugin_write: true,
  orchestration_unhealthy: true,
  question_pending: true,
  only_when_unfocused: true,
})

/** 同一 `(thread, kind)` 的合并窗口。 */
export const THROTTLE_WINDOW_MS = 5000

/** 同屏最多系统通知条数，超出排队。 */
export const MAX_ON_SCREEN = 3

/** 正文（会话标签 + 首行摘要）的码点上限。 */
export const BODY_LIMIT = 80

/** 已拒绝权限的指引文案码（住文案表；本插件只按码取用）。 */
export const PERMISSION_DENIED_CODE = 'notify_permission_denied'

/** 通知标题 / 固定正文的文案码（住壳的 `messages.v1.json`；本插件只按码取用）。 */
export const NOTIFY_CODES = Object.freeze({
  approval_pending: 'notify_approval_pending',
  orchestration_change: 'notify_orchestration_change',
  plugin_write: 'notify_plugin_write',
  run_finished: 'notify_run_finished',
  run_failed: 'notify_run_failed',
  model_error: 'notify_model_error',
  disconnected: 'notify_disconnected',
  reconnected: 'notify_reconnected',
  orchestration_unhealthy: 'notify_orchestration_unhealthy',
  question_pending: 'notify_question_pending',
})

/** 文案表未登记该码时的内置兜底（不硬编码进正常路径）。 */
const DENIED_FALLBACK = '请在浏览器站点设置中允许通知'

/** 模型错误 reasons 前缀；`transport_failed` 是宿主传输级归类，同档。 */
const MODEL_ERROR_PREFIXES = ['model_']
const MODEL_ERROR_EXACT = ['transport_failed']

/** 缺键默认 true；显式 `false` 才关（开关形态归写入端）。 */
export function resolveSwitches(notify) {
  const source = notify !== null && typeof notify === 'object' ? notify : {}
  const resolved = {}
  for (const key of Object.keys(DEFAULT_SWITCHES)) {
    resolved[key] = typeof source[key] === 'boolean' ? source[key] : true
  }
  return resolved
}

/** 从 `notify.state` 的返回值（整份 config body）取 `ui.notify` 并解析。 */
export function resolveSwitchesFromCommandValue(value) {
  const config = asRecord(value)
  const ui = asRecord(config?.ui)
  return resolveSwitches(ui?.notify)
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** 首行、去首尾空白；非字符串给空串。 */
export function firstLine(text) {
  if (typeof text !== 'string') return ''
  return text.split('\n')[0].trim()
}

/** 按 Unicode 码点截断到 `limit`，超长以 `…` 收尾。 */
export function truncate(text, limit = BODY_LIMIT) {
  const points = Array.from(text)
  if (points.length <= limit) return text
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** 正文 = 会话标签 + 首行摘要，整体截断到 80 字。 */
export function formatBody(label, summary, limit = BODY_LIMIT) {
  const parts = [firstLine(label), firstLine(summary)].filter((part) => part.length > 0)
  return truncate(parts.join(' · '), limit)
}

function pickThread(payload, item) {
  const fromPayload = typeof payload.thread === 'string' && payload.thread.length > 0 ? payload.thread : null
  if (fromPayload !== null) return fromPayload
  const fromItem = item !== null && typeof item.thread === 'string' && item.thread.length > 0 ? item.thread : null
  return fromItem
}

function isModelError(reasons) {
  if (!Array.isArray(reasons)) return false
  return reasons.some((reason) => {
    if (typeof reason !== 'string') return false
    return MODEL_ERROR_PREFIXES.some((prefix) => reason.startsWith(prefix)) || MODEL_ERROR_EXACT.includes(reason)
  })
}

function unhealthySummary(payload) {
  const raw = payload.count ?? payload.failures ?? payload.n
  const suffix = '，可在设置 → 编排回滚到上一世代'
  if (typeof raw === 'number' && Number.isFinite(raw)) return `编排连续失败 ${raw} 次${suffix}`
  return `编排连续失败${suffix}`
}

/**
 * 把一条壳 `/events` 记录分类成通知描述；不订阅的事件返回 null。
 * 描述：`{ kind, title, thread, summary, always, unthrottled }`。
 * `always` = 结构 / 失败 / 断线类，不看窗口焦点也通知；
 * `unthrottled` = 结构性事件，不受 5s 合并与同屏排队约束（必须即时）。
 */
export function classify(record) {
  const source = asRecord(record)
  if (source === null) return null
  const payload = asRecord(source.payload) ?? {}
  switch (source.topic) {
    case 'approval.pending': {
      const item = asRecord(payload.item)
      const kindSource = item ?? payload
      const kind = typeof kindSource.kind === 'string' ? kindSource.kind : null
      const thread = pickThread(payload, item)
      const summary = firstLine(payload.summary ?? kindSource.summary ?? kindSource.method ?? '')
      if (kind === 'orchestration_change') {
        return { kind: 'orchestration_change', code: NOTIFY_CODES.orchestration_change, title: '待审批：编排变更', thread, summary, always: true, unthrottled: false }
      }
      if (kind === 'plugin_write') {
        return { kind: 'plugin_write', code: NOTIFY_CODES.plugin_write, title: '待审批：插件写入', thread, summary, always: true, unthrottled: false }
      }
      return { kind: 'approval_pending', code: NOTIFY_CODES.approval_pending, title: '待审批', thread, summary, always: false, unthrottled: false }
    }
    case 'run.finished': {
      const thread = pickThread(payload, null)
      const summary = firstLine(payload.summary)
      if (payload.status === 'done') {
        return { kind: 'run_finished', code: NOTIFY_CODES.run_finished, title: '回合完成', thread, summary, always: false, unthrottled: false }
      }
      if (payload.status === 'refused' || payload.status === 'failed') {
        if (isModelError(payload.reasons)) {
          return { kind: 'model_error', code: NOTIFY_CODES.model_error, title: '模型错误', thread, summary, always: true, unthrottled: false }
        }
        return { kind: 'run_failed', code: NOTIFY_CODES.run_failed, title: '回合失败', thread, summary, always: true, unthrottled: false }
      }
      return null
    }
    case 'shell.disconnected':
      return { kind: 'disconnected', code: NOTIFY_CODES.disconnected, title: '断线', thread: null, summary: '与宿主断开，重连中…', summaryCode: NOTIFY_CODES.disconnected, always: true, unthrottled: false }
    case 'shell.reconnected':
      return { kind: 'reconnected', code: NOTIFY_CODES.reconnected, title: '已重连', thread: null, summary: '已恢复与宿主的连接', summaryCode: NOTIFY_CODES.reconnected, always: true, unthrottled: false }
    case 'orchestration.unhealthy': {
      const count = typeof payload.count === 'number' && Number.isFinite(payload.count) ? payload.count : typeof payload.failures === 'number' ? payload.failures : typeof payload.n === 'number' ? payload.n : null
      return {
        kind: 'orchestration_unhealthy',
        code: NOTIFY_CODES.orchestration_unhealthy,
        title: '编排连续失败',
        thread: pickThread(payload, null),
        summary: unhealthySummary(payload),
        summaryCode: NOTIFY_CODES.orchestration_unhealthy,
        count,
        always: true,
        unthrottled: true,
      }
    }
    case 'question.pending':
      return {
        kind: 'question_pending',
        code: NOTIFY_CODES.question_pending,
        title: '提问待作答',
        thread: pickThread(payload, null),
        summary: firstLine(payload.summary ?? payload.text),
        always: true,
        unthrottled: true,
      }
    default:
      return null
  }
}

/** 描述 kind → 开关键；重连与断线共用一个开关。 */
export function switchKeyFor(kind) {
  return kind === 'reconnected' ? 'disconnected' : kind
}

/**
 * 双重门控：开关键为真 **且** 浏览器权限 granted 才弹。
 * `tool_call` 待审批与回合完成受 `only_when_unfocused` 约束；结构 / 失败类不看焦点。
 * 返回 `{ show, reason, switchKey }`，任一不满足只回 reason，不抛错。
 */
export function evaluate(descriptor, state) {
  const switches = asRecord(state)?.switches ?? DEFAULT_SWITCHES
  const permission = typeof state?.permission === 'string' ? state.permission : 'default'
  const focused = state?.focused === true
  const switchKey = switchKeyFor(descriptor.kind)
  if (switches[switchKey] !== true) return { show: false, reason: 'switch_off', switchKey }
  if (permission !== 'granted') {
    return { show: false, reason: permission === 'denied' ? 'permission_denied' : 'permission_default', switchKey }
  }
  if (descriptor.always !== true && switches.only_when_unfocused === true && focused) {
    return { show: false, reason: 'focused', switchKey }
  }
  return { show: true, reason: 'show', switchKey }
}

/** 去重键：`thread|kind`；`thread` 缺失（如周期 unhealthy 的 `thread:null`）退化为 `kind`。 */
export function throttleKey(thread, kind) {
  const normalized = typeof thread === 'string' && thread.length > 0 ? thread : null
  return normalized === null ? kind : `${normalized}|${kind}`
}

/** 通知内容：标题 = 事件类型；正文 = 会话标签 + 首行摘要，合并计数附在正文。 */
export function notificationContent(descriptor, count = 1, messages = null) {
  const titleEntry = notifyEntry(messages, descriptor.code)
  const title = typeof titleEntry?.title === 'string' && titleEntry.title.length > 0 ? titleEntry.title : descriptor.title
  let summary = descriptor.summary ?? ''
  const summaryEntry = notifyEntry(messages, descriptor.summaryCode)
  if (summaryEntry !== null && typeof summaryEntry.body === 'string') {
    summary =
      typeof descriptor.count === 'number' && Number.isFinite(descriptor.count)
        ? summaryEntry.body.replace('{count}', String(descriptor.count))
        : summaryEntry.body.replace(/\s*\{count\}\s*/, ' ')
  }
  let body = formatBody(descriptor.label ?? descriptor.thread ?? '', summary)
  if (count > 1) body = `${body}（×${count}）`
  return { title, body }
}

/** 按码取文案表条目；无表 / 无码返回 null。 */
function notifyEntry(messages, code) {
  if (typeof code !== 'string' || code.length === 0) return null
  return asRecord(asRecord(messages)?.[code])
}

/** 点击通知聚焦 shell；OS 原生模板，不挂操作按钮。 */
export function attachHandlers(notification, win) {
  notification.onclick = () => {
    try {
      win.focus()
    } catch {
      // 聚焦失败不影响通知本身
    }
  }
  return notification
}

/** 读浏览器权限；无 Notification API 时给 `unsupported`（按未授权处理）。 */
export function readPermission(win) {
  const api = win?.Notification
  if (api === undefined || typeof api.permission !== 'string') return 'unsupported'
  return api.permission
}

/** 已拒绝时给出指引（码 + 文案表取值 / 兜底）；其余权限状态无指引。 */
export function guidanceFor(permission, messages) {
  if (permission !== 'denied') return null
  const entry = asRecord(messages)?.[PERMISSION_DENIED_CODE]
  const text = asRecord(entry) !== null && typeof entry.body === 'string' ? entry.body : DENIED_FALLBACK
  return { code: PERMISSION_DENIED_CODE, text }
}

/** 把权限 / 开关状态发布到同页全局，并派发自定义事件；供设置页同页读取。 */
export function publishState(win, state) {
  const payload = Object.freeze({
    permission: typeof state?.permission === 'string' ? state.permission : 'default',
    switches: state?.switches ?? DEFAULT_SWITCHES,
    guidance: state?.guidance ?? null,
    updatedAt: Date.now(),
  })
  win.__chronoNotify = payload
  if (typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
    win.dispatchEvent(new win.CustomEvent('chrono-notify:state', { detail: payload }))
  }
  return payload
}

/** 去重与节流：5s 窗口合并计数、同屏上限排队、结构类事件即时。 */
export class NotificationThrottle {
  constructor({ windowMs = THROTTLE_WINDOW_MS, maxOnScreen = MAX_ON_SCREEN } = {}) {
    this.windowMs = windowMs
    this.maxOnScreen = maxOnScreen
    this.windows = new Map()
    this.queue = []
    this.active = 0
  }

  /**
   * 受理一条描述，返回 `{ action, descriptor, count, key }`：
   * `show` = 新建一条；`merge` = 命中 5s 窗口、计数合并到已弹的那条；`queue` = 同屏已满、排队。
   */
  admit(descriptor, now = Date.now()) {
    const key = throttleKey(descriptor.thread, descriptor.kind)
    if (descriptor.unthrottled === true) {
      return { action: 'show', descriptor, count: 1, key }
    }
    const window = this.windows.get(key)
    if (window !== undefined && now - window.firstAt < this.windowMs) {
      window.count += 1
      // 命中窗口但原条还在排队：计数落到队列项上，弹出时带上（不丢合并计数）。
      if (window.shown !== true && window.queueItem !== null) window.queueItem.count = window.count
      return { action: 'merge', descriptor: window.descriptor, count: window.count, key }
    }
    if (this.active < this.maxOnScreen) {
      this.active += 1
      this.windows.set(key, { firstAt: now, count: 1, descriptor, shown: true, queueItem: null })
      return { action: 'show', descriptor, count: 1, key }
    }
    const queueItem = { descriptor, key, count: 1 }
    this.queue.push(queueItem)
    this.windows.set(key, { firstAt: now, count: 1, descriptor, shown: false, queueItem })
    return { action: 'queue', descriptor, count: 1, key }
  }

  /** 一条通知关闭：释放配额并取出下一条待弹（带累计计数；无则 null）。 */
  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next === undefined) return null
    this.active += 1
    return { ...next.descriptor, count: next.count }
  }

  /** 释放配额但不弹出（release 后门控不通过时丢弃排队项）。 */
  discard() {
    this.active = Math.max(0, this.active - 1)
  }

  activeCount() {
    return this.active
  }

  queuedCount() {
    return this.queue.length
  }
}

/** 纯编排：分类 → 双重门控 → 节流；把动作交给注入的 show / update。 */
export function createRuntime(options = {}) {
  const throttle = new NotificationThrottle({
    windowMs: options.windowMs ?? THROTTLE_WINDOW_MS,
    maxOnScreen: options.maxOnScreen ?? MAX_ON_SCREEN,
  })
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const show = typeof options.show === 'function' ? options.show : () => {}
  const update = typeof options.update === 'function' ? options.update : () => {}
  let state = {
    permission: typeof options.permission === 'string' ? options.permission : 'default',
    switches: options.switches ?? DEFAULT_SWITCHES,
    focused: options.focused === true,
  }

  return {
    setState(next) {
      state = { ...state, ...next }
    },
    getState() {
      return state
    },
    /** 处理一条 SSE 记录，返回本次动作（便于测试与观测）。 */
    handle(record) {
      const descriptor = classify(record)
      if (descriptor === null) return { action: 'ignore', descriptor: null }
      const gate = evaluate(descriptor, state)
      if (!gate.show) return { action: 'skip', reason: gate.reason, descriptor }
      const decision = throttle.admit(descriptor, now())
      if (decision.action === 'show') show(descriptor, decision.count)
      else if (decision.action === 'merge') update(decision.descriptor, decision.count)
      return { ...decision, descriptor }
    },
    /** 通知关闭后取排队项；弹出前按当前状态重评门控，不满足则丢弃并继续取下一条。 */
    release() {
      for (;;) {
        const next = throttle.release()
        if (next === null) return null
        const gate = evaluate(next, state)
        if (gate.show) return next
        throttle.discard()
      }
    },
    throttle,
  }
}

async function loadSwitches(win) {
  try {
    const response = await win.fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'notify.state', args: null }),
    })
    if (response === undefined || response.ok !== true) return DEFAULT_SWITCHES
    const body = asRecord(await response.json())
    // 命令回包形态门禁：HTTP 200 不代表成功，须 body.ok === true 才取 value。
    if (body === null || body.ok !== true) return DEFAULT_SWITCHES
    return resolveSwitchesFromCommandValue(body.value)
  } catch {
    return DEFAULT_SWITCHES
  }
}

async function loadMessages(win) {
  try {
    const response = await win.fetch('/assets/messages.v1.json')
    if (response === undefined || response.ok !== true) return null
    const parsed = asRecord(await response.json())
    // 文案表形态门禁：非对象 / 空表按缺失处理（保留内置兜底）。
    if (parsed === null) return null
    return Object.keys(parsed).length > 0 ? parsed : null
  } catch {
    return null
  }
}

/** 浏览器侧初始化：发布权限状态 → 取开关与文案表 → 订阅 `/events` → 按规则弹通知。 */
export async function init(win) {
  let switches = DEFAULT_SWITCHES
  let messages = null
  const publish = () =>
    publishState(win, {
      permission: readPermission(win),
      switches,
      guidance: guidanceFor(readPermission(win), messages),
    })
  publish()

  const live = new Map()
  let runtime = null

  const showDescriptor = (descriptor, count) => {
    if (typeof win.Notification !== 'function') return
    const content = notificationContent(descriptor, count, messages)
    const notification = attachHandlers(new win.Notification(content.title, { body: content.body }), win)
    const key = throttleKey(descriptor.thread, descriptor.kind)
    if (descriptor.unthrottled !== true) {
      notification.onclose = () => {
        if (live.get(key) === notification) live.delete(key)
        const next = runtime.release()
        if (next !== null) showDescriptor(next, next.count ?? 1)
      }
      live.set(key, notification)
    }
  }

  const updateDescriptor = (descriptor, count) => {
    const key = throttleKey(descriptor.thread, descriptor.kind)
    const existing = live.get(key)
    if (existing === undefined) return
    existing.body = notificationContent(descriptor, count, messages).body
  }

  runtime = createRuntime({
    permission: readPermission(win),
    switches,
    focused: isFocused(win),
    show: showDescriptor,
    update: updateDescriptor,
  })

  messages = await loadMessages(win)
  switches = await loadSwitches(win)
  runtime.setState({ switches, permission: readPermission(win), focused: isFocused(win) })
  publish()

  if (typeof win.EventSource !== 'function') return
  const source = new win.EventSource('/events')
  source.onmessage = (event) => {
    let record = null
    try {
      record = JSON.parse(event.data)
    } catch {
      return
    }
    runtime.setState({ focused: isFocused(win), permission: readPermission(win) })
    runtime.handle(record)
  }
}

function isFocused(win) {
  const hasFocus = win?.document?.hasFocus
  return typeof hasFocus === 'function' ? hasFocus.call(win.document) === true : false
}

const IS_BROWSER = typeof window !== 'undefined' && typeof window.document !== 'undefined'
if (IS_BROWSER) {
  void init(window).catch(() => {
    // 通知失败不影响对话与其它前端
  })
}
