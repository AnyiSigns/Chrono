// 能力类 `search-index` 的方法：search / put / stats。
// 门面自身不落盘、不取时间；按世界成员表把请求委派给 search-index-provider 成员并合并结果。
// 加 / 减一个索引后端 = 成员表变化，本文件零改动（不枚举后端）。成员失败只隔离该成员。

import { BadArgsError, isRecord } from 'plugin-sdk'
import type { Handler, Json, PortCaller, Rec } from 'plugin-sdk'

/** 索引后端扩展槽（拥有方本插件的 `slots` 契约）：成员由宿主注入的 `many` 成员表给出。 */
export const SEARCH_INDEX_PROVIDER = 'search-index-provider'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

/** 委派依赖：反向调用通道 + 成员身份表（按注入序，结果确定）。 */
export interface SearchIndexDeps {
  link: PortCaller
  providers: readonly string[]
}

function asString(value: Json | undefined): string {
  return typeof value === 'string' ? value : ''
}

function resultsOf(value: Json): Rec[] {
  if (!isRecord(value) || !Array.isArray(value['results'])) return []
  return value['results'].filter(isRecord)
}

function parseLimit(raw: Json | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new BadArgsError('limit must be a positive integer')
  }
  return Math.min(raw, MAX_LIMIT)
}

function parseQuery(args: Json): { query: string; limit: number } {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const query = args['query']
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new BadArgsError('query must be a non-empty string')
  }
  return { query, limit: parseLimit(args['limit']) }
}

/** 归一化待入库文档：只留字段齐备（url 非空）的条目，字段一律折叠为字符串。 */
function parseDocuments(args: Json): Rec[] {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const documents = args['documents']
  if (!Array.isArray(documents)) throw new BadArgsError('documents must be an array')
  const out: Rec[] = []
  for (const item of documents) {
    if (!isRecord(item)) continue
    const url = asString(item['url'])
    if (url.length === 0) continue
    out.push({
      url,
      title: asString(item['title']),
      snippet: asString(item['snippet']),
      source: asString(item['source']),
      body: asString(item['body']),
    })
  }
  return out
}

/**
 * 逐后端检索并按 URL 去重合并：同 URL 取名次更优者；后端按注入序访问，
 * 结果按（名次升序、URL 升序）定序，确定可回放。后端失败跳过，不整体失败。
 */
async function searchProviders(query: string, limit: number, deps: SearchIndexDeps): Promise<Json> {
  const byUrl = new Map<string, { entry: Rec; rank: number; provider: string }>()
  for (const provider of deps.providers) {
    const outcome = await deps.link.call(
      SEARCH_INDEX_PROVIDER,
      'search',
      { query, limit },
      { provider },
    )
    if (!outcome.ok) continue
    resultsOf(outcome.value).forEach((entry, index) => {
      const url = asString(entry['url'])
      if (url.length === 0) return
      const rank = index + 1
      const existing = byUrl.get(url)
      if (existing === undefined || rank < existing.rank) {
        byUrl.set(url, { entry, rank, provider })
      }
    })
  }
  const ordered = [...byUrl.values()].sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank
    const leftUrl = asString(left.entry['url'])
    const rightUrl = asString(right.entry['url'])
    return leftUrl < rightUrl ? -1 : leftUrl > rightUrl ? 1 : 0
  })
  const results = ordered.slice(0, limit).map((item, index) => ({
    url: asString(item.entry['url']),
    title: asString(item.entry['title']),
    snippet: asString(item.entry['snippet']),
    source: asString(item.entry['source']) || item.provider,
    rank: index + 1,
  }))
  return { results: results as unknown as Json }
}

/** 逐后端写入：任一后端失败跳过；`stored` 取各后端回报的最大值（同一批文档）。 */
async function putDocuments(documents: Rec[], deps: SearchIndexDeps): Promise<Json> {
  let stored = 0
  for (const provider of deps.providers) {
    const outcome = await deps.link.call(SEARCH_INDEX_PROVIDER, 'put', { documents }, { provider })
    if (!outcome.ok) continue
    const value = outcome.value
    if (isRecord(value) && typeof value['stored'] === 'number') {
      stored = Math.max(stored, value['stored'])
    }
  }
  return { stored }
}

/** 汇总各后端规模：成员按注入序，缺失 / 失败按 0 记。 */
async function statsProviders(deps: SearchIndexDeps): Promise<Json> {
  const providers: Rec[] = []
  let docs = 0
  for (const provider of deps.providers) {
    const outcome = await deps.link.call(SEARCH_INDEX_PROVIDER, 'stats', {}, { provider })
    const count =
      outcome.ok && isRecord(outcome.value) && typeof outcome.value['docs'] === 'number'
        ? outcome.value['docs']
        : 0
    providers.push({ provider, docs: count })
    docs += count
  }
  return { providers: providers as unknown as Json, docs }
}

/** 构造方法表（依赖注入：反向通道与成员表由入口提供）。 */
export function createHandlers(deps: SearchIndexDeps): Record<string, Handler> {
  return {
    search: async (args) => {
      const { query, limit } = parseQuery(args)
      return { value: await searchProviders(query, limit, deps), events: [] }
    },
    put: async (args) => {
      const documents = parseDocuments(args)
      return { value: await putDocuments(documents, deps), events: [] }
    },
    stats: async () => ({ value: await statsProviders(deps), events: [] }),
  }
}
