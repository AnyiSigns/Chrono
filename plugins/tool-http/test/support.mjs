// 测试共享辅助：假后端、默认配置与调用上下文构造（零依赖、离线）。
// 反向调用被抽成可注入接口：exec 对应隔离执行，assetPut 对应资产存取。

/** 与内建默认一致的源清单（测试显式给出，避免依赖 schema 文件读取）。 */
export const DEFAULT_SOURCES = [
  {
    id: 'duckduckgo-html',
    name: 'DuckDuckGo HTML',
    kind: 'html',
    parse: 'ddg-html',
    enabled: true,
    endpoint: 'https://html.duckduckgo.com/html/',
    query_param: 'q',
    timeout_ms: 8000,
  },
  {
    id: 'duckduckgo-lite',
    name: 'DuckDuckGo Lite',
    kind: 'html',
    parse: 'ddg-lite',
    enabled: true,
    endpoint: 'https://lite.duckduckgo.com/lite/',
    query_param: 'q',
    timeout_ms: 8000,
  },
  {
    id: 'bing',
    name: 'Bing',
    kind: 'html',
    parse: 'bing',
    enabled: true,
    endpoint: 'https://www.bing.com/search',
    query_param: 'q',
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
    id: 'searxng',
    name: 'SearXNG',
    kind: 'searxng',
    parse: 'searxng',
    enabled: true,
    instances: ['https://searx.be', 'https://searxng.site'],
    query_param: 'q',
    timeout_ms: 8000,
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia API',
    kind: 'wikipedia',
    parse: 'wikipedia-json',
    enabled: true,
    endpoint: 'https://en.wikipedia.org/w/api.php',
    language: 'en',
    timeout_ms: 8000,
  },
]

/** 一份测试用配置；默认关 robots 以免测试额外打 robots.txt。 */
export function testConfig(overrides = {}) {
  return {
    version: 1,
    rrf_k: 60,
    top_n: 10,
    output_max: 1048576,
    user_agent: 'chrono-tool-http-test/1.0',
    obey_robots: false,
    redirect_max: 5,
    block_private_hosts: true,
    fetcher_cmd: 'fetcher',
    source_timeout_ms: 8000,
    sources: DEFAULT_SOURCES,
    ...overrides,
  }
}

/** 构造 fetcher stdout：首行元数据 JSON + base64 响应体。 */
export function fetcherStdout({ status = 200, contentType = 'text/html', url = '', truncated = false, body = '' } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const meta = JSON.stringify({
    status,
    content_type: contentType,
    url,
    truncated,
    body_encoding: 'base64',
  })
  return `${meta}\n${buffer.toString('base64')}`
}

/** 成功执行结果。 */
export function execOk(stdout) {
  return { ok: true, value: { exit_code: 0, stdout, stderr: '', truncated: false, duration_ms: 1 } }
}

/** 成功但 stdout 被隔离执行截断（合并进 FetchOutcome.truncated）。 */
export function execOkTruncated(stdout) {
  return { ok: true, value: { exit_code: 0, stdout, stderr: '', truncated: true, duration_ms: 1 } }
}

/** 传输 / 钳制失败（如 net_denied）。 */
export function execFail(code, message) {
  return { ok: false, code, message }
}

/** fetcher 非零退出。 */
export function execExit(code, stderr = '') {
  return { ok: true, value: { exit_code: code, stdout: '', stderr, truncated: false, duration_ms: 1 } }
}

/** 取 exec bag 里某个 flag 的取值。 */
export function argValue(bag, flag) {
  const args = Array.isArray(bag.args) ? bag.args : []
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
}

/** 假后端：router(url, bag) 返回 CallOutcome；未命中记 fetch_failed。 */
export function makeBackend(router) {
  const execCalls = []
  const assetCalls = []
  const backend = {
    async exec(bag) {
      execCalls.push(bag)
      const url = argValue(bag, '--url')
      const outcome = router(url, bag)
      if (outcome === undefined) return execFail('fetch_failed', `no route: ${url}`)
      return outcome
    },
    async assetPut(input) {
      assetCalls.push(input)
      const size = Buffer.from(input.bytes, 'base64').length
      return {
        ok: true,
        value: { kind: 'asset', sha256: 'ab'.repeat(32), mime: input.mime, size },
      }
    },
  }
  return { execCalls, assetCalls, backend }
}

/** 按 URL 前缀匹配的 router。 */
export function prefixRouter(routes) {
  return (url) => {
    for (const [prefix, outcome] of routes) {
      if (typeof url === 'string' && url.startsWith(prefix)) {
        return typeof outcome === 'function' ? outcome(url) : outcome
      }
    }
    return undefined
  }
}

/** 构造调用上下文。 */
export function makeCtx(config, backend, overrides = {}) {
  return {
    config,
    caps: undefined,
    tier: 'auto',
    workspaceRoot: 'C:/ws',
    sandboxTiers: undefined,
    grant: undefined,
    backend,
    callId: null,
    ...overrides,
  }
}
