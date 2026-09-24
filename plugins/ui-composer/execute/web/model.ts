// 输入卡浏览器侧纯模型：配置合并 / 模型与推理档位推导 / 待发队列迁移 /
// 上下文用量格式与阈值 / 槽与配置写指令构造 / 权限四档。只做数据变换，不触 DOM、不触网络。

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Rec = { [key: string]: Json }

/** 缺省线程键（per-thread 键控：读写只碰本键）。 */
export const MAIN_THREAD = '_main'

/** 权限四档（写 `config.permission`；由沙箱强制、判定插件判升级）。 */
export const PERMISSIONS = ['auto', 'severe', 'review', 'deny']

/** 权限档 → 按钮文字码。 */
const PERMISSION_LABEL: { [key: string]: string } = {
  auto: 'composer_permission_auto',
  severe: 'composer_permission_severe',
  review: 'composer_permission_review',
  deny: 'composer_permission_deny',
}

/** 权限档 → 弹层描述码（明确实际能力）。 */
const PERMISSION_DESC: { [key: string]: string } = {
  auto: 'composer_permission_auto_desc',
  severe: 'composer_permission_severe_desc',
  review: 'composer_permission_review_desc',
  deny: 'composer_permission_deny_desc',
}

/** 权限档 → linear 图标名。 */
const PERMISSION_ICON: { [key: string]: string } = {
  auto: 'zap',
  severe: 'shield-alert',
  review: 'eye',
  deny: 'ban',
}

/** 上下文用量阈值（与组装侧的 75% 压缩提示同阈值）。 */
export const CONTEXT_WARNING_RATIO = 0.75
export const CONTEXT_FULL_RATIO = 1

/** 来源键 → 文案码（未知键原样显示键名，不猜）。 */
const SOURCE_CODE: { [key: string]: string } = {
  system: 'composer_source_system',
  tools: 'composer_source_tools',
  memory: 'composer_source_memory',
  history: 'composer_source_history',
  skills: 'composer_source_skills',
}

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── 身份读值形状（config.read / input.read 返回整份身份视图） ───────────────

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
export function identityBody(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'body') ? value.body : value
}

/** 身份视图 → active（64hex 或 null）；非身份视图 / 形状不符回 undefined（不注入 expect_active）。 */
export function identityActive(value: unknown): string | null | undefined {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'active')) return undefined
  const active = value.active
  return typeof active === 'string' || active === null ? active : undefined
}

/** 身份视图 → data_gen（`{seq,payload}` 或 null）；非身份视图 / 形状不符回 undefined。 */
export function identityDataGen(value: unknown): unknown {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'data_gen')) return undefined
  return value.data_gen
}

/** 身份数据侧特征键：出现任一即视为数据 body，不判为代码世代回落。 */
const DATA_SIDE_KEYS = ['version', 'params', 'permission', 'ui', 'providers', 'slots']

/** 代码世代回落 body 判据：拿到的是 active（commit）def body，非身份数据，拒写。
 * commit def body 形如 `{ tree, meta }`；只判顶层含 `tree` 会误伤顶层恰好含 `tree` 的合法数据，
 * 故要求 `tree` 为字符串且不含任一数据侧特征键。 */
export function isCodeGenFallbackBody(body: unknown): boolean {
  if (!isRecord(body) || typeof body.tree !== 'string') return false
  for (const key of DATA_SIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) return false
  }
  return true
}

// ── 线程键 ────────────────────────────────────────────────────────────────

/** 视图线程 → 槽键：非空字符串原样，否则 `_main`。 */
export function threadKeyOf(activeThread: unknown): string {
  return typeof activeThread === 'string' && activeThread.length > 0 ? activeThread : MAIN_THREAD
}

/** 事件线程与当前视图线程是否同一线程（缺省一律归 `_main`）。 */
export function matchesThread(payloadThread: unknown, activeThread: unknown): boolean {
  return threadKeyOf(payloadThread) === threadKeyOf(activeThread)
}

/** run 级事件的线程键。 */
export function runKeyOf(payload: unknown): string {
  return threadKeyOf(isRecord(payload) ? payload.thread : null)
}

/** run 级事件的 run id；缺失回 null。 */
export function runIdOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  return typeof payload.run === 'string' && payload.run.length > 0 ? payload.run : null
}

// ── 配置读取与合并（整值寄存器：只改本插件负责的字段） ─────────────────────

export function currentVendorOf(config: unknown): string | null {
  return isRecord(config) && typeof config.vendor === 'string' && config.vendor.length > 0
    ? config.vendor
    : null
}

export function currentModelOf(config: unknown): string | null {
  return isRecord(config) && typeof config.model === 'string' && config.model.length > 0
    ? config.model
    : null
}

export interface ModelEntry {
  vendor: string
  id: string
  name: string
}

/** 模型列表：只来自用户配置的 vendor / model 目录，绝不内置模型名。 */
export function modelsOf(config: unknown): ModelEntry[] {
  if (!isRecord(config)) return []
  const providers = config.providers
  if (!isRecord(providers)) return []
  const list: ModelEntry[] = []
  for (const [vendor, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue
    const models = provider.models
    if (!isRecord(models)) continue
    for (const [id, meta] of Object.entries(models)) {
      if (isRecord(meta) && meta.enabled === false) continue
      const name =
        isRecord(meta) && typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : id
      list.push({ vendor, id, name })
    }
  }
  return list
}

/** 所选模型的推理档位：读 `providers.<vendor>.models.<model>.reasoning`；缺 / 非数组回 null。 */
export function reasoningOptionsFromConfig(config: unknown): string[] | null {
  const vendor = currentVendorOf(config)
  const model = currentModelOf(config)
  if (vendor === null || model === null || !isRecord(config)) return null
  const providers = config.providers
  if (!isRecord(providers)) return null
  const provider = providers[vendor]
  if (!isRecord(provider)) return null
  const models = provider.models
  if (!isRecord(models)) return null
  const meta = models[model]
  if (!isRecord(meta)) return null
  const reasoning = meta.reasoning
  return Array.isArray(reasoning)
    ? reasoning.filter((value): value is string => typeof value === 'string')
    : null
}

/** 当前 `params.reasoning`；缺失回 null。 */
export function currentReasoningOf(config: unknown): string | null {
  if (!isRecord(config) || !isRecord(config.params)) return null
  return typeof config.params.reasoning === 'string' ? config.params.reasoning : null
}

export interface CollapseResult {
  collapsed: boolean
  options: string[]
  value?: string
}

/** 档位塌缩：值全同（含单档）→ 折叠为单开关；否则保留档位列表。 */
export function collapseReasoning(options: unknown): CollapseResult {
  if (!Array.isArray(options) || options.length === 0) return { collapsed: false, options: [] }
  const first = options[0]
  const uniform = options.every((value) => value === first)
  return uniform
    ? {
        collapsed: true,
        value: typeof first === 'string' ? first : String(first),
        options: options as string[],
      }
    : { collapsed: false, options: options as string[] }
}

/**
 * 整值配置合并：只改 `change` 点名的字段（vendor / model / permission / reasoning）。
 * `reasoning: null` 表示清除该键（折叠开关关闭）。
 */
export function mergeConfig(config: unknown, change: unknown): Rec {
  const base = isRecord(config) ? config : {}
  const next: Rec = { ...base }
  if (!isRecord(change)) return next
  if (typeof change.vendor === 'string') next.vendor = change.vendor
  if (typeof change.model === 'string') next.model = change.model
  if (typeof change.permission === 'string') next.permission = change.permission
  if (Object.prototype.hasOwnProperty.call(change, 'reasoning')) {
    const params: Rec = isRecord(base.params) ? { ...base.params } : {}
    if (typeof change.reasoning === 'string') params.reasoning = change.reasoning
    else delete params.reasoning
    next.params = params
  }
  return next
}

// ── 权限四档 ──────────────────────────────────────────────────────────────

export function normalizePermission(value: unknown): string {
  return PERMISSIONS.includes(value as string) ? (value as string) : 'review'
}

export function permissionLabelCode(value: unknown): string {
  return PERMISSION_LABEL[normalizePermission(value)]
}

export function permissionDescCode(value: unknown): string {
  return PERMISSION_DESC[normalizePermission(value)]
}

export function permissionIcon(value: unknown): string {
  return PERMISSION_ICON[normalizePermission(value)]
}

// ── 槽与配置写指令 ────────────────────────────────────────────────────────

/** `chat.message` 槽体（发送时写入 `slots[thread]`）。 */
export function buildMessageSlot(text: unknown, attachments: unknown): Rec {
  return {
    kind: 'chat.message',
    text: typeof text === 'string' ? text : '',
    attachments: Array.isArray(attachments) ? (attachments as Json[]) : [],
  }
}

/** 读-改-写：只覆盖本线程键，其余线程键原样保留。 */
export function mergeSlotBody(body: unknown, threadKey: string, slot: Json): Rec {
  const base = isRecord(body) ? body : {}
  const slots: Rec = isRecord(base.slots) ? { ...base.slots } : {}
  slots[threadKey] = slot
  return { ...base, slots }
}

/** `add_gen` 子操作：`expect_active` 仅在读回身份视图（有 active）时携带；`base` 存在即补丁世代。 */
function addGenArgs(identity: string, expectActive?: string | null, base?: number | null): Rec {
  const args: Rec = { id: identity, payload: { $n: 0 }, sig: { $n: 0 }, pins: {} }
  if (expectActive !== undefined) args.expect_active = expectActive
  if (base !== undefined && base !== null) args.base = base
  return args
}

/** `data_gen.seq`（非负整数）；缺失 / 非法回 null。 */
function dataGenSeq(value: unknown): number | null {
  if (!isRecord(value)) return null
  const seq = value.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

/** 顶层字段补丁：变者 replace、缺者 delete；不变者不产 op。 */
function bodyPatches(prev: { [key: string]: Json }, next: { [key: string]: Json }): Json[] {
  const ops: Json[] = []
  for (const key of Object.keys(next)) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      ops.push({ op: 'replace', path: [key], value: next[key] })
    }
  }
  for (const key of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(next, key)) continue
    ops.push({ op: 'delete', path: [key] })
  }
  return ops
}

/** 输入槽补丁：按线程键 `replace ["slots", key]` / `delete ["slots", key]`。 */
function slotPatches(prev: { [key: string]: Json }, next: { [key: string]: Json }): Json[] {
  const prevSlots = isRecord(prev.slots) ? prev.slots : {}
  const nextSlots = isRecord(next.slots) ? next.slots : {}
  const ops: Json[] = []
  for (const key of Object.keys(nextSlots)) {
    if (JSON.stringify(prevSlots[key]) !== JSON.stringify(nextSlots[key])) {
      ops.push({ op: 'replace', path: ['slots', key], value: nextSlots[key] })
    }
  }
  for (const key of Object.keys(prevSlots)) {
    if (Object.prototype.hasOwnProperty.call(nextSlots, key)) continue
    ops.push({ op: 'delete', path: ['slots', key] })
  }
  return ops
}

/** 身份写指令：有数据世代（`dataGen.seq`）且补丁非空 ⇒ `put({ops}) + add_gen(base)`；否则整份 put。 */
export function writeDirective(
  identity: string,
  prev: unknown,
  next: Json,
  expectActive?: string | null,
  dataGen?: unknown,
): Rec {
  const base = dataGenSeq(dataGen)
  if (base !== null && isRecord(prev) && isRecord(next)) {
    const patches = identity === 'input' ? slotPatches(prev, next) : bodyPatches(prev, next)
    if (patches.length > 0) {
      return {
        kind: 'write',
        request: {
          op: 'batch',
          args: { ops: [{ op: 'put', args: { body: { ops: patches } } }, { op: 'add_gen', args: addGenArgs(identity, expectActive, base) }] },
        },
      }
    }
  }
  return {
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          { op: 'put', args: { body: next } },
          { op: 'add_gen', args: addGenArgs(identity, expectActive) },
        ],
      },
    },
  }
}

/** `input` 槽写指令：有数据世代则补丁 + `base`，否则整份 `put` + `add_gen`（同一批）。 */
export function slotWriteDirective(prev: unknown, next: Json, expectActive?: string | null, dataGen?: unknown): Rec {
  return writeDirective('input', prev, next, expectActive, dataGen)
}

/** `config` 写指令：有数据世代则补丁 + `base`，否则整份 `put` + `add_gen`（同一批）。 */
export function configWriteDirective(prev: unknown, next: Json, expectActive?: string | null, dataGen?: unknown): Rec {
  return writeDirective('config', prev, next, expectActive, dataGen)
}

// ── 待发队列（内存、per-thread 键控） ──────────────────────────────────────

export function queueOf(queue: unknown, threadKey: string): Json[] {
  const list = isRecord(queue) ? queue[threadKey] : null
  return Array.isArray(list) ? list : []
}

export function queueCount(queue: unknown, threadKey: string): number {
  return queueOf(queue, threadKey).length
}

export function enqueue(queue: unknown, threadKey: string, message: Json): Rec {
  const next: Rec = { ...(isRecord(queue) ? queue : {}) }
  next[threadKey] = [...queueOf(next, threadKey), message]
  return next
}

/** 放回队首（续发失败时保留反悔通道，不静默丢）。 */
export function enqueueFront(queue: unknown, threadKey: string, message: Json): Rec {
  const next: Rec = { ...(isRecord(queue) ? queue : {}) }
  next[threadKey] = [message, ...queueOf(next, threadKey)]
  return next
}

export interface DequeueResult {
  queue: Rec
  message: Json
}

export function dequeue(queue: unknown, threadKey: string): DequeueResult {
  const list = queueOf(queue, threadKey)
  if (list.length === 0) return { queue: isRecord(queue) ? queue : {}, message: null }
  const [message, ...rest] = list
  const next: Rec = { ...(isRecord(queue) ? queue : {}) }
  if (rest.length === 0) delete next[threadKey]
  else next[threadKey] = rest
  return { queue: next, message }
}

export function removeFromQueue(queue: unknown, threadKey: string, id: unknown): Rec {
  const rest = queueOf(queue, threadKey).filter((item) => !(isRecord(item) && item.id === id))
  const next: Rec = { ...(isRecord(queue) ? queue : {}) }
  if (rest.length === 0) delete next[threadKey]
  else next[threadKey] = rest
  return next
}

export interface MessageSummary {
  text: string
  count: number
}

/** 队内消息摘要（文本 + 附件计数），供待发弹层逐条展示。 */
export function messageSummary(slot: unknown, max = 48): MessageSummary {
  const text =
    isRecord(slot) && typeof slot.text === 'string' ? slot.text.replace(/\s+/g, ' ').trim() : ''
  const count = isRecord(slot) && Array.isArray(slot.attachments) ? slot.attachments.length : 0
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text
  return { text: clipped, count }
}

export interface QueueEntry {
  id: string
  slot: unknown
}

/** 队内条目拆解：`{ id, slot }` 包装取槽体；裸槽（无 `slot` 键）原样当槽体、id 为空。 */
export function queueEntry(message: unknown): QueueEntry {
  if (isRecord(message) && Object.prototype.hasOwnProperty.call(message, 'slot')) {
    return { id: typeof message.id === 'string' ? message.id : '', slot: message.slot }
  }
  return { id: '', slot: message }
}

/** 待发弹层逐行文案：摘要文本 + 附件计数拼装成可显示字符串（组件不再就地拼）。 */
export function messageRowLabel(
  message: unknown,
  t: (code: string, vars?: unknown) => string,
  max = 48,
): string {
  const summary = messageSummary(queueEntry(message).slot, max)
  if (summary.count <= 0) return summary.text
  const attachment = t('composer_attachment', { count: summary.count })
  return summary.text.length > 0 ? `${summary.text} · ${attachment}` : attachment
}

// ── 上下文用量（§16.10 数字格式 + 阈值分档） ───────────────────────────────

function trimZero(value: number): string {
  const fixed = value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

/** token 计数格式：≥1000 保留 1 位小数用 `k`，≥1M 用 `M`。 */
export function formatCount(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (Math.abs(value) >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (Math.abs(value) >= 1000) return `${trimZero(value / 1000)}k`
  return String(Math.trunc(value))
}

export function usageRatio(usage: unknown): number {
  if (!isRecord(usage)) return 0
  const used = typeof usage.used === 'number' && Number.isFinite(usage.used) ? usage.used : 0
  const budget =
    typeof usage.budget === 'number' && Number.isFinite(usage.budget) ? usage.budget : 0
  if (budget <= 0) return used > 0 ? CONTEXT_FULL_RATIO : 0
  return used / budget
}

export function usageTone(usage: unknown): 'muted' | 'warning' | 'danger' {
  const ratio = usageRatio(usage)
  if (ratio >= CONTEXT_FULL_RATIO) return 'danger'
  if (ratio >= CONTEXT_WARNING_RATIO) return 'warning'
  return 'muted'
}

export function usageFull(usage: unknown): boolean {
  return usageRatio(usage) >= CONTEXT_FULL_RATIO
}

export interface UsageView {
  used: number
  budget: number
  usedText: string
  budgetText: string
  tone: 'muted' | 'warning' | 'danger'
  full: boolean
}

/** 用量视图：无 `used` / `budget` 数字回 null（不渲染该行）。 */
export function usageView(usage: unknown): UsageView | null {
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

export interface SourceRow {
  key: string
  code: string | null
  tokens: number
  text: string
}

/** 各来源 token 行；未知来源键原样显示键名。 */
export function sourceRows(usage: unknown): SourceRow[] {
  if (!isRecord(usage)) return []
  const sources = usage.sources
  if (!isRecord(sources)) return []
  const rows: SourceRow[] = []
  for (const [key, value] of Object.entries(sources)) {
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

export interface TrimmedRow {
  label: string
  reason: string
}

/** 被裁剪项行（原因 + 标签）；无 `trimmed` 数组回空。 */
export function trimmedRows(usage: unknown): TrimmedRow[] {
  if (!isRecord(usage) || !Array.isArray(usage.trimmed)) return []
  return usage.trimmed
    .filter((item): item is Rec => isRecord(item))
    .map((item) => ({
      label:
        typeof item.label === 'string' ? item.label : typeof item.id === 'string' ? item.id : '',
      reason: typeof item.reason === 'string' ? item.reason : '',
    }))
}

// ── 配置读取状态（区分「空配置」与「读失败」） ────────────────────────────────

/** >8s 仍在读取的追加提示阈值（与 ui-chat / ui-settings 同档）。 */
export const LOADING_NOTE_MS = 8000

export type ConfigStatus = 'loading' | 'offline' | 'failed' | 'empty' | 'ready'

/** 插件不可达 / 传输中断的错误码：归入 offline（可重试），不当作显式业务失败。 */
export function isUnreachableCode(code: unknown): boolean {
  return code === 'ui_unreachable' || code === 'transport_failed'
}

export interface ConfigStatusInput {
  loading: boolean
  connected: boolean
  error: string | null
  hasConfig: boolean
}

/** 配置状态：读失败（failed / offline）优先于空配置，即使已读到配置也显式化，
 * 避免刷新失败被吞；空配置（读到对象但无模型）是 ready 的正常态，与读失败互不混淆。 */
export function configStatusOf(input: ConfigStatusInput): ConfigStatus {
  if (!input.connected && !input.hasConfig) return 'offline'
  if (input.error !== null) return isUnreachableCode(input.error) ? 'offline' : 'failed'
  if (input.loading && !input.hasConfig) return 'loading'
  if (!input.hasConfig) return 'empty'
  return 'ready'
}

/** 各状态的提示文案码：组件据此渲染，测试据此证明各态互不混淆；ready / empty 无提示。 */
export function configNoticeCode(status: ConfigStatus): string | null {
  if (status === 'loading') return 'composer_config_loading'
  if (status === 'offline') return 'composer_config_offline'
  if (status === 'failed') return 'composer_config_failed'
  return null
}
