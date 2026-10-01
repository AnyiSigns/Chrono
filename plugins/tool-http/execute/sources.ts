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

/** 去 CDATA 包裹（RSS 文本可能用 CDATA）。 */
function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/** 取某标签内的文本（含 CDATA / 实体归一）。 */
function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block)
  return match === null ? '' : stripTags(stripCdata(match[1] ?? ''))
}

/** 通用 RSS 2.0：`<item>` 的 title / link / description。 */
export function parseRss(xml: string): RawResult[] {
  const results: RawResult[] = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? ''
    const url = tagText(block, 'link')
    if (url.length === 0) continue
    results.push({
      title: tagText(block, 'title') || url,
      url,
      snippet: tagText(block, 'description'),
    })
  }
  return results
}

/** Bing RSS：RSS 2.0（`format=rss`），比抓 HTML 结果页稳定。 */
export function parseBingRss(xml: string): RawResult[] {
  return parseRss(xml)
}

/** Marginalia：`{results:[{url,title,description}]}`（公开 key，独立索引）。 */
export function parseMarginalia(body: string): RawResult[] {
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
      title: typeof item['title'] === 'string' ? stripTags(item['title']) : url,
      url,
      snippet: typeof item['description'] === 'string' ? stripTags(item['description']) : '',
    })
  }
  return results
}

/** Mojeek：ob 标题 + s 摘要。 */
export function parseMojeek(html: string): RawResult[] {
  return pairWithSnippets(anchorsByClass(html, 'ob'), textsByClass(html, 'p', 's'))
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

/**
 * OpenAlex 倒排摘要还原：`{word:[positions]}` 按位置拼回原文（确定、有界）。
 * 结构不符 / 无位置时回空串。
 */
export function restoreInvertedAbstract(index: unknown): string {
  if (!isRec(index)) return ''
  const positions: Array<[number, string]> = []
  for (const [word, raw] of Object.entries(index)) {
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      if (typeof item === 'number' && Number.isInteger(item)) positions.push([item, word])
    }
  }
  positions.sort((left, right) => (left[0] !== right[0] ? left[0] - right[0] : (left[1] < right[1] ? -1 : 1)))
  return positions.map(([, word]) => word).join(' ')
}

/** OpenAlex：`{results:[{display_name,doi,id,publication_year,abstract_inverted_index}]}`。 */
export function parseOpenAlex(body: string): RawResult[] {
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
    const doi = typeof item['doi'] === 'string' ? item['doi'] : ''
    const id = typeof item['id'] === 'string' ? item['id'] : ''
    const url = doi.length > 0 ? doi : id
    if (url.length === 0) continue
    const title = typeof item['display_name'] === 'string' ? item['display_name'] : url
    const year = typeof item['publication_year'] === 'number' ? String(item['publication_year']) : ''
    const abstract = stripTags(restoreInvertedAbstract(item['abstract_inverted_index']))
    const snippet = [year, abstract].filter((part) => part.length > 0).join(' ').trim()
    results.push({ title, url, snippet })
  }
  return results
}

/** arXiv Atom：`<entry>` 的 title / id / summary。 */
export function parseArxiv(xml: string): RawResult[] {
  const results: RawResult[] = []
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const block = match[1] ?? ''
    const url = tagText(block, 'id')
    if (url.length === 0) continue
    results.push({
      title: tagText(block, 'title') || url,
      url,
      snippet: tagText(block, 'summary'),
    })
  }
  return results
}

/** Stack Exchange：`{items:[{title,link,excerpt?,body?}]}`。 */
export function parseStackExchange(body: string): RawResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRec(parsed) || !Array.isArray(parsed['items'])) return []
  const results: RawResult[] = []
  for (const item of parsed['items']) {
    if (!isRec(item)) continue
    const url = typeof item['link'] === 'string' ? item['link'] : ''
    if (url.length === 0) continue
    const raw = typeof item['excerpt'] === 'string' ? item['excerpt'] : item['body']
    results.push({
      title: typeof item['title'] === 'string' ? stripTags(item['title']) : url,
      url,
      snippet: typeof raw === 'string' ? stripTags(raw) : '',
    })
  }
  return results
}

/** GitHub 搜索：`{items:[{full_name,html_url,description}]}`。 */
export function parseGithub(body: string): RawResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRec(parsed) || !Array.isArray(parsed['items'])) return []
  const results: RawResult[] = []
  for (const item of parsed['items']) {
    if (!isRec(item)) continue
    const url = typeof item['html_url'] === 'string' ? item['html_url'] : ''
    if (url.length === 0) continue
    results.push({
      title: typeof item['full_name'] === 'string' ? item['full_name'] : url,
      url,
      snippet: typeof item['description'] === 'string' ? stripTags(item['description']) : '',
    })
  }
  return results
}

/** Hacker News (Algolia)：`{hits:[{title,url?,story_text?,objectID}]}`。 */
export function parseHnAlgolia(body: string): RawResult[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!isRec(parsed) || !Array.isArray(parsed['hits'])) return []
  const results: RawResult[] = []
  for (const item of parsed['hits']) {
    if (!isRec(item)) continue
    const id = typeof item['objectID'] === 'string' ? item['objectID'] : ''
    const external = typeof item['url'] === 'string' ? item['url'] : ''
    const url = external.length > 0 ? external : id.length > 0 ? `https://news.ycombinator.com/item?id=${id}` : ''
    if (url.length === 0) continue
    const text = typeof item['story_text'] === 'string' ? item['story_text'] : ''
    results.push({
      title: typeof item['title'] === 'string' ? stripTags(item['title']) : url,
      url,
      snippet: text.length > 0 ? stripTags(text) : '',
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
    case 'bing-rss':
      return parseBingRss(body)
    case 'rss':
      return parseRss(body)
    case 'marginalia':
      return parseMarginalia(body)
    case 'mojeek':
      return parseMojeek(body)
    case 'searxng':
      return parseSearxng(body)
    case 'wikipedia-json':
      return parseWikipediaJson(body, source.language)
    case 'openalex':
      return parseOpenAlex(body)
    case 'arxiv':
      return parseArxiv(body)
    case 'stackexchange':
      return parseStackExchange(body)
    case 'github':
      return parseGithub(body)
    case 'hn-algolia':
      return parseHnAlgolia(body)
    default:
      return []
  }
}
