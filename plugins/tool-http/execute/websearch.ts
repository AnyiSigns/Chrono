// websearch：并行查各免费源 → 归一化 → URL 规范化去重 → RRF 合并排序 → top_n。
// 部分源失败不整体失败；全源失败才回 all_sources_failed。结果确定、可回放。

import { NET_WEBSEARCH } from './caps.ts'
import { fetchUrl, robotsAllowsUrl } from './net.ts'
import { parseSource, parseSearxng } from './sources.ts'
import { canonicalizeUrl, withQuery } from './url.ts'
import { fail, isRec, ok } from './types.ts'
import type { Config, SourceConfig } from './config.ts'
import type { FetchSpec } from './fetcher.ts'
import type { RawResult } from './sources.ts'
import type { Json, ToolResult } from './types.ts'
import type { ToolContext } from './context.ts'

interface SourceList {
  source: string
  results: RawResult[]
}

type SourceOutcome =
  | { ok: true; source: string; results: RawResult[] }
  | { ok: false; source: string; code: string; message: string }

type TextOutcome = { ok: true; text: string } | { ok: false; code: string; message: string }

function sourceHeaders(config: Config): Record<string, string> {
  return {
    'User-Agent': config.user_agent,
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  }
}

function resolveLimit(raw: Json | undefined, topN: number): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return Math.min(raw, topN)
  return topN
}

function selectSources(config: Config, raw: Json | undefined): SourceConfig[] {
  const enabled = config.sources.filter((source) => source.enabled)
  if (!Array.isArray(raw)) return enabled
  const wanted = new Set(
    raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase()),
  )
  if (wanted.size === 0) return enabled
  return enabled.filter(
    (source) => wanted.has(source.id.toLowerCase()) || wanted.has(source.name.toLowerCase()),
  )
}

async function fetchSourceText(
  url: string,
  source: SourceConfig,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<TextOutcome> {
  if (ctx.config.obey_robots) {
    const allowed = await robotsAllowsUrl(ctx, url, source.timeout_ms, NET_WEBSEARCH, robotsCache)
    if (!allowed) {
      return { ok: false, code: 'robots_disallowed', message: `robots.txt disallows ${url}` }
    }
  }
  const spec: FetchSpec = {
    url,
    method: 'GET',
    headers: sourceHeaders(ctx.config),
    timeoutMs: source.timeout_ms,
    maxSize: ctx.config.output_max,
    maxRedirs: ctx.config.redirect_max,
  }
  const outcome = await fetchUrl(ctx, spec, NET_WEBSEARCH)
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message }
  const bytes =
    outcome.bytes.length > ctx.config.output_max
      ? outcome.bytes.subarray(0, ctx.config.output_max)
      : outcome.bytes
  return { ok: true, text: bytes.toString('utf8') }
}

async function queryHtml(
  source: SourceConfig,
  query: string,
  limit: number,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<SourceOutcome> {
  if (source.endpoint === null) {
    return { ok: false, source: source.name, code: 'fetch_failed', message: 'source has no endpoint' }
  }
  const url = withQuery(source.endpoint, { [source.query_param]: query })
  const fetched = await fetchSourceText(url, source, ctx, robotsCache)
  if (!fetched.ok) return { ok: false, source: source.name, code: fetched.code, message: fetched.message }
  return { ok: true, source: source.name, results: parseSource(source, fetched.text).slice(0, limit) }
}

async function querySearxng(
  source: SourceConfig,
  query: string,
  limit: number,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<SourceOutcome> {
  let code = 'fetch_failed'
  let message = 'no searxng instance configured'
  for (const instance of source.instances) {
    const attempts = [
      withQuery(instance, { [source.query_param]: query, format: 'json' }),
      withQuery(instance, { [source.query_param]: query }),
    ]
    for (const url of attempts) {
      const fetched = await fetchSourceText(url, source, ctx, robotsCache)
      if (!fetched.ok) {
        code = fetched.code
        message = fetched.message
        continue
      }
      const results = parseSearxng(fetched.text).slice(0, limit)
      if (results.length > 0) return { ok: true, source: source.name, results }
    }
  }
  return { ok: false, source: source.name, code, message }
}

async function queryWikipedia(
  source: SourceConfig,
  query: string,
  limit: number,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<SourceOutcome> {
  if (source.endpoint === null) {
    return { ok: false, source: source.name, code: 'fetch_failed', message: 'source has no endpoint' }
  }
  const url = withQuery(source.endpoint, {
    action: 'query',
    list: 'search',
    srsearch: query,
    format: 'json',
    srlimit: String(limit),
  })
  const fetched = await fetchSourceText(url, source, ctx, robotsCache)
  if (!fetched.ok) return { ok: false, source: source.name, code: fetched.code, message: fetched.message }
  return { ok: true, source: source.name, results: parseSource(source, fetched.text).slice(0, limit) }
}

function querySource(
  source: SourceConfig,
  query: string,
  limit: number,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<SourceOutcome> {
  if (source.kind === 'searxng') return querySearxng(source, query, limit, ctx, robotsCache)
  if (source.kind === 'wikipedia') return queryWikipedia(source, query, limit, ctx, robotsCache)
  return queryHtml(source, query, limit, ctx, robotsCache)
}

/**
 * 单源兜底：畸形 endpoint / 解析异常只记该源失败，不冒泡成整次检索失败。
 * 失败作数据（`fetch_failed`），其余源照常合并。
 */
async function safeQuerySource(
  source: SourceConfig,
  query: string,
  limit: number,
  ctx: ToolContext,
  robotsCache: Map<string, string | null>,
): Promise<SourceOutcome> {
  try {
    return await querySource(source, query, limit, ctx, robotsCache)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, source: source.name, code: 'fetch_failed', message }
  }
}

function safeCanonical(url: string): string | null {
  try {
    return canonicalizeUrl(url)
  } catch {
    return null
  }
}

interface MergeEntry {
  title: string
  url: string
  snippet: string
  bestSource: string
  bestRank: number
  score: number
}

/** RRF 合并：各源名次倒数融合，按分数降序、URL 升序定序（确定可回放）。 */
export function mergeResults(lists: SourceList[], rrfK: number): Array<RawResult & { source: string }> {
  const entries = new Map<string, MergeEntry>()
  for (const list of lists) {
    list.results.forEach((item, index) => {
      const rank = index + 1
      const canonical = safeCanonical(item.url)
      if (canonical === null) return
      const existing = entries.get(canonical)
      if (existing === undefined) {
        entries.set(canonical, {
          title: item.title,
          url: canonical,
          snippet: item.snippet,
          bestSource: list.source,
          bestRank: rank,
          score: 1 / (rrfK + rank),
        })
        return
      }
      existing.score += 1 / (rrfK + rank)
      const better =
        rank < existing.bestRank ||
        (rank === existing.bestRank && list.source < existing.bestSource)
      if (better) {
        existing.bestRank = rank
        existing.bestSource = list.source
        if (item.title.length > 0) existing.title = item.title
        if (item.snippet.length > 0) existing.snippet = item.snippet
      }
    })
  }
  const ordered = [...entries.values()].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    return left.url < right.url ? -1 : left.url > right.url ? 1 : 0
  })
  return ordered.map((entry) => ({
    title: entry.title,
    url: entry.url,
    snippet: entry.snippet,
    source: entry.bestSource,
  }))
}

/** websearch 入口：查多源、去重合并、部分失败照回。 */
export async function websearch(args: Json, ctx: ToolContext): Promise<ToolResult> {
  const bag = isRec(args) ? args : {}
  const query = bag['query']
  if (typeof query !== 'string' || query.trim().length === 0) {
    return fail('bad_args', 'query must be a non-empty string')
  }
  const limit = resolveLimit(bag['count'], ctx.config.top_n)
  const selected = selectSources(ctx.config, bag['sources'])
  if (selected.length === 0) return fail('all_sources_failed', 'no enabled source selected')
  const robotsCache = new Map<string, string | null>()
  const outcomes = await Promise.all(
    selected.map((source) => safeQuerySource(source, query, limit, ctx, robotsCache)),
  )
  const used: string[] = []
  const failures: { source: string; code: string; message: string }[] = []
  const lists: SourceList[] = []
  for (const outcome of outcomes) {
    if (outcome.ok) {
      used.push(outcome.source)
      lists.push({ source: outcome.source, results: outcome.results })
    } else {
      failures.push({ source: outcome.source, code: outcome.code, message: outcome.message })
    }
  }
  if (used.length === 0) {
    return fail('all_sources_failed', 'all selected sources failed', {
      sources_failed: failures as unknown as Json,
    })
  }
  const merged = mergeResults(lists, ctx.config.rrf_k)
  const results = merged.slice(0, limit).map((entry, index) => ({ ...entry, rank: index + 1 }))
  return ok({
    results: results as unknown as Json,
    sources_used: used as unknown as Json,
    sources_failed: failures as unknown as Json,
  })
}
