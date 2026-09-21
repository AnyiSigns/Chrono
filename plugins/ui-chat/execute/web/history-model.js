// 展示历史还原（纯函数）：`chat.history` 返回的投影值 = `{body, refs}`。
// 会话 body 只存会话元数据 + 链头，消息 def 在 `refs` 里按 `prev` 串成链；
// 本模块沿 `prev` 从链头逆序取回、反转成展示顺序，并按 `kind` 分派线程视图。

function isRec(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话列表（body.conversations）。 */
export function conversationList(history) {
  const body = isRec(history) && isRec(history.body) ? history.body : null
  const list = body !== null && Array.isArray(body.conversations) ? body.conversations : []
  return list.filter((item) => isRec(item))
}

/** 当前会话 id（body.current）。 */
export function currentConversationId(history) {
  const body = isRec(history) && isRec(history.body) ? history.body : null
  return body !== null && typeof body.current === 'string' ? body.current : null
}

/** 按 id 取会话；未指定时回落 current，再回落首条。 */
export function pickConversation(history, id) {
  const list = conversationList(history)
  const target = typeof id === 'string' && id.length > 0 ? id : currentConversationId(history)
  return (
    list.find((item) => item.id === target) ??
    list.find((item) => item.id === currentConversationId(history)) ??
    list[0] ??
    null
  )
}

/** 线程种类：缺键按 `main`（向后兼容）。 */
export function threadKind(conversation) {
  if (!isRec(conversation)) return 'main'
  const kind = conversation.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : 'main'
}

/** 沿 `prev` 还原展示序：返回 `[{hash, def}]`（旧 → 新）。 */
export function restoreMessages(history, conversation) {
  const refs = isRec(history) && isRec(history.refs) ? history.refs : {}
  const messages = []
  if (!isRec(conversation) || !isRec(conversation.head)) return messages
  const seen = new Set()
  let hash = conversation.head.def
  while (typeof hash === 'string' && isRec(refs[hash]) && !seen.has(hash)) {
    seen.add(hash)
    messages.push({ hash, def: refs[hash] })
    const prev = refs[hash].prev
    hash = isRec(prev) && typeof prev.def === 'string' ? prev.def : null
  }
  messages.reverse()
  return messages
}

/** 一步取全：会话 + 展示序消息。 */
export function loadConversation(history, id) {
  const conversation = pickConversation(history, id)
  return { conversation, messages: restoreMessages(history, conversation) }
}

/**
 * 事件线程过滤（写死）：只处理属于当前视图线程的事件。
 * 无 `active_thread` 时视图线程视为主线程——接受 `null` 与 `_main`。
 */
export function matchesThread(payloadThread, viewThread) {
  const view = typeof viewThread === 'string' && viewThread.length > 0 ? viewThread : null
  const payload = typeof payloadThread === 'string' && payloadThread.length > 0 ? payloadThread : null
  if (view === null) return payload === null || payload === '_main'
  return payload === view
}

/**
 * 数据变更类事件（`thread.*` / `group.message` / `workflow.step`）的目标线程：
 * 优先 `payload.conversation`（若有，指向目标会话），缺失才回落 `payload.thread`。
 */
export function dataChangeTarget(payload) {
  if (!isRec(payload)) return null
  if (typeof payload.conversation === 'string' && payload.conversation.length > 0) return payload.conversation
  if (typeof payload.thread === 'string' && payload.thread.length > 0) return payload.thread
  return null
}

/** 消息 id（无 id 时用 def 哈希兜底，供锚点 / key 使用）。 */
export function messageId(entry) {
  if (!isRec(entry)) return ''
  const def = isRec(entry.def) ? entry.def : {}
  if (typeof def.id === 'string' && def.id.length > 0) return def.id
  return typeof entry.hash === 'string' ? entry.hash : ''
}

/** 消息正文文本（供群聊 / 纯文本场景；parts 存在时优先拼 text part）。 */
export function messageText(def) {
  if (!isRec(def)) return ''
  if (Array.isArray(def.parts)) {
    const parts = def.parts
      .filter((part) => isRec(part) && (part.type === 'text' || part.type === undefined) && typeof part.text === 'string')
      .map((part) => part.text)
    if (parts.length > 0) return parts.join('\n')
  }
  return typeof def.content === 'string' ? def.content : ''
}
