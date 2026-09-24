// HTML 白名单消毒（零依赖，自实现）。markdown 渲染器已对所有用户文本做转义，
// 这里作第二道防线：只放行登记标签 / 属性，清掉 script / 事件属性 / 危险 URL / 内嵌危险元素。
// 纯字符串进出，不依赖 DOM，可在 node --test 里直接单测。

/** 放行的标签（markdown 渲染器的产物闭集）。 */
export const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'del', 'a', 'img',
])

/** 放行的属性：`a` 只认 href / target / rel / title，`img` 只认 src / alt / loading / title。 */
export const ALLOWED_ATTRS: { [tag: string]: Set<string> } = {
  a: new Set(['href', 'target', 'rel', 'title']),
  img: new Set(['src', 'alt', 'loading', 'title']),
  '*': new Set(['title']),
}

/** 连内容一起丢弃的元素（含其内部文本）。 */
export const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template',
  'svg', 'math', 'noscript', 'link', 'meta', 'base', 'form',
  'input', 'textarea', 'select', 'button',
])

const URL_ATTRS = new Set(['href', 'src', 'xlink:href'])
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/** 无闭合标签的 void 元素：丢弃时只吃掉标签本身，不能吞掉后续文档。 */
const VOID_DROP_TAGS = new Set(['input', 'embed', 'link', 'meta', 'base'])

/** 把 HTML 实体还原成字符（只处理常见形态，用于 URL 协议判定）。 */
export function decodeEntities(text: unknown): string {
  return String(text)
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 属性值转义（重新序列化时用）。 */
export function escapeAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * URL 安全判定：允许 `http` / `https` / `mailto` 与相对地址；
 * `javascript:` / `data:` / `vbscript:` 等一律拒（实体编码与空白混淆先归一）。
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, '')
  if (value.length === 0) return null
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return value
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)
  if (match === null) return value
  const scheme = match[1].toLowerCase()
  return SAFE_SCHEMES.has(scheme) ? value : null
}

export interface ParsedTag {
  closing: boolean
  name: string
  attrs: [string, string | null][]
  selfClosing: boolean
}

/** 找标签结束的 `>`（跳过引号内的 `>`）。 */
function findTagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from; i < html.length; i++) {
    const ch = html[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

/** 解析一个标签体（不含尖括号）；非标签形态返回 null。 */
export function parseTag(raw: string): ParsedTag | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const closing = trimmed.startsWith('/')
  const body = closing ? trimmed.slice(1).trim() : trimmed
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body)
  if (nameMatch === null) return null
  const name = nameMatch[1].toLowerCase()
  const rest = body.slice(nameMatch[1].length)
  const selfClosing = /\/\s*$/.test(rest)
  const attrs: [string, string | null][] = []
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(rest)) !== null) {
    const key = match[1].toLowerCase()
    const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5]
    attrs.push([key, value === undefined ? null : value])
  }
  return { closing, name, attrs, selfClosing }
}

function isAllowedAttr(tag: string, attr: string): boolean {
  const perTag = ALLOWED_ATTRS[tag]
  if (perTag !== undefined && perTag.has(attr)) return true
  return ALLOWED_ATTRS['*'].has(attr)
}

/** 跳过 `name` 元素内容，返回其闭合标签之后的起点；找不到闭合则到末尾。 */
function skipElement(html: string, from: number, name: string): number {
  const closeRe = new RegExp(`</${name}\\s*>`, 'i')
  const rest = html.slice(from)
  const match = closeRe.exec(rest)
  return match === null ? html.length : from + match.index + match[0].length
}

/** 白名单消毒：字符串进、字符串出。 */
export function sanitizeHtml(html: unknown): string {
  const source = String(html)
  const out: string[] = []
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      out.push(source.slice(i))
      break
    }
    out.push(source.slice(i, lt))
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    const gt = findTagEnd(source, lt + 1)
    if (gt < 0) {
      out.push('&lt;')
      i = lt + 1
      continue
    }
    const parsed = parseTag(source.slice(lt + 1, gt))
    if (parsed === null) {
      out.push('&lt;')
      i = lt + 1
      continue
    }
    const { closing, name, attrs, selfClosing } = parsed
    if (DROP_WITH_CONTENT.has(name)) {
      // 自闭合 / void 标签没有闭合标签，只消费标签本身；否则跳过整段内容。
      const voidTag = selfClosing || VOID_DROP_TAGS.has(name)
      i = closing || voidTag ? gt + 1 : skipElement(source, gt + 1, name)
      continue
    }
    if (!ALLOWED_TAGS.has(name)) {
      i = gt + 1
      continue
    }
    if (closing) {
      out.push(`</${name}>`)
      i = gt + 1
      continue
    }
    const safe: [string, string | null][] = []
    for (const [key, value] of attrs) {
      if (!isAllowedAttr(name, key)) continue
      if (URL_ATTRS.has(key)) {
        const url = safeUrl(value ?? '')
        if (url === null) continue
        safe.push([key, url])
        continue
      }
      if (key === 'target') {
        if (value === '_blank') safe.push([key, '_blank'])
        continue
      }
      if (key === 'rel') {
        safe.push([key, 'noopener noreferrer'])
        continue
      }
      safe.push([key, value])
    }
    const rendered = safe
      .map(([key, value]) => (value === null ? ` ${key}` : ` ${key}="${escapeAttr(value)}"`))
      .join('')
    out.push(`<${name}${rendered}${selfClosing ? ' /' : ''}>`)
    i = gt + 1
  }
  return out.join('')
}
