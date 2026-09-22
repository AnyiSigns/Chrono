// 侧栏纯数据模型：工作区 / 会话归一、按工作区分组、标题本地过滤、消息链还原。
// 无 DOM、无 IO，全部可脱离浏览器单测。会话读面 = `chat.history` 返回的会话 body。

/** 判定一个值是否为普通对象（非 null、非数组）。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归一查询串：trim + 小写；非字符串回空串。 */
export function normalizeQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : ''
}

/** 归一工作区列表：只留 {id,name,path,missing} 齐全的条目。 */
export function normalizeWorkspaces(value) {
  if (!Array.isArray(value)) return []
  const list = []
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
export function normalizeConversations(body) {
  if (!isRecord(body) || !Array.isArray(body['conversations'])) return []
  const list = []
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
 * 标题本地过滤：大小写不敏感子串匹配，返回命中标记与高亮区间（按码点下标）。
 * 空查询视为全部命中、无区间。
 */
export function matchTitle(title, query) {
  const text = typeof title === 'string' ? title : ''
  const needle = normalizeQuery(query)
  if (needle.length === 0) return { matched: true, ranges: [] }
  const haystack = text.toLowerCase()
  const ranges = []
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    ranges.push([index, index + needle.length])
    from = index + needle.length
  }
  return { matched: ranges.length > 0, ranges }
}

/** 按标题过滤会话列表。 */
export function filterConversations(conversations, query) {
  const needle = normalizeQuery(query)
  if (needle.length === 0) return conversations.slice()
  return conversations.filter((item) => matchTitle(item.title, needle).matched)
}

/**
 * 按工作区分组：分组顺序 = 工作区列表顺序；组内会话顺序 = 会话列表顺序。
 * 工作区已移除（`workspace_id` 不在列表）的会话随之隐藏（数据仍保留在会话身份里）。
 */
export function groupConversations(workspaces, conversations, query) {
  const matched = filterConversations(conversations, query)
  const byWorkspace = new Map()
  for (const conversation of matched) {
    const key = conversation.workspace_id
    if (!byWorkspace.has(key)) byWorkspace.set(key, [])
    byWorkspace.get(key).push(conversation)
  }
  return workspaces.map((workspace) => ({
    workspace,
    sessions: byWorkspace.get(workspace.id) ?? [],
  }))
}

/** 整体空态：无任何工作区，或过滤后无任何可见会话（且无查询）。 */
export function isEmptyView(workspaces, conversations, query) {
  if (workspaces.length === 0) return true
  if (normalizeQuery(query).length > 0) return false
  return conversations.length === 0
}

/**
 * 从 `chat.history` 返回的身份（body + refs）还原某会话的消息链（oldest→newest）。
 * 沿 `head` 的 `prev` 逆序收集、再反转；断链 / 环即停止。
 */
export function conversationMessages(history, conversationId) {
  if (!isRecord(history)) return []
  const refs = isRecord(history['refs']) ? history['refs'] : {}
  const body = isRecord(history['body']) ? history['body'] : null
  const conversations = body !== null && Array.isArray(body['conversations']) ? body['conversations'] : []
  const conversation = conversations.find((item) => isRecord(item) && item['id'] === conversationId)
  if (!isRecord(conversation)) return []
  const head = isRecord(conversation['head']) && typeof conversation['head']['def'] === 'string' ? conversation['head']['def'] : null
  if (head === null) return []
  const backwards = []
  const visited = new Set()
  let current = head
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
