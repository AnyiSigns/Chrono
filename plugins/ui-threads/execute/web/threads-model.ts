// 线程树与角标的纯逻辑（无 DOM、无 IO、无文案、无 react import）：服务侧装配与浏览器侧渲染共用。
// 线程 = #11 会话条目（kind / parent / title / status / pending）；本模块只做机械归组与映射。

export type Rec = { [key: string]: unknown }

/** 线程种类（#11 会话 `kind`；缺键 = `main`，向后兼容）。 */
export const THREAD_KINDS = ['main', 'subagent', 'group', 'workflow']

/** 对象判定（纯数据，无原型链访问）。 */
export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 线程种类：`kind` 非法 / 缺失回 `main`。 */
export function conversationKind(conversation: unknown): string {
  const kind = isRecord(conversation) ? conversation.kind : null
  return THREAD_KINDS.includes(kind as string) ? (kind as string) : 'main'
}

/** 父线程 id：`parent.def` 为字符串时返回它，否则 null。 */
export function parentIdOf(conversation: unknown): string | null {
  if (!isRecord(conversation)) return null
  const parent = conversation.parent
  if (!isRecord(parent)) return null
  return typeof parent.def === 'string' && parent.def.length > 0 ? parent.def : null
}

/** 会话标题：字符串则原样，否则空串。 */
export function conversationTitle(conversation: unknown): string {
  const title = isRecord(conversation) ? conversation.title : null
  return typeof title === 'string' ? title : ''
}

/** 软删会话（`deleted_at` 非空）不进顶栏。 */
export function isDeleted(conversation: unknown): boolean {
  if (!isRecord(conversation)) return true
  return conversation.deleted_at !== null && conversation.deleted_at !== undefined
}

/** 过滤掉软删会话，保留原数组顺序。 */
export function activeConversations(conversations: unknown): Rec[] {
  if (!Array.isArray(conversations)) return []
  return conversations.filter((item): item is Rec => isRecord(item) && !isDeleted(item))
}

function indexById(conversations: Rec[]): Map<string, Rec> {
  const byId = new Map<string, Rec>()
  for (const conversation of conversations) {
    const id = conversation.id
    if (typeof id === 'string' && id.length > 0 && !byId.has(id)) byId.set(id, conversation)
  }
  return byId
}

function firstMainId(conversations: Rec[]): string | null {
  for (const conversation of conversations) {
    if (conversationKind(conversation) === 'main') return conversation.id as string
  }
  const first = conversations[0]
  return isRecord(first) && typeof first.id === 'string' ? first.id : null
}

/**
 * 当前父（main）线程：从 `current` 沿 `parent` 上溯到 `kind = main` 的祖先；
 * `current` 缺失 / 不在列表时回落第一条 main；无 main 则回落首条会话。防环。
 */
export function resolveRootMainId(conversations: unknown, current: unknown): string | null {
  const list = activeConversations(conversations)
  const byId = indexById(list)
  let id: string | null =
    typeof current === 'string' && byId.has(current) ? current : firstMainId(list)
  if (id === null || !byId.has(id)) return id
  const seen = new Set<string>()
  while (id !== null && byId.has(id) && !seen.has(id)) {
    seen.add(id)
    const conversation = byId.get(id) as Rec
    if (conversationKind(conversation) === 'main') return id
    const parent = parentIdOf(conversation)
    id = parent !== null && byId.has(parent) ? parent : null
  }
  return seen.size > 0 ? [...seen][seen.size - 1] : null
}

/**
 * 以 `rootId` 为根的线程树深度优先前序：根在前，子线程按 `parent` 归组、
 * 同级保持会话列表原序。不在根闭包内的会话（含孤儿）不返回。
 */
export function orderSubtree(conversations: unknown, rootId: unknown): string[] {
  if (typeof rootId !== 'string' || rootId.length === 0) return []
  const list = activeConversations(conversations)
  const byId = indexById(list)
  if (!byId.has(rootId)) return []
  const childrenOf = new Map<string, string[]>()
  for (const conversation of list) {
    const parent = parentIdOf(conversation)
    if (parent === null) continue
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    ;(childrenOf.get(parent) as string[]).push(conversation.id as string)
  }
  const ordered: string[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id) || !byId.has(id)) return
    seen.add(id)
    ordered.push(id)
    for (const child of childrenOf.get(id) ?? []) visit(child)
  }
  visit(rootId)
  return ordered
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 线程 `status`（字符串），缺失回空串。 */
export function statusOf(conversation: unknown): string {
  const status = isRecord(conversation) ? conversation.status : null
  return typeof status === 'string' ? status : ''
}

/** 线程 `pending`（待裁决 / 待审批计数）。 */
export function pendingOf(conversation: unknown): { approval: number; question: number } {
  const pending = isRecord(conversation) ? conversation.pending : null
  return {
    approval: numberOrZero(isRecord(pending) ? pending.approval : null),
    question: numberOrZero(isRecord(pending) ? pending.question : null),
  }
}

/**
 * 状态角标（同源 `thread.updated` 的 `status` / `pending`）：
 * 待审批 / 待作答 > 运行中 > 完成 > 失败；`waiting` / `blocked` 无角标。
 */
export function badgeOf(conversation: unknown): string | null {
  const pending = pendingOf(conversation)
  if (pending.approval > 0 || pending.question > 0) return 'pending'
  const status = statusOf(conversation)
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed' || status === 'terminated') return 'failed'
  return null
}

/** 角标 → 视觉色调键（浏览器侧映射到 token）。 */
export function badgeTone(badge: unknown): string | null {
  return badge === 'running' || badge === 'pending' || badge === 'done' || badge === 'failed'
    ? (badge as string)
    : null
}

/** 数据变更类事件的线程归属：`payload.thread` 优先，其次 `payload.conversation`。 */
export function dataChangeTarget(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  if (typeof payload.thread === 'string' && payload.thread.length > 0) return payload.thread
  if (typeof payload.conversation === 'string' && payload.conversation.length > 0) {
    return payload.conversation
  }
  return null
}

/** 文案键：按种类取标签兜底（真实文案住 messages.ts，本模块不带文案）。 */
export function threadLabelKey(kind: unknown): string {
  return THREAD_KINDS.includes(kind as string) ? `thread_label_${kind as string}` : 'thread_label_main'
}
