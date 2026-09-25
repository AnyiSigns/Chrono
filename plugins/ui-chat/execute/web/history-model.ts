// 展示历史还原（纯函数）：`chat.history` 返回的投影值 = `{body, refs}`。
// 会话 body 只存会话元数据 + 链头，消息 def 在 `refs` 里按 `prev` 串成链；
// 本模块沿 `prev` 从链头逆序取回、反转成展示顺序，并按 `kind` 分派线程视图。

import { formatText } from './messages.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话列表（body.conversations）。 */
export function conversationList(history: any): any[] {
  const body = isRec(history) && isRec(history.body) ? history.body : null
  const list = body !== null && Array.isArray(body.conversations) ? body.conversations : []
  return list.filter((item: unknown) => isRec(item))
}

/** 当前会话 id（body.current）。 */
export function currentConversationId(history: any): string | null {
  const body = isRec(history) && isRec(history.body) ? history.body : null
  return body !== null && typeof body.current === 'string' ? body.current : null
}

/** 按 id 取会话；未指定时回落 current，再回落首条。 */
export function pickConversation(history: any, id: unknown): any {
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
export function threadKind(conversation: any): string {
  if (!isRec(conversation)) return 'main'
  const kind = conversation.kind
  return typeof kind === 'string' && kind.length > 0 ? kind : 'main'
}

/** 沿 `prev` 还原展示序：返回 `[{hash, def}]`（旧 → 新）。 */
export function restoreMessages(history: any, conversation: any): any[] {
  const refs = isRec(history) && isRec(history.refs) ? history.refs : {}
  const messages: any[] = []
  if (!isRec(conversation) || !isRec(conversation.head)) return messages
  const seen = new Set<string>()
  let hash: any = conversation.head.def
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
export function loadConversation(history: any, id: unknown): { conversation: any; messages: any[] } {
  const conversation = pickConversation(history, id)
  return { conversation, messages: restoreMessages(history, conversation) }
}

/**
 * 事件线程过滤（写死）：只处理属于当前视图线程的事件。
 * 无 `active_thread` 时视图线程视为主线程——接受 `null` 与 `_main`。
 */
export function matchesThread(payloadThread: unknown, viewThread: unknown): boolean {
  const view = typeof viewThread === 'string' && viewThread.length > 0 ? viewThread : null
  const payload = typeof payloadThread === 'string' && payloadThread.length > 0 ? payloadThread : null
  if (view === null) return payload === null || payload === '_main'
  return payload === view
}

/**
 * 数据变更类事件（`thread.*` / `group.message` / `workflow.step`）的目标线程：
 * 优先 `payload.conversation`（若有，指向目标会话），缺失才回落 `payload.thread`。
 */
export function dataChangeTarget(payload: unknown): string | null {
  if (!isRec(payload)) return null
  if (typeof payload.conversation === 'string' && payload.conversation.length > 0) return payload.conversation
  if (typeof payload.thread === 'string' && payload.thread.length > 0) return payload.thread
  return null
}

/**
 * 该 `run.finished` 是否收束本轮流式：仅当存在在途流且其 run 与事件 run 一致时成立。
 * run 缺失 / 非字符串时一律不收束，避免把无关 run 的终局当成本回合结束而重拉历史。
 */
export function finishesCurrentStream(stream: any, run: unknown): boolean {
  if (stream === null || stream === undefined) return false
  if (typeof run !== 'string' || run.length === 0) return false
  return stream.run === run
}

/** 周期 run 不是对话回合：其 `run.finished` 不处理。 */
export function isPeriodicRun(origin: unknown): boolean {
  return origin === 'periodic'
}

/** 对话回合命令：只有这些命令产生真正的流式对话回合，管理命令 / 槽写 run 不建流。 */
const CHAT_TURN_COMMANDS = ['chat.send', 'chat.resume']

/** 该 run 是否为对话回合：按宿主 run 生命周期载荷里的命令名判定。 */
export function isChatTurnRun(payload: unknown): boolean {
  if (!isRec(payload)) return false
  const name = payload.name
  return typeof name === 'string' && CHAT_TURN_COMMANDS.includes(name)
}

/** 子代理头文字：有父会话时 `{agent} · 由 {parent} 触发`，否则只给 agent 名。 */
export function subagentHeader(agentName: string, parentName: string): string {
  if (parentName.length === 0) return agentName
  return formatText('chat_subagent_triggered', { agent: agentName, parent: parentName })
}

/** 消息 id（无 id 时用 def 哈希兜底，供锚点 / key 使用）。 */
export function messageId(entry: any): string {
  if (!isRec(entry)) return ''
  const def = isRec(entry.def) ? entry.def : {}
  if (typeof def.id === 'string' && def.id.length > 0) return def.id
  return typeof entry.hash === 'string' ? entry.hash : ''
}

/**
 * 尾部若干条内是否存在同文用户消息（乐观渲染收口判定）。
 * 定稿快照里 user 后跟 assistant，故不能只看最后一条；只看尾部避免历史深处同文误判。
 */
export function hasUserMessage(messages: any[], text: string, depth = 4): boolean {
  if (!Array.isArray(messages) || text.length === 0) return false
  return messages.slice(-depth).some(
    (entry) =>
      isRec(entry) &&
      isRec(entry.def) &&
      entry.def.role === 'user' &&
      messageText(entry.def) === text,
  )
}

/** 消息正文文本（供群聊 / 纯文本场景；parts 存在时优先拼 text part）。 */
export function messageText(def: any): string {
  if (!isRec(def)) return ''
  if (Array.isArray(def.parts)) {
    const parts = def.parts
      .filter((part: any) => isRec(part) && (part.type === 'text' || part.type === undefined) && typeof part.text === 'string')
      .map((part: any) => part.text)
    if (parts.length > 0) return parts.join('\n')
  }
  return typeof def.content === 'string' ? def.content : ''
}
