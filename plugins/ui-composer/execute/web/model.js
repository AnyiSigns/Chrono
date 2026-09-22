// 输入卡浏览器侧纯模型：配置合并 / 模型与推理档位推导 / 待发队列迁移 /
// 上下文用量格式与阈值 / 槽与配置写指令构造 / 权限四档。只做数据变换，不触 DOM、不触网络。

/** 缺省线程键（per-thread 键控：读写只碰本键）。 */
export const MAIN_THREAD = '_main'

/** 权限四档（写 `config.permission`；由沙箱强制、判定插件判升级）。 */
export const PERMISSIONS = ['auto', 'severe', 'review', 'deny']

/** 权限档 → 按钮文字码。 */
const PERMISSION_LABEL = {
  auto: 'composer_permission_auto',
  severe: 'composer_permission_severe',
  review: 'composer_permission_review',
  deny: 'composer_permission_deny',
}

/** 权限档 → 弹层描述码（明确实际能力）。 */
const PERMISSION_DESC = {
  auto: 'composer_permission_auto_desc',
  severe: 'composer_permission_severe_desc',
  review: 'composer_permission_review_desc',
  deny: 'composer_permission_deny_desc',
}

/** 权限档 → linear 图标名。 */
const PERMISSION_ICON = { auto: 'zap', severe: 'shield-alert', review: 'eye', deny: 'ban' }

/** 上下文用量阈值（与组装侧的 75% 压缩提示同阈值）。 */
export const CONTEXT_WARNING_RATIO = 0.75
export const CONTEXT_FULL_RATIO = 1

/** 来源键 → 文案码（未知键原样显示键名，不猜）。 */
const SOURCE_CODE = {
  system: 'composer_source_system',
  tools: 'composer_source_tools',
  memory: 'composer_source_memory',
  history: 'composer_source_history',
  skills: 'composer_source_skills',
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── 线程键 ────────────────────────────────────────────────────────────────

/** 视图线程 → 槽键：非空字符串原样，否则 `_main`。 */
export function threadKeyOf(activeThread) {
  return typeof activeThread === 'string' && activeThread.length > 0 ? activeThread : MAIN_THREAD
}

/** 事件线程与当前视图线程是否同一线程（缺省一律归 `_main`）。 */
export function matchesThread(payloadThread, activeThread) {
  return threadKeyOf(payloadThread) === threadKeyOf(activeThread)
}

/** run 级事件的线程键。 */
export function runKeyOf(payload) {
  return threadKeyOf(isRecord(payload) ? payload.thread : null)
}

/** run 级事件的 run id；缺失回 null。 */
export function runIdOf(payload) {
  if (!isRecord(payload)) return null
  return typeof payload.run === 'string' && payload.run.length > 0 ? payload.run : null
}

// ── 配置读取与合并（整值寄存器：只改本插件负责的字段） ─────────────────────

export function currentVendorOf(config) {
  return isRecord(config) && typeof config.vendor === 'string' && config.vendor.length > 0
    ? config.vendor
    : null
}

export function currentModelOf(config) {
  return isRecord(config) && typeof config.model === 'string' && config.model.length > 0
    ? config.model
    : null
}

/** 模型列表：只来自用户配置的 vendor / model 目录，绝不内置模型名。 */
export function modelsOf(config) {
  if (!isRecord(config) || !isRecord(config.providers)) return []
  const list = []
  for (const [vendor, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    for (const [id, meta] of Object.entries(provider.models)) {
      if (isRecord(meta) && meta.enabled === false) continue
      const name =
        isRecord(meta) && typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : id
      list.push({ vendor, id, name })
    }
  }
  return list
}

/** 所选模型的推理档位：读 `providers.<vendor>.models.<model>.reasoning`；缺 / 非数组回 null。 */
export function reasoningOptionsFromConfig(config) {
  const vendor = currentVendorOf(config)
  const model = currentModelOf(config)
  if (vendor === null || model === null || !isRecord(config.providers)) return null
  const provider = config.providers[vendor]
  if (!isRecord(provider) || !isRecord(provider.models)) return null
  const meta = provider.models[model]
  if (!isRecord(meta)) return null
  const reasoning = meta.reasoning
  return Array.isArray(reasoning) ? reasoning.filter((value) => typeof value === 'string') : null
}

/** 当前 `params.reasoning`；缺失回 null。 */
export function currentReasoningOf(config) {
  if (!isRecord(config) || !isRecord(config.params)) return null
  return typeof config.params.reasoning === 'string' ? config.params.reasoning : null
}

/** 档位塌缩：值全同（含单档）→ 折叠为单开关；否则保留档位列表。 */
export function collapseReasoning(options) {
  if (!Array.isArray(options) || options.length === 0) return { collapsed: false, options: [] }
  const first = options[0]
  const uniform = options.every((value) => value === first)
  return uniform ? { collapsed: true, value: first, options } : { collapsed: false, options }
}

/**
 * 整值配置合并：只改 `change` 点名的字段（vendor / model / permission / reasoning）。
 * `reasoning: null` 表示清除该键（折叠开关关闭）。
 */
export function mergeConfig(config, change) {
  const base = isRecord(config) ? config : {}
  const next = { ...base }
  if (typeof change.vendor === 'string') next.vendor = change.vendor
  if (typeof change.model === 'string') next.model = change.model
  if (typeof change.permission === 'string') next.permission = change.permission
  if (Object.prototype.hasOwnProperty.call(change, 'reasoning')) {
    const params = isRecord(base.params) ? { ...base.params } : {}
    if (typeof change.reasoning === 'string') params.reasoning = change.reasoning
    else delete params.reasoning
    next.params = params
  }
  return next
}

// ── 权限四档 ──────────────────────────────────────────────────────────────

export function normalizePermission(value) {
  return PERMISSIONS.includes(value) ? value : 'review'
}

export function permissionLabelCode(value) {
  return PERMISSION_LABEL[normalizePermission(value)]
}

export function permissionDescCode(value) {
  return PERMISSION_DESC[normalizePermission(value)]
}

export function permissionIcon(value) {
  return PERMISSION_ICON[normalizePermission(value)]
}

// ── 槽与配置写指令 ────────────────────────────────────────────────────────

/** `chat.message` 槽体（发送时写入 `slots[thread]`）。 */
export function buildMessageSlot(text, attachments) {
  return {
    kind: 'chat.message',
    text: typeof text === 'string' ? text : '',
    attachments: Array.isArray(attachments) ? attachments : [],
  }
}

/** 读-改-写：只覆盖本线程键，其余线程键原样保留。 */
export function mergeSlotBody(body, threadKey, slot) {
  const base = isRecord(body) ? body : {}
  const slots = isRecord(base.slots) ? { ...base.slots } : {}
  slots[threadKey] = slot
  return { ...base, slots }
}

/** `input` 槽写指令：整份 `put` + `add_gen`（同一批）。 */
export function slotWriteDirective(body) {
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body } },
          { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
}

/** `config` 写指令：整份 `put` + `add_gen`（同一批）。 */
export function configWriteDirective(body) {
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body } },
          { op: 'add_gen', args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
        ],
      },
    },
  }
}

// ── 待发队列（内存、per-thread 键控） ──────────────────────────────────────

export function queueOf(queue, threadKey) {
  const list = isRecord(queue) ? queue[threadKey] : null
  return Array.isArray(list) ? list : []
}

export function queueCount(queue, threadKey) {
  return queueOf(queue, threadKey).length
}

export function enqueue(queue, threadKey, message) {
  const next = { ...(isRecord(queue) ? queue : {}) }
  next[threadKey] = [...queueOf(next, threadKey), message]
  return next
}

/** 放回队首（续发失败时保留反悔通道，不静默丢）。 */
export function enqueueFront(queue, threadKey, message) {
  const next = { ...(isRecord(queue) ? queue : {}) }
  next[threadKey] = [message, ...queueOf(next, threadKey)]
  return next
}

export function dequeue(queue, threadKey) {
  const list = queueOf(queue, threadKey)
  if (list.length === 0) return { queue: isRecord(queue) ? queue : {}, message: null }
  const [message, ...rest] = list
  const next = { ...(isRecord(queue) ? queue : {}) }
  if (rest.length === 0) delete next[threadKey]
  else next[threadKey] = rest
  return { queue: next, message }
}

export function removeFromQueue(queue, threadKey, id) {
  const rest = queueOf(queue, threadKey).filter((item) => item.id !== id)
  const next = { ...(isRecord(queue) ? queue : {}) }
  if (rest.length === 0) delete next[threadKey]
  else next[threadKey] = rest
  return next
}

/** 队内消息摘要（文本 + 附件计数），供待发弹层逐条展示。 */
export function messageSummary(slot, max = 48) {
  const text =
    isRecord(slot) && typeof slot.text === 'string' ? slot.text.replace(/\s+/g, ' ').trim() : ''
  const count = isRecord(slot) && Array.isArray(slot.attachments) ? slot.attachments.length : 0
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text
  return { text: clipped, count }
}

// ── 上下文用量（§16.10 数字格式 + 阈值分档） ───────────────────────────────

function trimZero(value) {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** token 计数格式：≥1000 保留 1 位小数用 `k`，≥1M 用 `M`。 */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (Math.abs(value) >= 1000) return `${trimZero(value / 1000)}k`
  return String(Math.trunc(value))
}

export function usageRatio(usage) {
  if (!isRecord(usage)) return 0
  const used = typeof usage.used === 'number' && Number.isFinite(usage.used) ? usage.used : 0
  const budget =
    typeof usage.budget === 'number' && Number.isFinite(usage.budget) ? usage.budget : 0
  if (budget <= 0) return used > 0 ? CONTEXT_FULL_RATIO : 0
  return used / budget
}

export function usageTone(usage) {
  const ratio = usageRatio(usage)
  if (ratio >= CONTEXT_FULL_RATIO) return 'danger'
  if (ratio >= CONTEXT_WARNING_RATIO) return 'warning'
  return 'muted'
}

export function usageFull(usage) {
  return usageRatio(usage) >= CONTEXT_FULL_RATIO
}

/** 用量视图：无 `used` / `budget` 数字回 null（不渲染该行）。 */
export function usageView(usage) {
  if (!isRecord(usage)) return null
  const used = typeof usage.used === 'number' && Number.isFinite(usage.used) ? usage.used : null
  const budget =
    typeof usage.budget === 'number' && Number.isFinite(usage.budget) ? usage.budget : null
  if (used === null || budget === null) return null
  return {
    used,
    budget,
    usedText: formatCount(used),
    budgetText: formatCount(budget),
    tone: usageTone(usage),
    full: usageFull(usage),
  }
}

/** 各来源 token 行；未知来源键原样显示键名。 */
export function sourceRows(usage) {
  if (!isRecord(usage) || !isRecord(usage.sources)) return []
  const rows = []
  for (const [key, value] of Object.entries(usage.sources)) {
    const tokens =
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : isRecord(value) && typeof value.tokens === 'number' && Number.isFinite(value.tokens)
          ? value.tokens
          : null
    if (tokens === null) continue
    rows.push({ key, code: SOURCE_CODE[key] ?? null, tokens, text: formatCount(tokens) })
  }
  return rows
}

/** 被裁剪项行（原因 + 标签）；无 `trimmed` 数组回空。 */
export function trimmedRows(usage) {
  if (!isRecord(usage) || !Array.isArray(usage.trimmed)) return []
  return usage.trimmed
    .filter((item) => isRecord(item))
    .map((item) => ({
      label:
        typeof item.label === 'string' ? item.label : typeof item.id === 'string' ? item.id : '',
      reason: typeof item.reason === 'string' ? item.reason : '',
    }))
}
