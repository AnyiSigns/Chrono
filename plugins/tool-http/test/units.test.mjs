// 纯函数单元测试：配置、URL、robots、fetcher、HTML 转换、源解析（离线、零依赖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUILTIN_DEFAULTS, defaultConfig, mergeConfig, readSchemaDefaults } from '../execute/config.ts'
import { canonicalizeUrl, isPrivateHost, parseHttpUrl, withQuery } from '../execute/url.ts'
import { robotsAllows } from '../execute/robots.ts'
import { buildFetcherCommand, parseFetcherStdout, resolveFetcherCommand } from '../execute/fetcher.ts'
import { htmlToMarkdown, htmlToText, stripTags, unwrapRedirect } from '../execute/html.ts'
import {
  parseBing,
  parseBingRss,
  parseDdgHtml,
  parseDdgLite,
  parseMarginalia,
  parseMojeek,
  parseSearxng,
  parseSource,
} from '../execute/sources.ts'
import { fetcherStdout } from './support.mjs'

test('配置：schema defaults 与内建兜底一致，缺省双源', () => {
  assert.deepEqual(readSchemaDefaults(), BUILTIN_DEFAULTS)
  const config = defaultConfig()
  assert.equal(config.sources.length, 2)
  assert.equal(config.top_n, 10)
  assert.equal(config.obey_robots, false)
})

test('配置：数据世代 body 优先，可换源不改代码', () => {
  const config = mergeConfig({ top_n: 3, sources: [{ id: 'x', name: 'X', kind: 'html', endpoint: 'https://x.test/s' }] })
  assert.equal(config.top_n, 3)
  assert.equal(config.sources.length, 1)
  assert.equal(config.sources[0].parse, 'html')
  assert.equal(config.sources[0].query_param, 'q')
})

test('配置：空 sources 数组 = 显式无源，不回落内建双源', () => {
  const config = mergeConfig({ sources: [] })
  assert.equal(config.sources.length, 0)
})

test('配置：fetcher_env 归一为字符串映射（空值丢弃）', () => {
  const config = mergeConfig({
    fetcher_env: { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7897', empty: '' },
  })
  assert.deepEqual(config.fetcher_env, {
    NODE_USE_ENV_PROXY: '1',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
  })
})

test('URL：只收 http(s)、内网判定、规范化去重', () => {
  assert.equal(parseHttpUrl('ftp://x.test/'), null)
  assert.equal(parseHttpUrl('not a url'), null)
  assert.ok(parseHttpUrl('https://x.test/a'))
  assert.equal(isPrivateHost('127.0.0.1'), true)
  assert.equal(isPrivateHost('10.0.0.5'), true)
  assert.equal(isPrivateHost('192.168.1.1'), true)
  assert.equal(isPrivateHost('localhost'), true)
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(canonicalizeUrl('HTTPS://Example.TEST:443/a/?b=2&a=1#frag'), 'https://example.test/a?a=1&b=2')
  assert.equal(withQuery('https://x.test/s', { q: 'a b' }), 'https://x.test/s?q=a+b')
})

test('内网判定：尾点 / IPv6-mapped / 保留段的绕过形态都被拦', () => {
  // 尾点归一
  assert.equal(isPrivateHost('localhost.'), true)
  assert.equal(isPrivateHost('127.0.0.1.'), true)
  assert.equal(isPrivateHost('example.com.'), false)
  // IPv6-mapped IPv4（点分与十六进制两种写法）
  assert.equal(isPrivateHost('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateHost('::ffff:7f00:1'), true)
  assert.equal(isPrivateHost('::ffff:10.0.0.1'), true)
  assert.equal(isPrivateHost('::ffff:8.8.8.8'), false)
  // 完整写法 / 压缩写法的回环与链路本地
  assert.equal(isPrivateHost('0:0:0:0:0:0:0:1'), true)
  assert.equal(isPrivateHost('fe80::1'), true)
  assert.equal(isPrivateHost('fd00::1'), true)
  assert.equal(isPrivateHost('ff02::1'), true)
  // 保留 / 文档 / 多播段
  assert.equal(isPrivateHost('192.0.2.1'), true)
  assert.equal(isPrivateHost('198.51.100.1'), true)
  assert.equal(isPrivateHost('203.0.113.1'), true)
  assert.equal(isPrivateHost('224.0.0.1'), true)
  assert.equal(isPrivateHost('240.0.0.1'), true)
  assert.equal(isPrivateHost('8.8.8.8'), false)
  assert.equal(isPrivateHost('2001:4860:4860::8888'), false)
})

test('robots：分组、最长匹配、通配与结尾锚', () => {
  const text = ['User-agent: *', 'Disallow: /private', 'Allow: /private/open', '', 'User-agent: badbot', 'Disallow: /'].join('\n')
  assert.equal(robotsAllows(text, 'chrono-tool-http/1.0', '/public'), true)
  assert.equal(robotsAllows(text, 'chrono-tool-http/1.0', '/private/x'), false)
  assert.equal(robotsAllows(text, 'chrono-tool-http/1.0', '/private/open/x'), true)
  assert.equal(robotsAllows(text, 'badbot/1.0', '/anything'), false)
  assert.equal(robotsAllows('', 'chrono-tool-http/1.0', '/x'), true)
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', 'ua', '/a/file.pdf'), false)
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$', 'ua', '/a/file.pdf.html'), true)
})

test('fetcher：参数映射与输出解析', () => {
  const { cmd, args } = buildFetcherCommand('fetcher', {
    url: 'https://x.test/',
    method: 'GET',
    headers: { 'User-Agent': 'ua' },
    timeoutMs: 1000,
    maxSize: 2048,
    maxRedirs: 3,
  })
  assert.equal(cmd, 'fetcher')
  assert.ok(args.includes('--url') && args.includes('https://x.test/'))
  assert.ok(args.includes('--header') && args.includes('User-Agent: ua'))
  assert.ok(args.includes('--timeout') && args.includes('1000'))
  assert.ok(args.includes('--max-size') && args.includes('2048'))
  assert.ok(args.includes('--max-redirs') && args.includes('3'))
  assert.ok(args.includes('--meta'))
  const parsed = parseFetcherStdout(fetcherStdout({ status: 200, contentType: 'text/plain', body: 'hello' }))
  assert.equal(parsed.status, 200)
  assert.equal(parsed.contentType, 'text/plain')
  assert.equal(parsed.bytes.toString('utf8'), 'hello')
  assert.equal(parseFetcherStdout('not json\nAAAA'), null)
  assert.equal(parseFetcherStdout('{"status":200,"body_encoding":"utf8"}\nAAAA'), null)
})

test('fetcher 命令解析：缺省内置 Node 脚本，非空走外部命令', () => {
  const bundled = resolveFetcherCommand('')
  assert.equal(bundled.cmd, process.execPath)
  assert.equal(bundled.prefix.length, 1)
  assert.ok(bundled.prefix[0].endsWith('fetcher-cli.mjs'))
  const external = resolveFetcherCommand('  magic-fetcher  ')
  assert.deepEqual(external, { cmd: 'magic-fetcher', prefix: [] })
})

test('HTML：正文提取 + markdown 确定；raw 原样；摘要去标签', () => {
  const html = [
    '<html><head><title>T</title><style>.x{}</style></head><body>',
    '<article>',
    '<h1>Hello</h1>',
    '<p>World <a href="https://x.test/">link</a>.</p>',
    '<ul><li>alpha</li><li>beta</li></ul>',
    '<pre><code>const a = 1</code></pre>',
    '</article></body></html>',
  ].join('')
  const markdown = htmlToMarkdown(html)
  assert.equal(markdown, htmlToMarkdown(html))
  assert.ok(markdown.includes('# Hello'))
  assert.ok(markdown.includes('World [link](https://x.test/).'))
  assert.ok(markdown.includes('- alpha'))
  assert.ok(markdown.includes('```\nconst a = 1\n```'))
  assert.ok(!markdown.includes('<p>'))
  const text = htmlToText(html)
  assert.ok(text.includes('Hello'))
  assert.ok(text.includes('World link.'))
  assert.ok(!text.includes('<'))
  assert.equal(stripTags('<b>a</b>&amp;b'), 'a &b')
  assert.equal(unwrapRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.test%2Fa'), 'https://x.test/a')
})

test('源解析：各源 HTML / JSON 归一化', () => {
  const ddg = parseDdgHtml(
    '<a class="result__a" href="https://one.test/">One</a><a class="result__snippet">S1</a>' +
      '<a class="result__a" href="https://two.test/">Two</a><a class="result__snippet">S2</a>',
  )
  assert.deepEqual(ddg.map((item) => item.url), ['https://one.test/', 'https://two.test/'])
  assert.equal(ddg[0].snippet, 'S1')
  const lite = parseDdgLite(
    '<a class="result-link" href="https://lite.test/">L</a><td class="result-snippet">LS</td>',
  )
  assert.equal(lite[0].snippet, 'LS')
  const bing = parseBing('<li class="b_algo"><h2><a href="https://b.test/">B</a></h2><p>BP</p></li>')
  assert.equal(bing[0].snippet, 'BP')
  const mojeek = parseMojeek('<a class="ob" href="https://m.test/">M</a><p class="s">MS</p>')
  assert.equal(mojeek[0].url, 'https://m.test/')
  const searxng = parseSearxng('{"results":[{"title":"S","url":"https://s.test/","content":"SC"}]}')
  assert.equal(searxng[0].snippet, 'SC')
  const wikipedia = parseSource(
    { id: 'w', name: 'W', kind: 'wikipedia', parse: 'wikipedia-json', enabled: true, endpoint: null, instances: [], query_param: 'q', timeout_ms: 1000, language: 'en' },
    '{"query":{"search":[{"title":"A B","snippet":"<b>AB</b>"}]}}',
  )
  assert.equal(wikipedia[0].url, 'https://en.wikipedia.org/wiki/A_B')
  assert.equal(wikipedia[0].snippet, 'AB')
  const rss = parseBingRss(
    '<rss><channel><item><title>A &amp; B</title><link>https://r.test/1</link>' +
      '<description><![CDATA[<b>snip</b>]]></description></item></channel></rss>',
  )
  assert.equal(rss[0].title, 'A & B')
  assert.equal(rss[0].url, 'https://r.test/1')
  assert.equal(rss[0].snippet, 'snip')
  const marg = parseMarginalia('{"results":[{"title":"M","url":"https://m2.test/","description":"desc"}]}')
  assert.equal(marg[0].url, 'https://m2.test/')
  assert.equal(marg[0].snippet, 'desc')
})
