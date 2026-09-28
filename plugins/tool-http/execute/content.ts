// 响应体分流与文本渲染的共享纯函数：websearch / webfetch / webresearch 共用同一口径，
// 避免各工具各写一套 content-type 判定与 HTML 渲染。纯函数、无随机 / 无时间。

import { htmlToMarkdown, htmlToText } from './html.ts'

export const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/** 取 content-type 主类型（去参数、小写）。 */
export function normalizeContentType(raw: string): string {
  const head = raw.split(';')[0] ?? ''
  return head.trim().toLowerCase()
}

/** 是否可作为文本渲染（HTML / text/* / JSON / XML）。 */
export function isTextual(contentType: string): boolean {
  if (HTML_TYPES.has(contentType)) return true
  if (contentType.startsWith('text/')) return true
  if (contentType === 'application/json' || contentType.endsWith('+json')) return true
  if (contentType === 'application/xml' || contentType.endsWith('+xml')) return true
  return false
}

/** 按 charset 解码文本体；缺省 utf8，拉丁系走 latin1。 */
export function decodeText(bytes: Buffer, rawContentType: string): string {
  const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(rawContentType)?.[1]?.trim().toLowerCase()
  if (charset === 'latin1' || charset === 'iso-8859-1' || charset === 'latin-1') {
    return bytes.toString('latin1')
  }
  return bytes.toString('utf8')
}

/** 文本按目标形态渲染：非 HTML 或 raw 原样；HTML 可转纯文本 / markdown。 */
export function renderText(
  text: string,
  contentType: string,
  format: 'markdown' | 'text' | 'raw',
): string {
  if (format === 'raw' || !HTML_TYPES.has(contentType)) return text
  return format === 'text' ? htmlToText(text) : htmlToMarkdown(text)
}
