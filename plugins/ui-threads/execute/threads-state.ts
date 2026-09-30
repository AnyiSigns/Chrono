// `threads.state` 的服务侧装配（纯函数）：入参 = owner 服务读回的数据
// （`session.list` 的会话清单 + `todo.invoke(todo.read)` 的清单结果）。
// session / todo 已出世界（住各自 ④ 存储），故服务不读世界投影、不再走 `ctx.ids`。
// 线程树排序 / 父会话隔离 / 角标映射住 `web/threads-model.ts`（服务与浏览器共用同一份纯逻辑）。

import {
  activeConversations,
  badgeOf,
  conversationKind,
  conversationTitle,
  isRecord,
  orderSubtree,
  pendingOf,
  resolveRootMainId,
  statusOf,
} from './web/threads-model.ts'
import type { Json, Rec } from './types.ts'

/** 新建会话的缺省标题（与 session 一致）；缺省标题在顶栏显示为「对话」。 */
export const DEFAULT_CONVERSATION_TITLE = '新对话'

function isDefaultTitle(title: string): boolean {
  return title.length === 0 || title === DEFAULT_CONVERSATION_TITLE
}

interface ThreadTag {
  thread: string
  kind: string
  title: string
  default_title: boolean
  status: string
  pending: Rec
  badge: Json
}

function tagOf(conversation: Rec, openTurn: boolean): ThreadTag {
  const title = conversationTitle(conversation)
  const pending = pendingOf(conversation)
  return {
    thread: conversation['id'] as string,
    kind: conversationKind(conversation),
    title,
    default_title: isDefaultTitle(title),
    status: statusOf(conversation),
    pending: { approval: pending.approval, question: pending.question },
    badge: badgeOf(conversation, openTurn) as Json,
  }
}

/** 有仍开着回合的会话 id 集合（`session.list.open_turns` 摘要，跨会话）。 */
function openTurnConversations(session: Json): Set<string> {
  const open: Set<string> = new Set()
  if (!isRecord(session) || !Array.isArray(session['open_turns'])) return open
  for (const raw of session['open_turns']) {
    if (isRecord(raw) && typeof raw['conv'] === 'string' && raw['conv'].length > 0) open.add(raw['conv'])
  }
  return open
}

interface TodoView {
  conversation: string
  total: number
  done: number
  pending: number
  items: Rec[]
}

/** owner `todo.read` 结果的条目字段（只取对外声明字段，不暴露内部字段）。 */
const TODO_ITEM_KEYS = ['id', 'text', 'status', 'activeForm', 'at'] as const

function todoItemsOf(todo: Json): Rec[] {
  if (!isRecord(todo) || !Array.isArray(todo['items'])) return []
  const items: Rec[] = []
  for (const raw of todo['items']) {
    if (!isRecord(raw)) continue
    const item: Rec = {}
    for (const key of TODO_ITEM_KEYS) {
      if (raw[key] !== undefined) item[key] = raw[key]
    }
    items.push(item)
  }
  return items
}

/** 当前父会话的待办视图；无未完成项（或清单空 / 清空）返回 null（标签位消失）。 */
function todoViewOf(todo: Json, rootId: string | null): TodoView | null {
  if (rootId === null) return null
  const items = todoItemsOf(todo)
  if (items.length === 0) return null
  const done = items.filter((item) => item['status'] === 'completed').length
  const pending = items.filter((item) => item['status'] === 'pending' || item['status'] === 'in_progress').length
  if (pending === 0) return null
  return { conversation: rootId, total: items.length, done, pending, items }
}

/**
 * 顶栏标签数据：`{ok, current, root, tags, todo}`。
 * - `session` = owner `session.list` 的清单（`{version,current,conversations,open_turns}`）；
 *   会话有仍开着的回合（`open_turns` 含该会话）时其角标为运行中，不读 `conversation.status`；
 * - `todo` = owner `todo.read` 的清单结果（`{items,...}`），缺省 / 取不到传 null；
 * - `current` = session `current`（`current` ↔ `active_thread` 单桥用）；
 * - `root` = 当前父（main）线程；`tags` = 该父会话 + `parent` 闭包内线程（树序）；
 * - `todo` = 当前父会话有未完成项时的待办视图，否则 null。
 */
export function assembleThreadsState(session: Json, todo: Json = null): Rec {
  const body = isRecord(session) ? session : {}
  const conversations = activeConversations(body['conversations']).filter(isRecord)
  const current =
    typeof body['current'] === 'string' && (body['current'] as string).length > 0
      ? (body['current'] as string)
      : null
  const root = resolveRootMainId(conversations, current)
  const byId = new Map<string, Rec>()
  for (const conversation of conversations) {
    const id = conversation['id']
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, conversation)
  }
  const openTurns = openTurnConversations(body)
  const tags: Json[] = []
  for (const id of orderSubtree(conversations, root)) {
    const conversation = byId.get(id)
    if (conversation !== undefined) tags.push(tagOf(conversation, openTurns.has(id)) as unknown as Json)
  }
  return {
    ok: true,
    current,
    root: root === null ? null : root,
    tags,
    todo: (todoViewOf(todo, root) as unknown as Json) ?? null,
  }
}
