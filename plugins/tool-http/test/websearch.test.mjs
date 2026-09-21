// websearch 测试：多源归一化 + URL 去重 + RRF 排序确定性、部分失败、全失败、源过滤、robots、caps 透传。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { websearch } from '../execute/websearch.ts'
import { execFail, execOk, fetcherStdout, makeBackend, makeCtx, prefixRouter, testConfig } from './support.mjs'

const SOURCES = [
  { id: 'a', name: 'Alpha', kind: 'html', parse: 'ddg-html', enabled: true, endpoint: 'https://a.test/search', query_param: 'q', timeout_ms: 1000 },
  { id: 'b', name: 'Bravo', kind: 'html', parse: 'bing', enabled: true, endpoint: 'https://b.test/search', query_param: 'q', timeout_ms: 1000 },
  { id: 'c', name: 'Charlie', kind: 'html', parse: 'mojeek', enabled: true, endpoint: 'https://c.test/search', query_param: 'q', timeout_ms: 1000 },
]

const DDG_HTML =
  '<div class="result"><a class="result__a" href="https://one.test/page">One Title</a>' +
  '<a class="result__snippet">First snippet</a></div>' +
  '<div class="result"><a class="result__a" href="https://two.test/page">Two Title</a>' +
  '<a class="result__snippet">Second snippet</a></div>'

const BING_HTML =
  '<ol><li class="b_algo"><h2><a href="https://TWO.test/page/">Two Bing</a></h2><p>Bing snippet two</p></li>' +
  '<li class="b_algo"><h2><a href="https://three.test/x/">Three</a></h2><p>Bing snippet three</p></li></ol>'

const MOJEEK_HTML =
  '<ul><li><a class="ob" href="https://one.test/page#frag">One Mojeek</a><p class="s">Mojeek snippet one</p></li>' +
  '<li><a class="ob" href="https://four.test/y">Four</a><p class="s">Mojeek snippet four</p></li></ul>'

function config(overrides = {}) {
  return testConfig({ sources: SOURCES, ...overrides })
}

function htmlRoutes() {
  return prefixRouter([
    ['https://a.test/search', execOk(fetcherStdout({ contentType: 'text/html', body: DDG_HTML }))],
    ['https://b.test/search', execOk(fetcherStdout({ contentType: 'text/html', body: BING_HTML }))],
    ['https://c.test/search', execOk(fetcherStdout({ contentType: 'text/html', body: MOJEEK_HTML }))],
  ])
}

test('多源归一化 + URL 去重 + RRF 排序，且确定可回放', async () => {
  const first = makeBackend(htmlRoutes())
  const resultA = await websearch({ query: 'chrono', count: 4 }, makeCtx(config(), first.backend))
  assert.equal(resultA.ok, true)
  assert.deepEqual(resultA.result.results, [
    { title: 'One Title', url: 'https://one.test/page', snippet: 'First snippet', source: 'Alpha', rank: 1 },
    { title: 'Two Bing', url: 'https://two.test/page', snippet: 'Bing snippet two', source: 'Bravo', rank: 2 },
    { title: 'Four', url: 'https://four.test/y', snippet: 'Mojeek snippet four', source: 'Charlie', rank: 3 },
    { title: 'Three', url: 'https://three.test/x', snippet: 'Bing snippet three', source: 'Bravo', rank: 4 },
  ])
  assert.deepEqual(resultA.result.sources_used, ['Alpha', 'Bravo', 'Charlie'])
  assert.deepEqual(resultA.result.sources_failed, [])

  const second = makeBackend(htmlRoutes())
  const resultB = await websearch({ query: 'chrono', count: 4 }, makeCtx(config(), second.backend))
  assert.deepEqual(resultA.result, resultB.result, '同输入应同输出')
})

test('单源失败不整体失败：可用结果照回并标记失败源', async () => {
  const router = prefixRouter([
    ['https://a.test/search', execOk(fetcherStdout({ body: DDG_HTML }))],
    ['https://b.test/search', execFail('http_status', 'HTTP 503')],
    ['https://c.test/search', execOk(fetcherStdout({ body: MOJEEK_HTML }))],
  ])
  const { backend } = makeBackend(router)
  const result = await websearch({ query: 'chrono', count: 5 }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Alpha', 'Charlie'])
  assert.deepEqual(result.result.sources_failed, [{ source: 'Bravo', code: 'http_status', message: 'HTTP 503' }])
  assert.ok(result.result.results.length >= 3)
})

test('全源失败 → all_sources_failed', async () => {
  const { backend } = makeBackend(() => execFail('fetch_failed', 'boom'))
  const result = await websearch({ query: 'chrono' }, makeCtx(config(), backend))
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'all_sources_failed')
  assert.equal(result.error.sources_failed.length, 3)
})

test('sources 过滤只查选中源', async () => {
  const { backend, execCalls } = makeBackend(htmlRoutes())
  const result = await websearch({ query: 'chrono', sources: ['b'] }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Bravo'])
  assert.equal(execCalls.length, 1)
})

test('websearch 的执行 caps.net 声明为 limited', async () => {
  const { backend, execCalls } = makeBackend(htmlRoutes())
  await websearch({ query: 'chrono' }, makeCtx(config(), backend))
  assert.equal(execCalls[0].caps.net, 'limited')
  assert.equal(execCalls[0].caps.fs.read, 'none')
})

test('obey_robots 开启时被禁路径记入 sources_failed', async () => {
  const router = prefixRouter([
    ['https://a.test/robots.txt', execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nDisallow: /search' }))],
    ['https://a.test/search', execOk(fetcherStdout({ body: DDG_HTML }))],
    ['https://b.test/robots.txt', execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }))],
    ['https://b.test/search', execOk(fetcherStdout({ body: BING_HTML }))],
    ['https://c.test/robots.txt', execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nAllow: /' }))],
    ['https://c.test/search', execOk(fetcherStdout({ body: MOJEEK_HTML }))],
  ])
  const { backend } = makeBackend(router)
  const result = await websearch({ query: 'chrono' }, makeCtx(config({ obey_robots: true }), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Bravo', 'Charlie'])
  assert.deepEqual(result.result.sources_failed, [
    { source: 'Alpha', code: 'robots_disallowed', message: 'robots.txt disallows https://a.test/search?q=chrono' },
  ])
})

test('query 缺失 / 空白 → bad_args', async () => {
  const { backend } = makeBackend(htmlRoutes())
  const missing = await websearch({}, makeCtx(config(), backend))
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bad_args')
  const blank = await websearch({ query: '   ' }, makeCtx(config(), backend))
  assert.equal(blank.error.code, 'bad_args')
})

const MIXED_SOURCES = [
  { id: 'good', name: 'Good', kind: 'html', parse: 'ddg-html', enabled: true, endpoint: 'https://good.test/search', query_param: 'q', timeout_ms: 1000 },
  { id: 'bad', name: 'Bad', kind: 'html', parse: 'ddg-html', enabled: true, endpoint: 'not a url', query_param: 'q', timeout_ms: 1000 },
]

test('畸形 endpoint 只记该源失败，不拖垮整次检索', async () => {
  const router = prefixRouter([['https://good.test/search', execOk(fetcherStdout({ body: DDG_HTML }))]])
  const { backend } = makeBackend(router)
  const result = await websearch(
    { query: 'chrono' },
    makeCtx(testConfig({ sources: MIXED_SOURCES, obey_robots: false }), backend),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Good'])
  assert.equal(result.result.sources_failed.length, 1)
  assert.equal(result.result.sources_failed[0].source, 'Bad')
  assert.equal(result.result.sources_failed[0].code, 'fetch_failed')
})

test('全部源 endpoint 畸形 → all_sources_failed（不冒泡异常）', async () => {
  const { backend } = makeBackend(() => undefined)
  const result = await websearch(
    { query: 'chrono' },
    makeCtx(testConfig({ sources: [MIXED_SOURCES[1]], obey_robots: false }), backend),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'all_sources_failed')
  assert.equal(result.error.sources_failed.length, 1)
})
