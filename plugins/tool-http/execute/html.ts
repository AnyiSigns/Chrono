// 轻量 HTML 处理：实体解码、正文提取、纯文本与 markdown 转换。
// 纯字符串处理、零依赖、无随机 / 无时间：同输入同输出。

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

const LINK_RE =
  /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi

/** 解码命名 / 十进制 / 十六进制实体；未知实体原样保留。 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code)) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 去标签 + 解码 + 折叠空白，适合摘要 / 标题。 */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html)
  return match === null ? null : (match[1] ?? '')
}

/** 去噪声块（脚本 / 样式 / 注释 / 内嵌框架等）。 */
function removeNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
}

/** 正文提取：优先 article / main，其次 body，最后整篇。 */
export function extractMainHtml(html: string): string {
  return (
    firstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    firstMatch(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i) ??
    firstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ??
    html
  )
}

function hrefOf(attrs: string): string | null {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
  if (match === null) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

export interface Anchor {
  href: string
  text: string
}

/** 抽出全部带 href 的锚点（按出现顺序）。 */
export function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = []
  for (const match of html.matchAll(ANCHOR_RE)) {
    const href = hrefOf(match[1] ?? '')
    if (href === null || href.length === 0) continue
    anchors.push({ href, text: stripTags(match[2] ?? '') })
  }
  return anchors
}

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi

/** 解出跳转链接的真实目标（如 DuckDuckGo 的 uddg 包裹）；非包裹原样返回。 */
export function unwrapRedirect(href: string): string {
  try {
    const base = href.startsWith('//') ? `https:${href}` : href
    const url = new URL(base)
    const target = url.searchParams.get('uddg') ?? url.searchParams.get('u')
    if (target !== null && target.length > 0) return target
  } catch {
    // 非法 href 原样返回，交由 URL 校验兜底。
  }
  return href
}

function inline(html: string): string {
  let text = html.replace(LINK_RE, (_whole, dq: string, sq: string, bare: string, inner: string) => {
    const href = dq ?? sq ?? bare ?? ''
    const label = inline(inner).trim()
    return label.length > 0 ? `[${label}](${href})` : href
  })
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => {
    const label = inline(inner).trim()
    return label.length > 0 ? `**${label}**` : ''
  })
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_whole, _tag, inner: string) => {
    const label = inline(inner).trim()
    return label.length > 0 ? `*${label}*` : ''
  })
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_whole, inner: string) => {
    const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim()
    return label.length > 0 ? `\`${label}\`` : ''
  })
  return text.replace(/<[^>]*>/g, '')
}

/** 规范化 markdown 行：折叠空白、去连续空行。 */
function normalizeMarkdown(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim())
  const out: string[] = []
  for (const line of lines) {
    if (line.length === 0 && (out.length === 0 || out[out.length - 1].length === 0)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

/** HTML → markdown：标题 / 段落 / 链接 / 列表 / 引用 / 代码块，确定性。 */
export function htmlToMarkdown(html: string): string {
  let body = extractMainHtml(removeNoise(html))
  const codeBlocks: string[] = []
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, inner: string) => {
    codeBlocks.push(decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/^\n+|\n+$/g, ''))
    return `\n\u0000BLOCK${codeBlocks.length - 1}\u0000\n`
  })
  body = body.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_whole, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inline(inner).trim()}\n\n`,
  )
  body = body.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_whole, inner: string) => {
    const quoted = inline(inner)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return `\n\n${quoted}\n\n`
  })
  body = body.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_whole, inner: string) => {
    const item = inline(inner).trim()
    return item.length > 0 ? `\n- ${item}` : ''
  })
  body = body.replace(/<br\s*\/?>/gi, '\n')
  body = body.replace(/<\/(p|div|section|tr|ul|ol|table|dd|dt)>/gi, '\n\n')
  body = decodeEntities(inline(body))
  body = normalizeMarkdown(body)
  for (let index = 0; index < codeBlocks.length; index += 1) {
    body = body.replace(`\u0000BLOCK${index}\u0000`, `\`\`\`\n${codeBlocks[index]}\n\`\`\``)
  }
  return body.trim()
}

/** HTML → 纯文本：保留段落换行，去掉标记。 */
export function htmlToText(html: string): string {
  let body = extractMainHtml(removeNoise(html))
  body = body.replace(/<br\s*\/?>/gi, '\n')
  body = body.replace(/<\/(p|div|section|li|tr|h[1-6]|blockquote|dd|dt)>/gi, '\n')
  body = body.replace(/<[^>]*>/g, '')
  return normalizeMarkdown(decodeEntities(body))
}
