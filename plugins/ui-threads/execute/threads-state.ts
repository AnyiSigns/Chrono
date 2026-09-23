// `threads.state` 的服务侧装配（纯函数）：入口 term 把投影切片 `ctx.ids` 随 args 传入，
// 本模块从传入的投影里取 #11 线程字段与 #47 待办清单，组装顶栏标签数据；服务不读投影。
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

/** 新建会话的缺省标题（与 #11 的缺省一致）；缺省标题在顶栏显示为「对话」。 */
export const DEFAULT_CONVERSATION_TITLE = '新对话'

function projectionOf(ids: Json, identity: string): Rec | null {
  if (!isRecord(ids)) return null
  const entry = ids[identity]
  return isRecord(entry) ? entry : null
}

function bodyOf(projection: Rec | null): Rec {
  return projection !== null && isRecord(projection['body']) ? (projection['body'] as Rec) : {}
}

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

function tagOf(conversation: Rec): ThreadTag {
  const title = conversationTitle(conversation)
  const pending = pendingOf(conversation)
  return {
    thread: conversation['id'] as string,
    kind: conversationKind(conversation),
    title,
    default_title: isDefaultTitle(title),
    status: statusOf(conversation),
    pending: { approval: pending.approval, question: pending.question },
    badge: badgeOf(conversation) as Json,
  }
}

interface TodoView {
  conversation: string
  total: number
  done: number
  pending: number
  items: Rec[]
}

/** 从 #47 投影的条目链（`tail` 沿 `prev` 回溯）解析某会话清单；`refs` 由投影闭包提供。 */
function resolveTodoItems(todoProjection: Rec | null, conversationId: string): Rec[] {
  if (todoProjection === null) return []
  const body = bodyOf(todoProjection)
  const conversations = isRecord(body['conversations']) ? (body['conversations'] as Rec) : {}
  const entry = conversations[conversationId]
  if (!isRecord(entry) || !isRecord(entry['items'])) return []
  const tailField = (entry['items'] as Rec)['tail']
  const tail = isRecord(tailField) && typeof tailField['def'] === 'string' ? (tailField['def'] as string) : null
  if (tail === null) return []
  const refs = isRecord(todoProjection['refs']) ? (todoProjection['refs'] as Rec) : {}
  const backwards: Rec[] = []
  const seen = new Set<string>()
  let current: string | null = tail
  while (current !== null) {
    if (seen.has(current)) break
    seen.add(current)
    const raw = refs[current]
    if (!isRecord(raw)) break
    backwards.push(raw)
    const prev = raw['prev']
    current = isRecord(prev) && typeof prev['def'] === 'string' ? (prev['def'] as string) : null
  }
  return backwards.reverse().map((raw) => {
    const item: Rec = {}
    for (const key of ['id', 'text', 'status', 'priority', 'at']) {
      if (raw[key] !== undefined) item[key] = raw[key]
    }
    return item
  })
}

/** 当前父会话的待办视图；无未完成项（或清单空 / 清空）返回 null（标签位消失）。 */
function todoViewOf(ids: Json, rootId: string | null): TodoView | null {
  if (rootId === null) return null
  const projection = projectionOf(ids, 'todo')
  const items = resolveTodoItems(projection, rootId)
  if (items.length === 0) return null
  const done = items.filter((item) => item['status'] === 'completed').length
  const pending = items.length - done
  if (pending === 0) return null
  return { conversation: rootId, total: items.length, done, pending, items }
}

/**
 * 顶栏标签数据：`{ok, current, root, tags, todo}`。
 * - `current` = #11 会话 `current`（`current` ↔ `active_thread` 单桥用）；
 * - `root` = 当前父（main）线程；`tags` = 该父会话 + `parent` 闭包内线程（树序）；
 * - `todo` = 当前父会话有未完成项时的待办视图，否则 null。
 */
export function assembleThreadsState(ids: Json): Rec {
  const session = projectionOf(ids, 'session')
  const body = bodyOf(session)
  const conversations = activeConversations(body['conversations'] as Json).filter(isRecord)
  const current = typeof body['current'] === 'string' && (body['current'] as string).length > 0 ? (body['current'] as string) : null
  const root = resolveRootMainId(conversations, current)
  const byId = new Map<string, Rec>()
  for (const conversation of conversations) {
    const id = conversation['id']
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, conversation)
  }
  const tags: Json[] = []
  for (const id of orderSubtree(conversations, root)) {
    const conversation = byId.get(id)
    if (conversation !== undefined) tags.push(tagOf(conversation) as unknown as Json)
  }
  return {
    ok: true,
    current,
    root: root === null ? null : root,
    tags,
    todo: (todoViewOf(ids, root) as unknown as Json) ?? null,
  }
}
