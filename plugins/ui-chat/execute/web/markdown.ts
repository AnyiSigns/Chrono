// 自实现 markdown 渲染（零依赖）：块级（标题 / 段落 / 围栏代码 / 引用 / 列表 / 分隔线）
// + 行内（代码段 / 链接 / 粗体 / 斜体 / 删除线）。所有用户文本一律转义，
// 不输出任何用户可控的 HTML；产物再经 sanitizeHtml 二次白名单过滤。
// 纯字符串进出，可在 node --test 里直接单测。

import { escapeAttr, safeUrl } from './sanitize.ts'

/** 文本转义（`&` / `<` / `>`）。 */
export function escapeHtml(text: unknown): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9A-Za-z_]/.test(ch)
}

function matchLink(
  text: string,
  start: number,
): { label: string; url: string; end: number } | null {
  if (text[start] !== '[') return null
  const closeLabel = text.indexOf(']', start + 1)
  if (closeLabel < 0 || text[closeLabel + 1] !== '(') return null
  const closeUrl = text.indexOf(')', closeLabel + 2)
  if (closeUrl < 0) return null
  return {
    label: text.slice(start + 1, closeLabel),
    url: text.slice(closeLabel + 2, closeUrl),
    end: closeUrl + 1,
  }
}

/** 图片文法 `![alt](url)`：与链接同构，起点多一个 `!`。 */
function matchImage(
  text: string,
  start: number,
): { alt: string; url: string; end: number } | null {
  if (text[start] !== '!' || text[start + 1] !== '[') return null
  const closeLabel = text.indexOf(']', start + 2)
  if (closeLabel < 0 || text[closeLabel + 1] !== '(') return null
  const closeUrl = text.indexOf(')', closeLabel + 2)
  if (closeUrl < 0) return null
  return {
    alt: text.slice(start + 2, closeLabel),
    url: text.slice(closeLabel + 2, closeUrl),
    end: closeUrl + 1,
  }
}

function renderLink(label: string, url: string): string {
  const safe = safeUrl(url)
  if (safe === null) return escapeHtml(`[${label}](${url})`)
  return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`
}

/** 图片渲染：URL 过 `safeUrl`，alt 转义；危险 URL 退化为原文字面量。 */
function renderImage(alt: string, url: string): string {
  const safe = safeUrl(url)
  if (safe === null) return escapeHtml(`![${alt}](${url})`)
  return `<img src="${escapeAttr(safe)}" alt="${escapeAttr(alt)}" loading="lazy">`
}

/** 行内渲染：代码段优先，其次链接、粗体、删除线、斜体。 */
export function renderInline(text: unknown): string {
  const source = String(text)
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '`') {
      const end = source.indexOf('`', i + 1)
      if (end > i) {
        out += `<code>${escapeHtml(source.slice(i + 1, end))}</code>`
        i = end + 1
        continue
      }
    }
    if (ch === '!') {
      const image = matchImage(source, i)
      if (image !== null) {
        out += renderImage(image.alt, image.url)
        i = image.end
        continue
      }
    }
    if (ch === '[') {
      const link = matchLink(source, i)
      if (link !== null) {
        out += renderLink(link.label, link.url)
        i = link.end
        continue
      }
    }
    if (source.startsWith('**', i) || source.startsWith('__', i)) {
      const marker = source.slice(i, i + 2)
      const end = source.indexOf(marker, i + 2)
      if (end > i + 1) {
        out += `<strong>${renderInline(source.slice(i + 2, end))}</strong>`
        i = end + 2
        continue
      }
    }
    if (source.startsWith('~~', i)) {
      const end = source.indexOf('~~', i + 2)
      if (end > i + 1) {
        out += `<del>${renderInline(source.slice(i + 2, end))}</del>`
        i = end + 2
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const prev = source[i - 1]
      const next = source[i + 1]
      const boundaryOk = ch === '*' || (!isWordChar(prev) && next !== undefined && !/\s/.test(next))
      if (boundaryOk) {
        const end = source.indexOf(ch, i + 1)
        if (end > i) {
          out += `<em>${renderInline(source.slice(i + 1, end))}</em>`
          i = end + 1
          continue
        }
      }
    }
    out += escapeHtml(ch)
    i += 1
  }
  return out
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s*```/
const UL_RE = /^\s*[-*+]\s+(.*)$/
const OL_RE = /^\s*\d+[.)]\s+(.*)$/

const CURSOR_HTML = '<span class="chat-cursor"></span>'
const LAST_BLOCK_CLOSE_RE = /<\/(p|h[1-6]|li|blockquote|pre|td|th)>$/

/**
 * 在已渲染 HTML 末尾插入流式光标，优先插进最后一个块级元素内，
 * 使光标紧随末行而不是掉到块下方新起一行。空产物直接返回光标。
 */
export function injectCursor(html: unknown): string {
  const source = String(html ?? '')
  if (source.length === 0) return CURSOR_HTML
  const match = LAST_BLOCK_CLOSE_RE.exec(source)
  if (match !== null && match.index !== undefined) {
    return `${source.slice(0, match.index)}${CURSOR_HTML}${source.slice(match.index)}`
  }
  return source + CURSOR_HTML
}

/** 块级渲染：字符串进、HTML 字符串出（未消毒，调用方接 sanitizeHtml）。 */
export function renderMarkdown(source: unknown): string {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }
    if (FENCE_RE.test(line)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i += 1
      continue
    }
    if (HR_RE.test(line)) {
      out.push('<hr>')
      i += 1
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line)
      const pattern = ordered ? OL_RE : UL_RE
      const items: string[] = []
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(`<li>${renderInline((pattern.exec(lines[i]) as RegExpExecArray)[1])}</li>`)
        i += 1
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !FENCE_RE.test(lines[i]) &&
      HEADING_RE.exec(lines[i]) === null &&
      !HR_RE.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i])
    ) {
      paragraph.push(renderInline(lines[i]))
      i += 1
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`)
  }
  return out.join('')
}
