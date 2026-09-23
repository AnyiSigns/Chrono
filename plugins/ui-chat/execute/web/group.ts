// 群聊视图模型（纯函数）：首字母圆标 + 名、同发言人连续只在首条显名、
// 当前发言者标记、未读锚点索引；「我」仍走用户气泡。

import { messageId, messageText } from './history-model.ts'
import { UI_TEXT } from './messages.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function initialOf(name: unknown): string {
  const text = String(name ?? '').trim()
  if (text.length === 0) return '?'
  return Array.from(text)[0]
}

function speakerOf(def: any, conversation: any): { id: string; name: string } {
  if (!isRec(def)) return { id: 'agent', name: UI_TEXT.chat_agent }
  if (def.role === 'user') return { id: 'user', name: UI_TEXT.chat_me }
  const meta = isRec(def.meta) ? def.meta : {}
  const agent = isRec(def.agent) ? def.agent : {}
  const id =
    (typeof meta.speaker === 'string' && meta.speaker) ||
    (typeof meta.agent === 'string' && meta.agent) ||
    (typeof def.speaker === 'string' && def.speaker) ||
    (typeof agent.def === 'string' && agent.def) ||
    (isRec(conversation) && isRec(conversation.agent) && typeof conversation.agent.def === 'string' ? conversation.agent.def : '') ||
    'agent'
  const name = (typeof meta.speaker_name === 'string' && meta.speaker_name) || (typeof def.speaker_name === 'string' && def.speaker_name) || id
  return { id, name }
}

function lastParticipantSpeaker(messages: any[], conversation: any): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const def = isRec(messages[i]) ? messages[i].def : null
    if (isRec(def) && def.role === 'user') continue
    return speakerOf(def, conversation).id
  }
  return null
}

/** 群聊视图模型。 */
export function groupViewModel(input: any): { items: any[]; participants: any[]; anchorIndex: number } {
  const conversation = isRec(input?.conversation) ? input.conversation : null
  const refs = isRec(input?.refs) ? input.refs : {}
  const messages = Array.isArray(input?.messages) ? input.messages : []
  const explicitSpeaker = typeof input?.currentSpeakerId === 'string' ? input.currentSpeakerId : null
  // 生成中但未知发言者：取最后一条参与者消息的发言者（圆桌轮转口径）。
  const currentSpeakerId =
    explicitSpeaker !== null
      ? explicitSpeaker
      : input?.streaming === true
        ? lastParticipantSpeaker(messages, conversation)
        : null
  const unreadIds: Set<string> =
    input?.unreadIds instanceof Set ? input.unreadIds : new Set(Array.isArray(input?.unreadIds) ? input.unreadIds : [])

  const items: any[] = []
  const participants: any[] = []
  const seenParticipants = new Set<string>()
  let previousSpeaker: string | null = null
  let anchorIndex = -1

  for (const entry of messages) {
    const def = isRec(entry) ? entry.def : null
    const id = messageId(entry)
    const speaker = speakerOf(def, conversation)
    const isMe = speaker.id === 'user'
    const resolvedName = isRec(refs[speaker.id]) && typeof refs[speaker.id].name === 'string' ? refs[speaker.id].name : speaker.name
    if (!isMe && !seenParticipants.has(speaker.id)) {
      seenParticipants.add(speaker.id)
      participants.push({ id: speaker.id, name: resolvedName, initial: initialOf(resolvedName) })
    }
    if (anchorIndex < 0 && unreadIds.has(id)) anchorIndex = items.length
    items.push({
      id,
      role: isRec(def) ? def.role ?? 'assistant' : 'assistant',
      isMe,
      speakerId: speaker.id,
      speakerName: resolvedName,
      initial: initialOf(resolvedName),
      showName: !isMe && previousSpeaker !== speaker.id,
      current: currentSpeakerId !== null && speaker.id === currentSpeakerId,
      text: messageText(def),
      def,
    })
    previousSpeaker = speaker.id
  }
  return { items, participants, anchorIndex }
}
