// 本地索引接线测试：read-through 合并、离线兜底、写回形状、关闭时零调用、畸形降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { invoke } from '../execute/methods.ts'
import { webresearch } from '../execute/webresearch.ts'
import { websearch } from '../execute/websearch.ts'
import { webfetch } from '../execute/webfetch.ts'
import { execFail, execOk, fetcherStdout, makeBackend, makeCtx, prefixRouter, testConfig } from './support.mjs'

const SOURCES = [
  {
    id: 'a',
    name: 'Alpha',
    kind: 'html',
    parse: 'ddg-html',
    enabled: true,
    endpoint: 'https://a.test/search',
    query_param: 'q',
    timeout_ms: 1000,
  },
]

const DDG = '<a class="result__a" href="https://net.test/1">Net</a><a class="result__snippet">net snip</a>'

const PAGE_HTML =
  '<html><head><title>Page One</title></head><body><article>' +
  '<p>This paragraph is about chrono body content quality for agent search tooling.</p>' +
  '<p>A second unrelated paragraph about gardening flowers outside the topic entirely.</p>' +
  '</article></body></html>'

/** DDG 结果指向可抓取的正文页；正文页回 PAGE_HTML。 */
function readRoutes() {
  return prefixRouter([
    [
      'https://a.test/search',
      execOk(
        fetcherStdout({
          body: '<a class="result__a" href="https://page.test/1">Page One</a><a class="result__snippet">snip</a>',
        }),
      ),
    ],
    ['https://page.test/1', execOk(fetcherStdout({ contentType: 'text/html', body: PAGE_HTML }))],
  ])
}

/** 记录写回的索引假后端。 */
function recordingIndex() {
  let putBag = null
  return {
    get putBag() {
      return putBag
    },
    indexRouter: (method, bag) => {
      if (method === 'search') return { ok: true, value: { results: [] } }
      putBag = bag
      return { ok: true, value: { stored: (bag.documents ?? []).length } }
    },
  }
}

function config(overrides = {}) {
  return testConfig({ sources: SOURCES, index_enabled: true, index_name: 'Index', ...overrides })
}

test('索引命中作为一个源参与合并，并把本次结果写回索引', async () => {
  const router = prefixRouter([['https://a.test/search', execOk(fetcherStdout({ body: DDG }))]])
  let putBag = null
  const indexRouter = (method, bag) => {
    if (method === 'search') {
      return { ok: true, value: { results: [{ url: 'https://idx.test/1', title: 'Idx', snippet: 'idx snip' }] } }
    }
    if (method === 'put') {
      putBag = bag
      return { ok: true, value: { stored: (bag.documents ?? []).length } }
    }
    return undefined
  }
  const { backend, indexCalls } = makeBackend(router, indexRouter)
  const result = await websearch({ query: 'chrono', count: 5 }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Index', 'Alpha'])
  const urls = result.result.results.map((entry) => entry.url)
  assert.ok(urls.includes('https://idx.test/1'))
  assert.ok(urls.includes('https://net.test/1'))
  assert.ok(indexCalls.some((call) => call.method === 'search'))
  assert.ok(putBag !== null, '应写回索引')
  assert.equal(putBag.documents.length, result.result.results.length)
  assert.deepEqual(Object.keys(putBag.documents[0]).sort(), [
    'body',
    'snippet',
    'source',
    'title',
    'url',
  ])
  assert.equal(putBag.documents[0].body, '', 'websearch 只回灌链接 + snippet，不带正文')
})

test('网络全失败但索引有命中 → 离线兜底成功', async () => {
  const router = () => execFail('fetch_failed', 'down')
  const indexRouter = (method) =>
    method === 'search'
      ? { ok: true, value: { results: [{ url: 'https://idx.test/1', title: 'Idx' }] } }
      : { ok: true, value: { stored: 0 } }
  const { backend } = makeBackend(router, indexRouter)
  const result = await websearch({ query: 'chrono' }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Index'])
  assert.deepEqual(result.result.sources_failed, [
    { source: 'Alpha', code: 'fetch_failed', message: 'down' },
  ])
  assert.equal(result.result.results[0].url, 'https://idx.test/1')
})

test('index_enabled=false → 不触发任何索引调用', async () => {
  const router = prefixRouter([['https://a.test/search', execOk(fetcherStdout({ body: DDG }))]])
  const { backend, indexCalls } = makeBackend(router, () => {
    throw new Error('index must not be called')
  })
  const result = await websearch({ query: 'chrono' }, makeCtx(config({ index_enabled: false }), backend))
  assert.equal(result.ok, true)
  assert.equal(indexCalls.length, 0)
  assert.deepEqual(result.result.sources_used, ['Alpha'])
})

test('索引返回畸形 / 不可用 → 静默降级，网络结果照回', async () => {
  const router = prefixRouter([['https://a.test/search', execOk(fetcherStdout({ body: DDG }))]])
  const indexRouter = (method) =>
    method === 'search' ? { ok: true, value: { results: 'nope' } } : { ok: true, value: { stored: 0 } }
  const { backend } = makeBackend(router, indexRouter)
  const result = await websearch({ query: 'chrono' }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.sources_used, ['Alpha'])
  assert.equal(result.result.results[0].url, 'https://net.test/1')

  const { backend: down } = makeBackend(router)
  const degraded = await websearch({ query: 'chrono' }, makeCtx(config(), down))
  assert.deepEqual(degraded.result.sources_used, ['Alpha'])
})

test('webresearch：抓到的正文回灌索引（带 body），并照回 content', async () => {
  const index = recordingIndex()
  const { backend } = makeBackend(readRoutes(), index.indexRouter)
  const result = await webresearch({ query: 'chrono', read: 1 }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.ok(result.result.results[0].content.includes('chrono body content'))
  assert.equal(index.putBag.documents.length, 1)
  assert.equal(index.putBag.documents[0].url, 'https://page.test/1')
  assert.ok(index.putBag.documents[0].body.includes('chrono body content'))
  assert.equal(index.putBag.documents[0].title, 'Page One')
})

test('webresearch highlights：只回相关段落，content 置空，仍回灌正文', async () => {
  const index = recordingIndex()
  const { backend } = makeBackend(readRoutes(), index.indexRouter)
  const result = await webresearch(
    { query: 'chrono', read: 1, highlights: true },
    makeCtx(config(), backend),
  )
  assert.equal(result.ok, true)
  const item = result.result.results[0]
  assert.equal(item.content, '')
  assert.ok(Array.isArray(item.highlights))
  assert.ok(item.highlights.join(' ').includes('chrono'))
  assert.ok(index.putBag.documents[0].body.includes('chrono body content'), '正文仍回灌索引')
})

test('webfetch：文本页回灌索引（title + 正文）', async () => {
  const index = recordingIndex()
  const router = prefixRouter([
    ['https://page.test/2', execOk(fetcherStdout({ contentType: 'text/html', body: PAGE_HTML }))],
  ])
  const { backend } = makeBackend(router, index.indexRouter)
  const result = await webfetch({ url: 'https://page.test/2' }, makeCtx(config(), backend))
  assert.equal(result.ok, true)
  assert.equal(index.putBag.documents.length, 1)
  assert.equal(index.putBag.documents[0].title, 'Page One')
  assert.equal(index.putBag.documents[0].source, 'webfetch')
  assert.ok(index.putBag.documents[0].body.includes('chrono body content'))
})

test('webfetch：HTML 正文过短 / 403 → render_suggested', async () => {
  const thin = prefixRouter([
    [
      'https://thin.test/',
      execOk(fetcherStdout({ contentType: 'text/html', body: '<html><body><div>short</div></body></html>' })),
    ],
  ])
  const shortResult = await webfetch(
    { url: 'https://thin.test/' },
    makeCtx(config({ index_enabled: false }), makeBackend(thin).backend),
  )
  assert.equal(shortResult.ok, true)
  assert.equal(shortResult.result.render_suggested, true)

  const blocked = prefixRouter([
    [
      'https://blocked.test/',
      execOk(fetcherStdout({ status: 403, contentType: 'text/html', body: '<html><body>challenge</body></html>' })),
    ],
  ])
  const blockedResult = await webfetch(
    { url: 'https://blocked.test/' },
    makeCtx(config({ index_enabled: false }), makeBackend(blocked).backend),
  )
  assert.equal(blockedResult.ok, false)
  assert.equal(blockedResult.error.code, 'http_status')
  assert.equal(blockedResult.error.render_suggested, true)
})

test('webresearch：HTML 正文过短 → 该条 render_suggested', async () => {
  const router = prefixRouter([
    [
      'https://a.test/search',
      execOk(
        fetcherStdout({
          body: '<a class="result__a" href="https://thin.test/1">Thin</a><a class="result__snippet">s</a>',
        }),
      ),
    ],
    [
      'https://thin.test/1',
      execOk(fetcherStdout({ contentType: 'text/html', body: '<html><body><div>tiny</div></body></html>' })),
    ],
  ])
  const { backend } = makeBackend(router)
  const result = await webresearch(
    { query: 'chrono', read: 1 },
    makeCtx(config({ index_enabled: false }), backend),
  )
  assert.equal(result.ok, true)
  assert.equal(result.result.results[0].render_suggested, true)
})

test('invoke 路由：highlights=true 走研究形态（检索 + 抓正文）', async () => {
  const index = recordingIndex()
  const { backend, execCalls } = makeBackend(readRoutes(), index.indexRouter)
  await invoke(
    { tool: 'websearch', args: { query: 'chrono', highlights: true }, config: config() },
    null,
    backend,
  )
  assert.equal(execCalls.length, 2, '检索源 + 正文页各一次')

  const plain = makeBackend(readRoutes(), index.indexRouter)
  await invoke(
    { tool: 'websearch', args: { query: 'chrono' }, config: config() },
    null,
    plain.backend,
  )
  assert.equal(plain.execCalls.length, 1, '普通检索只打源')
})
