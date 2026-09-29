// 自实现 markdown 渲染（零依赖）：块级（标题 / 段落 / 围栏代码 / 引用 / 列表 / 分隔线）
// + 行内（代码段 / 链接 / 粗体 / 斜体 / 删除线）。所有用户文本一律转义，
// 不输出任何用户可控的 HTML；产物再经 sanitizeHtml 二次白名单过滤。
// 纯字符串进出，可在 node --test 里直接单测。

import { escapeAttr, safeUrl } from './sanitize.ts'
import { highlightCode } from './highlight.ts'

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

/** 超过该行数的围栏代码块默认折叠成可滚代码框，靠头部 `chat-codeblock-toggle` 展开 / 收起。 */
export const CODE_COLLAPSE_LINES = 20

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s*```/
const FENCE_LANG_RE = /^\s*```([^\s]*)/
const UL_RE = /^\s*[-*+]\s+(.*)$/
const OL_RE = /^\s*\d+[.)]\s+(.*)$/
/** GFM 管道表格的分隔行：`|---|:--:|--:|`（每列至少一个 `-`，可带对齐冒号）。 */
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** 把一行表格拆成去空白的单元格（剥掉首尾包裹的 `|`）。 */
function splitTableRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

/** 分隔单元格的对齐标记：`:--` 左、`--:` 右、`:-:` 居中，无冒号返回 null。 */
function tableAlign(cell: string): string | null {
  const text = cell.trim()
  const left = text.startsWith(':')
  const right = text.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

/** 当前行 + 下一行构成 GFM 表格：表头含 `|`，下一行是分隔行且列数一致。 */
function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index]
  const delim = lines[index + 1]
  if (header === undefined || delim === undefined || !header.includes('|')) return false
  if (!TABLE_DELIM_RE.test(delim)) return false
  return splitTableRow(header).length === splitTableRow(delim).length
}

/** 表格渲染：列数按表头归一（多列丢弃、缺列补空），对齐走 `data-align` 由样式着色。
 *  外壳带右上角悬浮工具条（复制 / 导出菜单），按钮文案由渲染后本地化补齐。 */
function renderTable(header: string[], aligns: (string | null)[], rows: string[][]): string {
  const cell = (tag: 'th' | 'td', text: string, align: string | null): string =>
    `<${tag}${align !== null ? ` data-align="${align}"` : ''}>${renderInline(text)}</${tag}>`
  const head = header.map((text, i) => cell('th', text, aligns[i] ?? null)).join('')
  const body = rows
    .map((row) => `<tr>${header.map((_, i) => cell('td', row[i] ?? '', aligns[i] ?? null)).join('')}</tr>`)
    .join('')
  const toolbar =
    '<div class="chat-table-head">' +
    '<button type="button" class="chat-table-copy" data-copy="idle"></button>' +
    '<button type="button" class="chat-table-export" aria-expanded="false"></button>' +
    '</div>'
  const menu =
    `<div class="chat-table-menu">` +
    `<button type="button" class="chat-table-export-csv"></button>` +
    `<button type="button" class="chat-table-export-md"></button>` +
    `</div>`
  return `<div class="chat-tableblock">${toolbar}<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${menu}</div>`
}

/** 块级渲染选项：`tail` = 流式在途的尾部片段（未定稿），走有界路径。 */
export interface RenderOptions {
  tail?: boolean
}

/** 流式尾部超长围栏的行数 / 字节上限：超过则跳过高亮，只做转义。 */
export const STREAM_FENCE_LINE_CAP = 400
export const STREAM_FENCE_BYTE_CAP = 32 * 1024

/** 块级渲染：字符串进、HTML 字符串出（未消毒，调用方接 sanitizeHtml）。 */
export function renderMarkdown(source: unknown, options: RenderOptions = {}): string {
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
      const langMatch = FENCE_LANG_RE.exec(line)
      const lang = langMatch !== null ? langMatch[1].trim() : ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      const langLabel = lang.length > 0 ? `<span class="chat-codeblock-lang">${escapeHtml(lang)}</span>` : ''
      // 长块默认折叠：外壳挂 data-collapsed，头部给展开 / 收起按钮（文案由渲染后本地化补齐）。
      const long = body.length > CODE_COLLAPSE_LINES
      const collapsed = long ? ' data-collapsed="true"' : ''
      const toggle = long
        ? '<button type="button" class="chat-codeblock-toggle" aria-expanded="false"></button>'
        : ''
      // 流式尾部：未完成的长围栏每帧重解析，hljs 分词成本随块长线性增长。超过上限就只转义
      //（每帧成本有界）；该围栏定稿（进入前缀 / 快照落地）后由非 tail 渲染补齐着色。
      const bodyText = body.join('\n')
      const plain =
        options.tail === true &&
        (body.length > STREAM_FENCE_LINE_CAP || bodyText.length > STREAM_FENCE_BYTE_CAP)
      const codeHtml = plain ? escapeHtml(bodyText) : highlightCode(bodyText, lang)
      out.push(
        `<div class="chat-codeblock"${collapsed} data-lang="${escapeAttr(lang)}"><div class="chat-codeblock-head">${langLabel}<span class="chat-codeblock-actions">${toggle}<button type="button" class="chat-codeblock-copy" data-copy="idle"></button></span></div><pre><code>${codeHtml}</code></pre></div>`,
      )
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
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), options)}</blockquote>`)
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
    if (isTableStart(lines, i)) {
      const header = splitTableRow(lines[i])
      const aligns = splitTableRow(lines[i + 1]).map(tableAlign)
      i += 2
      const rows: string[][] = []
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        lines[i].includes('|') &&
        !FENCE_RE.test(lines[i]) &&
        HEADING_RE.exec(lines[i]) === null &&
        !HR_RE.test(lines[i]) &&
        !/^\s*>/.test(lines[i])
      ) {
        rows.push(splitTableRow(lines[i]))
        i += 1
      }
      out.push(renderTable(header, aligns, rows))
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
      !OL_RE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      paragraph.push(renderInline(lines[i]))
      i += 1
    }
    out.push(`<p>${paragraph.join('<br>')}</p>`)
  }
  return out.join('')
}
