// 会话导出（客户端生成，不写世界、不需后端）：从 `chat.history` 窗口生成 markdown / JSON。
// 纯函数、可单测：输入为归一后的会话条目与消息 def 数组（oldest→newest）。

import { conversationMessages } from './sidebar-model.js'

/** 一条消息的纯文本：`content` 优先；否则拼接 `parts` 里的文本段。 */
export function messageText(def) {
  if (def === null || typeof def !== 'object') return ''
  if (typeof def.content === 'string' && def.content.length > 0) return def.content
  if (Array.isArray(def.parts)) {
    const chunks = []
    for (const part of def.parts) {
      if (part !== null && typeof part === 'object' && typeof part.text === 'string') chunks.push(part.text)
    }
    return chunks.join('\n')
  }
  return ''
}

/** 角色标签：user / assistant / system；未知按 assistant。 */
export function roleLabel(def) {
  const role = def !== null && typeof def === 'object' && typeof def.role === 'string' ? def.role : 'assistant'
  return role === 'user' || role === 'system' ? role : 'assistant'
}

/** 生成 markdown 文本。 */
export function exportMarkdown(conversation, messages) {
  const title = conversation !== null && typeof conversation.title === 'string' && conversation.title.length > 0 ? conversation.title : 'conversation'
  const lines = [`# ${title}`, '']
  if (conversation !== null && typeof conversation.id === 'string') lines.push(`- id: ${conversation.id}`)
  if (conversation !== null && typeof conversation.workspace_id === 'string') lines.push(`- workspace: ${conversation.workspace_id}`)
  lines.push(`- messages: ${messages.length}`, '')
  for (const message of messages) {
    lines.push(`## ${roleLabel(message)}`, '', messageText(message), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 生成 JSON 文本。 */
export function exportJson(conversation, messages) {
  const payload = {
    id: conversation !== null && typeof conversation.id === 'string' ? conversation.id : null,
    title: conversation !== null && typeof conversation.title === 'string' ? conversation.title : 'conversation',
    workspace_id: conversation !== null && typeof conversation.workspace_id === 'string' ? conversation.workspace_id : null,
    exported_at: null,
    messages: messages.map((message) => ({
      id: message !== null && typeof message.id === 'string' ? message.id : null,
      role: roleLabel(message),
      content: messageText(message),
      at: message !== null && typeof message.at === 'string' ? message.at : null,
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 从会话还原消息链（委托 `conversationMessages`，便于导出层单点调用）。 */
export function messagesOf(history, conversationId) {
  return conversationMessages(history, conversationId)
}

/** 文件名安全化：去掉路径分隔与保留字符，空则回落 `conversation`。 */
export function safeFilename(title) {
  const text = typeof title === 'string' ? title : ''
  const invalid = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
  let cleaned = ''
  for (const ch of text) {
    cleaned += invalid.has(ch) || ch.charCodeAt(0) < 32 ? '-' : ch
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'conversation'
}

/** 导出文件名：`<安全标题>.<ext>`。 */
export function exportFilename(conversation, ext) {
  const title = conversation !== null && typeof conversation.title === 'string' ? conversation.title : 'conversation'
  const suffix = typeof ext === 'string' && ext.length > 0 ? ext : 'md'
  return `${safeFilename(title)}.${suffix}`
}

/** 依据格式取正文（`md` / `json`）。 */
export function exportBody(format, conversation, messages) {
  return format === 'json' ? exportJson(conversation, messages) : exportMarkdown(conversation, messages)
}
