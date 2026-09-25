// 侧栏纯数据模型：工作区 / 会话归一、按工作区分组、标题本地过滤、消息链还原。
// 无 DOM、无 IO，全部可脱离浏览器单测。会话读面 = `chat.history` 返回的会话 body。

export interface Workspace {
  id: string
  name: string
  path: string
  missing: boolean
}

export interface Conversation {
  id: string
  workspace_id: string | null
  title: string
  count: number
  status: string | null
  pending: unknown
  inbox: unknown
  kind: string
  head: string | null
}

export interface ConversationGroup {
  workspace: Workspace
  sessions: Conversation[]
}

export interface MatchResult {
  matched: boolean
  ranges: number[][]
}

/** 判定一个值是否为普通对象（非 null、非数组）。 */
export function isRecord(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 身份视图 → data body；非身份视图（裸 body）原样返回。 */
export function identityBody(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'body') ? value.body : value
}

/** 输入槽写口：`input` owner 的 `input.write` 命令（服务写自有持久存储，不再构造世界写 directive）。 */
export function slotWriteCommand(threadKey: string, slot: any): { name: string; args: { [key: string]: any } } {
  return { name: 'input.write', args: { thread: threadKey, slot: slot ?? null } }
}

/** 配置写口：`config` owner 的 `config.write` 命令（服务按补丁读-改-写自有持久存储）。 */
export function configWriteCommand(patch: { [key: string]: any }): { name: string; args: { [key: string]: any } } {
  return { name: 'config.write', args: { patch } }
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

/** 归一查询串：trim + 小写；非字符串回空串。 */
export function normalizeQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

/** 归一工作区列表：只留 {id,name,path,missing} 齐全的条目。 */
export function normalizeWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return []
  const list: Workspace[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = typeof item['id'] === 'string' && item['id'].length > 0 ? item['id'] : null
    if (id === null) continue
    list.push({
      id,
      name: typeof item['name'] === 'string' && item['name'].length > 0 ? item['name'] : id,
      path: typeof item['path'] === 'string' ? item['path'] : '',
      missing: item['missing'] === true,
    })
  }
  return list
}

/** 归一会话列表：滤除软删（`deleted_at` 非空）与形态非法项。 */
export function normalizeConversations(body: unknown): Conversation[] {
  if (!isRecord(body) || !Array.isArray(body['conversations'])) return []
  const list: Conversation[] = []
  for (const item of body['conversations']) {
    if (!isRecord(item)) continue
    const id = typeof item['id'] === 'string' && item['id'].length > 0 ? item['id'] : null
    if (id === null) continue
    if (item['deleted_at'] !== null && item['deleted_at'] !== undefined) continue
    list.push({
      id,
      workspace_id: typeof item['workspace_id'] === 'string' ? item['workspace_id'] : null,
      title: typeof item['title'] === 'string' && item['title'].length > 0 ? item['title'] : '',
      count: typeof item['count'] === 'number' && Number.isInteger(item['count']) ? item['count'] : 0,
      status: typeof item['status'] === 'string' ? item['status'] : null,
      pending: isRecord(item['pending']) ? item['pending'] : null,
      inbox: isRecord(item['inbox']) ? item['inbox'] : null,
      kind: typeof item['kind'] === 'string' ? item['kind'] : 'main',
      head: isRecord(item['head']) && typeof item['head']['def'] === 'string' ? item['head']['def'] : null,
    })
  }
  return list
}

/**
 * 标题本地过滤：大小写不敏感子串匹配，返回命中标记与高亮区间（按原串下标）。
 * 空查询视为全部命中、无区间。
 * 大小写折叠可能改变长度（如 `İ` → `i̇`），此时 `toLowerCase()` 的下标与原串不再一一对应，
 * 故长度不等时改用逐位比对，保证区间始终落在原串上、不越界 / 不错位。
 */
export function matchTitle(title: unknown, query: unknown): MatchResult {
  const text = typeof title === 'string' ? title : ''
  const needle = normalizeQuery(query)
  if (needle.length === 0) return { matched: true, ranges: [] }
  const haystack = text.toLowerCase()
  const ranges: number[][] = []
  if (haystack.length === text.length) {
    let from = 0
    for (;;) {
      const index = haystack.indexOf(needle, from)
      if (index < 0) break
      ranges.push([index, index + needle.length])
      from = index + needle.length
    }
    return { matched: ranges.length > 0, ranges }
  }
  let from = 0
  while (from + needle.length <= text.length) {
    if (text.slice(from, from + needle.length).toLowerCase() === needle) {
      ranges.push([from, from + needle.length])
      from += needle.length
    } else {
      from += 1
    }
  }
  return { matched: ranges.length > 0, ranges }
}

/** 按标题过滤会话列表。 */
export function filterConversations(conversations: Conversation[], query: unknown): Conversation[] {
  const needle = normalizeQuery(query)
  if (needle.length === 0) return conversations.slice()
  return conversations.filter((item) => matchTitle(item.title, needle).matched)
}

/**
 * 按工作区分组：分组顺序 = 工作区列表顺序；组内会话顺序 = 会话列表顺序。
 * 工作区已移除（`workspace_id` 不在列表）的会话随之隐藏（数据仍保留在会话身份里）。
 */
export function groupConversations(
  workspaces: Workspace[],
  conversations: Conversation[],
  query: unknown,
): ConversationGroup[] {
  const matched = filterConversations(conversations, query)
  const byWorkspace = new Map<string | null, Conversation[]>()
  for (const conversation of matched) {
    const key = conversation.workspace_id
    if (!byWorkspace.has(key)) byWorkspace.set(key, [])
    byWorkspace.get(key)!.push(conversation)
  }
  return workspaces.map((workspace) => ({
    workspace,
    sessions: byWorkspace.get(workspace.id) ?? [],
  }))
}

/**
 * 未分组会话：`workspace_id` 为 null（未绑定）或不在工作区列表（工作区已移除）的会话。
 * `groupConversations` 只按已知工作区出组，这些会话会静默消失；此函数把它们显式收拢，
 * 供视图层单列「未分组」桶，避免不可见。过滤口径与 `filterConversations` 一致。
 */
export function ungroupedConversations(
  workspaces: Workspace[],
  conversations: Conversation[],
  query: unknown,
): Conversation[] {
  const known = new Set(workspaces.map((workspace) => workspace.id))
  return filterConversations(conversations, query).filter(
    (conversation) => conversation.workspace_id === null || !known.has(conversation.workspace_id),
  )
}

/**
 * 整体空态：**只有没有任何工作区时**才算空。有工作区就渲染工作区列表——
 * 会话为空只是各组为空，不应把工作区列表一并藏掉（删光会话后仍要能看见 / 进入工作区）。
 * 过滤无结果另走 `sidebar_no_match`（视图层按 query 判定），不归此函数。
 */
export function isEmptyView(workspaces: unknown[]): boolean {
  return workspaces.length === 0
}

/**
 * 从 `chat.history` 返回的身份（body + refs）还原某会话的消息链（oldest→newest）。
 * 沿 `head` 的 `prev` 逆序收集、再反转；断链 / 环即停止。
 */
export function conversationMessages(history: unknown, conversationId: unknown): any[] {
  if (!isRecord(history)) return []
  const refs = isRecord(history['refs']) ? history['refs'] : {}
  const body = isRecord(history['body']) ? history['body'] : null
  const conversations = body !== null && Array.isArray(body['conversations']) ? body['conversations'] : []
  const conversation = conversations.find((item: unknown) => isRecord(item) && item['id'] === conversationId)
  if (!isRecord(conversation)) return []
  const head =
    isRecord(conversation['head']) && typeof conversation['head']['def'] === 'string'
      ? conversation['head']['def']
      : null
  if (head === null) return []
  const backwards: any[] = []
  const visited = new Set<string>()
  let current: unknown = head
  while (typeof current === 'string' && current.length > 0) {
    if (visited.has(current)) break
    visited.add(current)
    const message = refs[current]
    if (!isRecord(message)) break
    backwards.push(message)
    const prev = message['prev']
    current = isRecord(prev) && typeof prev['def'] === 'string' ? prev['def'] : null
  }
  return backwards.reverse()
}
