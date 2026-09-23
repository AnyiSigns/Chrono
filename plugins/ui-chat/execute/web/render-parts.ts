// 内容 parts 分发（纯函数）：把消息 def 的 `parts` / `attachments` 归一成视图模型。
// 全能口径：text / image / video / audio / file / 工具卡；未知 part 走文本降级（不空白、不报错）。

import { UI_TEXT } from './messages.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MEDIA_KINDS = new Set(['image', 'video', 'audio'])

/** 资产引用归一：`{kind:'asset', sha256, mime, size}` 或 `{kind:'ext', url}`。 */
export function assetSource(part: any): any {
  if (!isRec(part)) return null
  const candidates = [part.source, part.asset, part.file, part]
  for (const candidate of candidates) {
    if (!isRec(candidate)) continue
    if (candidate.kind === 'asset' && typeof candidate.sha256 === 'string') {
      return {
        kind: 'asset',
        sha256: candidate.sha256,
        mime: typeof candidate.mime === 'string' ? candidate.mime : '',
        size: typeof candidate.size === 'number' ? candidate.size : 0,
      }
    }
    if (candidate.kind === 'ext' && typeof candidate.url === 'string') {
      return { kind: 'ext', url: candidate.url }
    }
    if (typeof candidate.sha256 === 'string') {
      return {
        kind: 'asset',
        sha256: candidate.sha256,
        mime: typeof candidate.mime === 'string' ? candidate.mime : '',
        size: typeof candidate.size === 'number' ? candidate.size : 0,
      }
    }
  }
  return null
}

function textOf(part: any): string {
  if (!isRec(part)) return ''
  if (typeof part.text === 'string') return part.text
  if (typeof part.content === 'string') return part.content
  return ''
}

/** 单个 part → 视图模型。 */
export function partViewModel(part: any): any {
  if (!isRec(part)) return { type: 'text', text: String(part ?? '') }
  const type = typeof part.type === 'string' ? part.type : 'text'
  if (type === 'text') return { type: 'text', text: textOf(part) }
  if (MEDIA_KINDS.has(type)) {
    return { type, source: assetSource(part), alt: typeof part.name === 'string' ? part.name : '' }
  }
  if (type === 'file') {
    return {
      type: 'file',
      name: typeof part.name === 'string' ? part.name : UI_TEXT.chat_file,
      source: assetSource(part),
      text: typeof part.text === 'string' ? part.text : null,
    }
  }
  if (type === 'tool' || type === 'tool_call' || type === 'tool_result') {
    return {
      type: 'tool',
      callId: typeof part.call_id === 'string' ? part.call_id : typeof part.callId === 'string' ? part.callId : '',
      tool: typeof part.tool === 'string' ? part.tool : '',
      render: isRec(part.render) ? part.render : null,
      args: part.args ?? null,
      result: part.result ?? null,
      status: typeof part.status === 'string' ? part.status : null,
    }
  }
  // 未知 type：有文本按 markdown 降级，否则序列化原值（不空白、不报错）。
  const text = textOf(part)
  if (text.length > 0) return { type: 'text', text }
  return { type: 'text', text: safeStringify(part) }
}

/** 附件 → 视图模型（与消息 parts 同形，便于统一渲染）。 */
export function attachmentViewModel(attachment: any): any {
  if (!isRec(attachment)) return { type: 'file', name: UI_TEXT.chat_file, source: null, text: null }
  const kind = typeof attachment.kind === 'string' ? attachment.kind : 'file'
  const name = typeof attachment.name === 'string' ? attachment.name : UI_TEXT.chat_file
  const source = assetSource(attachment)
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    return { type: kind, source, alt: name }
  }
  return {
    type: 'file',
    name,
    source,
    text: typeof attachment.text === 'string' ? attachment.text : null,
  }
}

/** 消息 → 有序渲染项：parts（含 text）在前，attachments 在后；无 parts 时回落 content。 */
export function messageViewItems(def: any): any[] {
  if (!isRec(def)) return []
  const items: any[] = []
  if (Array.isArray(def.parts) && def.parts.length > 0) {
    for (const part of def.parts) items.push(partViewModel(part))
  } else if (typeof def.content === 'string' && def.content.length > 0) {
    items.push({ type: 'text', text: def.content })
  }
  if (Array.isArray(def.attachments)) {
    for (const attachment of def.attachments) items.push(attachmentViewModel(attachment))
  }
  return items
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
