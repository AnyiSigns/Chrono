// webresearch：一次调用完成「检索 → 抓取前 N 条 → 正文抽取」，回带出处的成段内容。
// 复用 websearch 的多源合并取候选，再用 webfetch 同口径的抓取 / 分流抽正文；
// 单页失败只记该条（`read:false` + 错误码），不拖垮整次研究。确定性、可回放。

import { NET_WEBFETCH } from './caps.ts'
import { decodeText, HTML_TYPES, isTextual, normalizeContentType, renderText } from './content.ts'
import { searchDigest } from './digest.ts'
import { putIndex } from './index.ts'
import { fetchUrl, robotsAllowsUrl } from './net.ts'
import { extractPassages } from './passages.ts'
import { isPrivateHost, parseHttpUrl } from './url.ts'
import { websearch } from './websearch.ts'
import { fail, isRec, ok } from './types.ts'
import type { IndexDocument } from './index.ts'
import type { FetchSpec } from './fetcher.ts'
import type { Json, Rec, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

const DEFAULT_READ = 3
const MAX_READ = 5
const DEFAULT_MAX_CHARS = 4000
const MIN_MAX_CHARS = 200
const MAX_MAX_CHARS = 20000

interface SearchItem {
  title: string
  url: string
  snippet: string
  source: string
  rank: number
}

interface ReadOutcome {
  ok: boolean
  url: string
  status?: number
  contentType?: string
  content?: string
  truncated?: boolean
  /** HTML 正文过短（多为 JS 渲染页）：提示改用 webbrowser。 */
  renderSuggested?: boolean
  code?: string
}

function resolveRead(raw: Json | undefined): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return Math.min(raw, MAX_READ)
  return DEFAULT_READ
}

function resolveMaxChars(raw: Json | undefined): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_MAX_CHARS) {
    return Math.min(raw, MAX_MAX_CHARS)
  }
  return DEFAULT_MAX_CHARS
}

function searchItems(value: Json): SearchItem[] {
  if (!Array.isArray(value)) return []
  const items: SearchItem[] = []
  for (const raw of value) {
    if (!isRec(raw)) continue
    const url = typeof raw['url'] === 'string' ? raw['url'] : ''
    if (url.length === 0) continue
    items.push({
      title: typeof raw['title'] === 'string' ? raw['title'] : '',
      url,
      snippet: typeof raw['snippet'] === 'string' ? raw['snippet'] : '',
      source: typeof raw['source'] === 'string' ? raw['source'] : '',
      rank: typeof raw['rank'] === 'number' ? raw['rank'] : items.length + 1,
    })
  }
  return items
}

function stringList(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** 抓取单条结果并抽正文；只读、失败作数据（不抛）。 */
async function readOne(
  item: SearchItem,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
  maxChars: number,
): Promise<ReadOutcome> {
  const parsed = parseHttpUrl(item.url)
  if (parsed === null) return { ok: false, url: item.url, code: 'bad_url' }
  if (ctx.config.block_private_hosts && isPrivateHost(parsed.hostname)) {
    return { ok: false, url: item.url, code: 'bad_url' }
  }
  const target = parsed.toString()
  if (ctx.config.obey_robots) {
    const allowed = await robotsAllowsUrl(
      ctx,
      target,
      ctx.config.source_timeout_ms,
      NET_WEBFETCH,
      robotsCache,
    )
    if (!allowed) return { ok: false, url: target, code: 'robots_disallowed' }
  }
  const spec: FetchSpec = {
    url: target,
    method: 'GET',
    headers: {
      'User-Agent': ctx.config.user_agent,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8,*/*;q=0.7',
    },
    timeoutMs: ctx.config.source_timeout_ms,
    maxSize: ctx.config.output_max,
    maxRedirs: ctx.config.redirect_max,
  }
  const outcome = await fetchUrl(ctx, spec, NET_WEBFETCH)
  if (!outcome.ok) {
    return outcome.status === undefined
      ? { ok: false, url: target, code: outcome.code }
      : { ok: false, url: target, code: outcome.code, status: outcome.status }
  }
  const contentType = normalizeContentType(outcome.contentType)
  if (!isTextual(contentType)) {
    return {
      ok: false,
      url: outcome.url,
      code: 'binary_unsupported',
      contentType,
      status: outcome.status,
    }
  }
  const text = renderText(decodeText(outcome.bytes, outcome.contentType), contentType, 'markdown')
  const content = text.length > maxChars ? text.slice(0, maxChars) : text
  return {
    ok: true,
    url: outcome.url,
    status: outcome.status,
    contentType,
    content,
    truncated: outcome.truncated || text.length > maxChars,
    renderSuggested:
      HTML_TYPES.has(contentType) && content.trim().length < (ctx.config.render_min_chars ?? 200),
  }
}

/**
 * webresearch 入口。args：`{ query, count?, sources?, read?, max_chars? }`。
 * 检索失败（全源失败）原样回 websearch 的结构化错误；检索成功则逐条读正文，
 * 单条失败只在该条上标 `read:false`，仍回可用结果。
 */
export async function webresearch(args: Json, ctx: ToolContext): Promise<ToolResult> {
  const bag = isRec(args) ? args : {}
  const query = bag['query']
  if (typeof query !== 'string' || query.trim().length === 0) {
    return fail('bad_args', 'query must be a non-empty string')
  }
  const highlights = bag['highlights'] === true
  const rawRead = bag['read']
  // 只给 highlights（未显式 read）时按缺省条数抓取；显式 read=0 仍尊重「只检索」。
  const read =
    highlights && (rawRead === undefined || rawRead === null) ? DEFAULT_READ : resolveRead(rawRead)
  const maxChars = resolveMaxChars(bag['max_chars'])
  const searchArgs: Rec = { query }
  if (bag['count'] !== undefined) searchArgs['count'] = bag['count']
  if (bag['sources'] !== undefined) searchArgs['sources'] = bag['sources']

  const found = await websearch(searchArgs, ctx)
  if (!found.ok) return found
  const items = searchItems(found.result['results'])
  const sourcesUsed = stringList(found.result['sources_used'])
  const sourcesFailed = Array.isArray(found.result['sources_failed'])
    ? (found.result['sources_failed'] as Json[])
    : []

  if (read === 0 || items.length === 0) {
    return ok({
      query,
      results: items as unknown as Json,
      sources_used: sourcesUsed as unknown as Json,
      sources_failed: sourcesFailed,
      read_used: [] as unknown as Json,
      read_failed: [] as unknown as Json,
      digest: searchDigest(query, items.length, sourcesUsed),
    })
  }

  const robotsCache = new Map<string, string | null>()
  const targets = items.slice(0, read)
  const outcomes = await Promise.all(
    targets.map((item) => readOne(item, ctx, robotsCache, maxChars)),
  )
  const readUsed: string[] = []
  const readFailed: Rec[] = []
  const documents: IndexDocument[] = []
  const results = items.map((item, index) => {
    if (index >= read) return item as unknown as Json
    const outcome = outcomes[index]
    if (outcome.ok) {
      readUsed.push(outcome.url)
      const content = outcome.content ?? ''
      // 正文回灌本地索引：抓取是一次性成本，之后同 URL 可从索引直接命中。
      documents.push({
        url: outcome.url,
        title: item.title,
        snippet: item.snippet,
        source: item.source,
        body: content,
      })
      if (highlights) {
        return {
          ...item,
          url: outcome.url,
          read: true,
          status: outcome.status ?? null,
          content_type: outcome.contentType ?? '',
          content: '',
          highlights: extractPassages(content, query, maxChars) as unknown as Json,
          truncated: false,
          ...(outcome.renderSuggested === true ? { render_suggested: true } : {}),
        } as unknown as Json
      }
      return {
        ...item,
        url: outcome.url,
        read: true,
        status: outcome.status ?? null,
        content_type: outcome.contentType ?? '',
        content,
        truncated: outcome.truncated === true,
        ...(outcome.renderSuggested === true ? { render_suggested: true } : {}),
      } as unknown as Json
    }
    readFailed.push({ url: outcome.url, code: outcome.code ?? 'fetch_failed' })
    return {
      ...item,
      read: false,
      error: { code: outcome.code ?? 'fetch_failed' },
    } as unknown as Json
  })
  await putIndex(documents, ctx)

  return ok({
    query,
    results: results as unknown as Json,
    sources_used: sourcesUsed as unknown as Json,
    sources_failed: sourcesFailed,
    read_used: readUsed as unknown as Json,
    read_failed: readFailed as unknown as Json,
    digest: searchDigest(query, items.length, sourcesUsed),
  })
}
