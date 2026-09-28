// webresearch 测试：检索 → 前 N 条抽正文 → 带回出处；单页失败只记该条；
// read=0 只检索；max_chars 截断；内网 / 二进制 / robots 各自的失败路径（离线假后端）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { webresearch } from '../execute/webresearch.ts'
import { execFail, execOk, fetcherStdout, makeBackend, makeCtx, prefixRouter } from './support.mjs'

function sourceConfig(overrides = {}) {
  return {
    id: 'x',
    name: 'X',
    kind: 'html',
    parse: 'ddg-html',
    enabled: true,
    endpoint: 'https://search.test/s',
    query_param: 'q',
    timeout_ms: 8000,
    ...overrides,
  }
}

function config(overrides = {}) {
  return {
    version: 1,
    rrf_k: 60,
    top_n: 10,
    output_max: 1048576,
    user_agent: 'chrono-tool-http-test/1.0',
    obey_robots: false,
    redirect_max: 5,
    block_private_hosts: true,
    fetcher_cmd: '',
    source_timeout_ms: 8000,
    sources: [sourceConfig()],
    ...overrides,
  }
}

/** 检索结果 HTML：两条带绝对 URL 的命中。 */
function searchHtml(urls) {
  return urls
    .map(
      (url, index) =>
        `<a class="result__a" href="${url}">Title ${index + 1}</a><a class="result__snippet">snip ${index + 1}</a>`,
    )
    .join('\n')
}

function article(text) {
  return `<html><body><nav>nav noise</nav><article><h1>Heading</h1><p>${text}</p></article></body></html>`
}

test('webresearch：检索后按名次抽正文，带回出处与读正文成败', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ contentType: 'text/html', body: searchHtml(['https://page1.test/a', 'https://page2.test/b']) }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article('First body content.') }))],
    ['https://page2.test/b', execOk(fetcherStdout({ contentType: 'application/json', body: '{"k":"second"}' }))],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch({ query: 'chrono' }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  const items = result.result.results
  assert.equal(items.length, 2)
  assert.equal(items[0].read, true)
  assert.equal(items[0].content_type, 'text/html')
  assert.ok(items[0].content.includes('First body content.'))
  assert.ok(!items[0].content.includes('nav noise'), '正文提取应去噪声')
  assert.equal(items[1].read, true)
  assert.equal(items[1].content_type, 'application/json')
  assert.ok(items[1].content.includes('second'))
  assert.equal(result.result.read_used.length, 2)
  assert.deepEqual(result.result.read_failed, [])
  assert.deepEqual(result.result.sources_used, ['X'])
})

test('webresearch：read 限制抓取条数；read=0 只检索不读正文', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ body: searchHtml(['https://page1.test/a', 'https://page2.test/b']) }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article('one') }))],
    ['https://page2.test/b', execOk(fetcherStdout({ contentType: 'text/html', body: article('two') }))],
  ])
  const { backend, execCalls } = makeBackend(router)
  const one = await webresearch({ query: 'q', read: 1 }, makeCtx(config(), backend))
  assert.equal(one.result.results[0].read, true)
  assert.equal(one.result.results[1].read, undefined)
  assert.equal(one.result.read_used.length, 1)
  // 只应抓了 1 个正文页（exec 调用共 2 次：1 次检索 + 1 次正文）。
  assert.equal(execCalls.length, 2)

  backend.exec = async (bag) => router(bag.args[bag.args.indexOf('--url') + 1]) ?? execFail('fetch_failed', 'no route')
  const zero = await webresearch({ query: 'q', read: 0 }, makeCtx(config(), backend))
  assert.deepEqual(zero.result.read_used, [])
  assert.equal(zero.result.results[0].read, undefined)
})

test('webresearch：max_chars 截断正文并标记 truncated', async () => {
  const long = 'x'.repeat(500)
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ body: searchHtml(['https://page1.test/a']) }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article(long) }))],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch({ query: 'q', max_chars: 200 }, makeCtx(config(), backend))
  assert.equal(result.result.results[0].truncated, true)
  assert.equal(result.result.results[0].content.length, 200)
})

test('webresearch：单页失败只记该条，其余照回', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ body: searchHtml(['https://page1.test/a', 'https://page2.test/b']) }))],
    ['https://page1.test/a', execFail('net_denied', 'net denied')],
    ['https://page2.test/b', execOk(fetcherStdout({ contentType: 'text/plain', body: 'ok body' }))],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch({ query: 'q' }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.equal(result.result.results[0].read, false)
  assert.equal(result.result.results[0].error.code, 'net_denied')
  assert.equal(result.result.results[1].read, true)
  assert.deepEqual(result.result.read_failed.map((item) => item.code), ['net_denied'])
})

test('webresearch：内网结果与二进制正文各自结构化失败', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ body: searchHtml(['http://127.0.0.1/secret', 'https://bin.test/f']) }))],
    ['https://bin.test/f', execOk(fetcherStdout({ contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2]) }))],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch({ query: 'q' }, makeCtx(config(), backend))
  assert.equal(result.result.results[0].error.code, 'bad_url')
  assert.equal(result.result.results[1].error.code, 'binary_unsupported')
})

test('webresearch：robots 禁止的正文页记该条失败', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ body: searchHtml(['https://page1.test/a']) }))],
    ['https://page1.test/robots.txt', execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nDisallow: /a' }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article('blocked') }))],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch({ query: 'q' }, makeCtx(config({ obey_robots: true }), backend))
  assert.equal(result.result.results[0].read, false)
  assert.equal(result.result.results[0].error.code, 'robots_disallowed')
})

test('webresearch：args 非法与全源失败原样回结构化错误', async () => {
  const { backend } = makeBackend(() => undefined)
  const missing = await webresearch({}, makeCtx(config(), backend))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bad_args')
  const failed = await webresearch({ query: 'q' }, makeCtx(config(), backend))
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'all_sources_failed')
})
