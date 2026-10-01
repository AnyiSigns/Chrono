// 运行配置：免费源清单、超时、结果条数、大小上限、User-Agent、robots 策略。
// 优先级：本身份数据世代 body（调用方随 bag 传入）> 本包 schema 的 defaults > 内建兜底。
// 配置是数据：热改走数据换代，进程不动。

import { readFileSync } from 'node:fs'
import { isRec } from './types.ts'
import type { Json, Rec } from './types.ts'

/** 单个检索源的配置。 */
export interface SourceConfig {
  id: string
  name: string
  kind: string
  parse: string
  enabled: boolean
  endpoint: string | null
  instances: string[]
  query_param: string
  /** 拼进查询值的前缀（如 arXiv 的 `all:`）；缺省空串。 */
  query_prefix: string
  timeout_ms: number
  language: string
  /** 固定请求头（如 `API-Key`）；与默认抓取头合并，源声明优先。 */
  headers: Record<string, string>
  /** 固定查询参数（如 `format=rss`、`count`）；与 query_param 合并。 */
  extra_query: Record<string, string>
}

/** 归一化后的运行配置。 */
export interface Config {
  version: number
  rrf_k: number
  top_n: number
  output_max: number
  user_agent: string
  obey_robots: boolean
  redirect_max: number
  block_private_hosts: boolean
  fetcher_cmd: string
  /** 传给 fetcher 子进程的环境变量（隔离执行 `env_clear` 后注入）。走代理时设
   *  `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY`/`HTTP_PROXY`（Node 24 的 fetch 默认不认代理）。 */
  fetcher_env: Record<string, string>
  source_timeout_ms: number
  /** 是否启用本地索引（read-through + 写回）；无 search-index 成员时静默降级。 */
  index_enabled: boolean
  /** 本地索引结果在 sources_used 里的显示名。 */
  index_name: string
  /** HTML 正文短于该字符数即提示 `render_suggested`（建议改用 webbrowser 渲染）。 */
  render_min_chars: number
  sources: SourceConfig[]
}

const DEFAULT_SOURCE_TIMEOUT_MS = 8000

/** 内建兜底配置；与 `schema/tool-http.json` 的 defaults 同形（测试保证一致）。 */
export const BUILTIN_DEFAULTS: Rec = {
  version: 1,
  rrf_k: 60,
  top_n: 10,
  output_max: 1048576,
  user_agent: 'chrono-tool-http/1.0',
  obey_robots: false,
  redirect_max: 5,
  block_private_hosts: true,
  fetcher_cmd: '',
  fetcher_env: {},
  source_timeout_ms: DEFAULT_SOURCE_TIMEOUT_MS,
  index_enabled: true,
  index_name: 'Index',
  render_min_chars: 200,
  sources: [
    {
      id: 'bing-rss',
      name: 'Bing RSS',
      kind: 'bing-rss',
      parse: 'bing-rss',
      enabled: true,
      endpoint: 'https://www.bing.com/search',
      query_param: 'q',
      extra_query: { format: 'rss' },
      timeout_ms: 8000,
    },
    {
      id: 'mojeek',
      name: 'Mojeek',
      kind: 'html',
      parse: 'mojeek',
      enabled: true,
      endpoint: 'https://www.mojeek.com/search',
      query_param: 'q',
      timeout_ms: 8000,
    },
    {
      id: 'openalex',
      name: 'OpenAlex',
      kind: 'openalex',
      parse: 'openalex',
      enabled: true,
      endpoint: 'https://api.openalex.org/works',
      query_param: 'search',
      extra_query: { per_page: '10' },
      timeout_ms: 8000,
    },
    {
      id: 'stackexchange',
      name: 'Stack Exchange',
      kind: 'stackexchange',
      parse: 'stackexchange',
      enabled: true,
      endpoint: 'https://api.stackexchange.com/2.3/search/advanced',
      query_param: 'q',
      extra_query: { order: 'desc', sort: 'relevance', site: 'stackoverflow', filter: 'default' },
      timeout_ms: 8000,
    },
    {
      id: 'hn',
      name: 'Hacker News',
      kind: 'hn-algolia',
      parse: 'hn-algolia',
      enabled: true,
      endpoint: 'https://hn.algolia.com/api/v1/search',
      query_param: 'query',
      extra_query: { tags: 'story', hitsPerPage: '10' },
      timeout_ms: 8000,
    },
    {
      id: 'arxiv',
      name: 'arXiv',
      kind: 'arxiv',
      parse: 'arxiv',
      enabled: true,
      endpoint: 'https://export.arxiv.org/api/query',
      query_param: 'search_query',
      query_prefix: 'all:',
      extra_query: { max_results: '10', sortBy: 'relevance' },
      timeout_ms: 8000,
    },
    {
      id: 'github',
      name: 'GitHub',
      kind: 'github',
      parse: 'github',
      enabled: false,
      endpoint: 'https://api.github.com/search/repositories',
      query_param: 'q',
      extra_query: { per_page: '10' },
      headers: { Accept: 'application/vnd.github+json' },
      timeout_ms: 8000,
    },
    {
      id: 'marginalia',
      name: 'Marginalia',
      kind: 'marginalia',
      parse: 'marginalia',
      enabled: false,
      endpoint: 'https://api2.marginalia-search.com/search',
      query_param: 'query',
      extra_query: { count: '10' },
      headers: { 'API-Key': 'public' },
      timeout_ms: 8000,
    },
    {
      id: 'wikipedia',
      name: 'Wikipedia',
      kind: 'wikipedia',
      parse: 'wikipedia-json',
      enabled: false,
      endpoint: 'https://en.wikipedia.org/w/api.php',
      query_param: 'srsearch',
      language: 'en',
      timeout_ms: 8000,
    },
    {
      id: 'searxng',
      name: 'SearXNG',
      kind: 'searxng',
      parse: 'searxng',
      enabled: false,
      endpoint: null,
      instances: ['https://searx.be', 'https://search.inetol.net'],
      query_param: 'q',
      timeout_ms: 8000,
    },
  ],
}

function pickNumber(raw: Json | undefined, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function pickInt(raw: Json | undefined, fallback: number, min: number, max: number): number {
  const value = Math.trunc(pickNumber(raw, fallback))
  return Math.min(max, Math.max(min, value))
}

function pickBool(raw: Json | undefined, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

function pickString(raw: Json | undefined, fallback: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback
}

/** 字符串映射：只收值非空的键，保持声明顺序（确定性）。 */
function stringMap(raw: Json | undefined): Record<string, string> {
  if (!isRec(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

function parseSource(raw: Json, fallbackTimeout: number): SourceConfig | null {
  if (!isRec(raw)) return null
  const id = pickString(raw['id'], '')
  const name = pickString(raw['name'], '')
  if (id.length === 0 || name.length === 0) return null
  const kind = pickString(raw['kind'], 'html')
  const instances = Array.isArray(raw['instances'])
    ? (raw['instances'] as Json[]).filter((item): item is string => typeof item === 'string')
    : []
  return {
    id,
    name,
    kind,
    parse: pickString(raw['parse'], kind),
    enabled: pickBool(raw['enabled'], true),
    endpoint: typeof raw['endpoint'] === 'string' ? raw['endpoint'] : null,
    instances,
    query_param: pickString(raw['query_param'], 'q'),
    query_prefix: pickString(raw['query_prefix'], ''),
    timeout_ms: pickInt(raw['timeout_ms'], fallbackTimeout, 100, 120000),
    language: pickString(raw['language'], 'en'),
    headers: stringMap(raw['headers']),
    extra_query: stringMap(raw['extra_query']),
  }
}

function parseSources(raw: Json | undefined, fallbackTimeout: number): SourceConfig[] | null {
  if (!Array.isArray(raw)) return null
  // 空数组 = 显式「无源」，不回落内建清单；非数组才由调用方回落。
  return raw.map((item) => parseSource(item, fallbackTimeout)).filter((item) => item !== null)
}

/** 把任意形态的配置对象归一化为可消费的配置；缺项回落内建默认。 */
export function normalizeConfig(raw: Rec | null | undefined): Config {
  const src = isRec(raw) ? raw : {}
  const sourceTimeout = pickInt(src['source_timeout_ms'], DEFAULT_SOURCE_TIMEOUT_MS, 100, 120000)
  return {
    version: pickInt(src['version'], 1, 1, 1_000_000),
    rrf_k: pickInt(src['rrf_k'], 60, 1, 10000),
    top_n: pickInt(src['top_n'], 10, 1, 100),
    output_max: pickInt(src['output_max'], 1048576, 1, 64 * 1024 * 1024),
    user_agent: pickString(src['user_agent'], 'chrono-tool-http/1.0'),
    obey_robots: pickBool(src['obey_robots'], false),
    redirect_max: pickInt(src['redirect_max'], 5, 0, 20),
    block_private_hosts: pickBool(src['block_private_hosts'], true),
    fetcher_cmd: pickString(src['fetcher_cmd'], ''),
    fetcher_env: stringMap(src['fetcher_env']),
    source_timeout_ms: sourceTimeout,
    index_enabled: pickBool(src['index_enabled'], true),
    index_name: pickString(src['index_name'], 'Index'),
    render_min_chars: pickInt(src['render_min_chars'], 200, 0, 100000),
    sources:
      parseSources(src['sources'], sourceTimeout) ??
      parseSources(BUILTIN_DEFAULTS['sources'], sourceTimeout) ??
      [],
  }
}

/** 读本包 schema 的 defaults；读不到返回 null（由内建兜底）。 */
export function readSchemaDefaults(): Rec | null {
  try {
    const text = readFileSync(new URL('../schema/tool-http.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text) as Json
    if (isRec(parsed) && isRec(parsed['defaults'])) return parsed['defaults']
  } catch {
    // 读不到 schema 时静默回落内建兜底，服务不因配置来源缺失而不可用。
  }
  return null
}

let cachedSchemaDefaults: Rec | null | undefined

/** 读本包 schema defaults 并缓存：进程内不重复读文件（schema 出生即冻结）。 */
function schemaDefaults(): Rec | null {
  if (cachedSchemaDefaults === undefined) cachedSchemaDefaults = readSchemaDefaults()
  return cachedSchemaDefaults
}

let cachedDefaults: Config | null = null

/** 缺省配置：schema defaults 优先，内建兜底。 */
export function defaultConfig(): Config {
  if (cachedDefaults === null) {
    cachedDefaults = normalizeConfig(schemaDefaults() ?? BUILTIN_DEFAULTS)
  }
  return cachedDefaults
}

/** 合并调用方随 bag 传入的数据世代 body；缺省用缺省配置。 */
export function mergeConfig(body: Json | undefined): Config {
  if (!isRec(body)) return defaultConfig()
  const base = schemaDefaults() ?? BUILTIN_DEFAULTS
  return normalizeConfig({ ...base, ...body })
}
