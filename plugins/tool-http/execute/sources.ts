// 各免费源的解析器：把源响应归一化为 {title,url,snippet}，不做网络。
// 解析只做确定性字符串 / JSON 处理；HTML 解析用轻量定位，不引第三方依赖。

import { extractAnchors, stripTags, unwrapRedirect } from './html.ts'
import { isRec } from './types.ts'
import type { SourceConfig } from './config.ts'

/** 单条归一化检索结果（未去重、未排序）。 */
export interface RawResult {
  title: string
  url: string
  snippet: string
}

interface ClassAnchor {
  href: string
  text: string
}

function hrefFrom(attrs: string): string | null {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
  if (match === null) return null
  return match[1] ?? match[2] ?? match[3] ?? null
}

function anchorsByClass(html: string, className: string): ClassAnchor[] {
  const anchors: ClassAnchor[] = []
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(pattern)) {
    const attrs = match[1] ?? ''
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const classes = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? '').split(/\s+/)
    if (!classes.includes(className)) continue
    const href = hrefFrom(attrs)
    if (href === null) continue
    anchors.push({ href: unwrapRedirect(href), text: stripTags(match[2] ?? '') })
  }
  return anchors
}

function textsByClass(html: string, tag: string, className: string): string[] {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'gi',
  )
  const out: string[] = []
  for (const match of html.matchAll(pattern)) out.push(stripTags(match[1] ?? ''))
  return out
}

function pairWithSnippets(anchors: ClassAnchor[], snippets: string[]): RawResult[] {
  return anchors.map((anchor, index) => ({
    title: anchor.text,
    url: anchor.href,
    snippet: snippets[index] ?? '',
  }))
}

/** DuckDuckGo HTML：result__a 标题 + result__snippet 摘要。 */
export function parseDdgHtml(html: string): RawResult[] {
  return pairWithSnippets(
    anchorsByClass(html, 'result__a'),
    textsByClass(html, 'a', 'result__snippet'),
  )
}

/** DuckDuckGo Lite：result-link 标题 + result-snippet 摘要。 */
export function parseDdgLite(html: string): RawResult[] {
  return pairWithSnippets(
    anchorsByClass(html, 'result-link'),
    textsByClass(html, 'td', 'result-snippet'),
  )
}

/** Bing：b_algo 块内 h2 标题 + 首个 p 摘要。 */
export function parseBing(html: string): RawResult[] {
  const results: RawResult[] = []
  const blocks = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  for (const match of html.matchAll(blocks)) {
    const block = match[1] ?? ''
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
    const anchor = extractAnchors(heading === null ? block : (heading[1] ?? ''))[0]
    if (anchor === undefined) continue
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    results.push({
      title: anchor.text,
      url: anchor.href,
      snippet: paragraph === null ? '' : stripTags(paragraph[1] ?? ''),
    })
  }
  return results
}

/** Mojeek：ob 标题 + s 摘要。 */
export function parseMojeek(html: string): RawResult[] {
  return pairWithSnippets(
    anchorsByClass(html, 'ob'),
    textsByClass(html, 'p', 's'),
  )
}

function parseSearxngJson(body: string): RawResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRec(parsed) || !Array.isArray(parsed['results'])) return []
  const results: RawResult[] = []
  for (const item of parsed['results']) {
    if (!isRec(item)) continue
    const url = item['url']
    if (typeof url !== 'string' || url.length === 0) continue
    results.push({
      title: typeof item['title'] === 'string' ? item['title'] : url,
      url,
      snippet: typeof item['content'] === 'string' ? stripTags(item['content']) : '',
    })
  }
  return results
}

function parseSearxngHtml(html: string): RawResult[] {
  const results: RawResult[] = []
  const blocks = /<article\b[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi
  for (const match of html.matchAll(blocks)) {
    const block = match[1] ?? ''
    const anchor = extractAnchors(block)[0]
    if (anchor === undefined) continue
    const content = /<p\b[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    results.push({
      title: anchor.text,
      url: anchor.href,
      snippet: content === null ? '' : stripTags(content[1] ?? ''),
    })
  }
  return results
}

/** SearXNG：优先 JSON，被禁则退 HTML 解析。 */
export function parseSearxng(body: string): RawResult[] {
  const json = parseSearxngJson(body)
  return json.length > 0 ? json : parseSearxngHtml(body)
}

function parseWikipediaJson(body: string, language: string): RawResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRec(parsed) || !isRec(parsed['query'])) return []
  const search = parsed['query']['search']
  if (!Array.isArray(search)) return []
  const results: RawResult[] = []
  for (const item of search) {
    if (!isRec(item)) continue
    const title = item['title']
    if (typeof title !== 'string' || title.length === 0) continue
    const page = encodeURIComponent(title.replace(/ /g, '_'))
    results.push({
      title,
      url: `https://${language}.wikipedia.org/wiki/${page}`,
      snippet: typeof item['snippet'] === 'string' ? stripTags(item['snippet']) : '',
    })
  }
  return results
}

/** 按源声明的 parse 策略解析响应体。 */
export function parseSource(source: SourceConfig, body: string): RawResult[] {
  switch (source.parse) {
    case 'ddg-html':
      return parseDdgHtml(body)
    case 'ddg-lite':
      return parseDdgLite(body)
    case 'bing':
      return parseBing(body)
    case 'mojeek':
      return parseMojeek(body)
    case 'searxng':
      return parseSearxng(body)
    case 'wikipedia-json':
      return parseWikipediaJson(body, source.language)
    default:
      return []
  }
}
