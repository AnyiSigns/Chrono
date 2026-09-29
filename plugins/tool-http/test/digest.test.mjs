// 提供方 digest 契约：成功结果自带结构化摘要，形状是上下文老化可直接消费的普通对象
// （`context-window` 按 `result.digest` 为普通对象即原样带出，无需认识本工具语义）。
// 断言字段值确定、有界，且不改变结果原有字段。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { webfetch } from '../execute/webfetch.ts'
import { websearch } from '../execute/websearch.ts'
import { webresearch } from '../execute/webresearch.ts'
import {
  execOk,
  fetcherStdout,
  makeBackend,
  makeCtx,
  prefixRouter,
  testConfig,
} from './support.mjs'

/** 与消费方 `isRecord` 同口径：非 null、非数组的对象。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SEARCH_SOURCES = [
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

const ONE_HIT =
  '<div class="result"><a class="result__a" href="https://one.test/page">One</a>' +
  '<a class="result__snippet">snippet</a></div>'

function searchBackend() {
  const router = prefixRouter([
    ['https://a.test/search', execOk(fetcherStdout({ contentType: 'text/html', body: ONE_HIT }))],
  ])
  return makeBackend(router).backend
}

test('webfetch 文本结果带 digest {url,status,bytes}', async () => {
  const router = prefixRouter([
    [
      'https://page.test/',
      execOk(
        fetcherStdout({ contentType: 'text/plain', body: 'hello', url: 'https://page.test/' }),
      ),
    ],
  ])
  const { backend } = makeBackend(router)
  const result = await webfetch({ url: 'https://page.test/' }, makeCtx(testConfig(), backend))
  assert.equal(result.ok, true)
  assert.equal(result.result.content, 'hello')
  const digest = result.result.digest
  assert.ok(isPlainObject(digest), 'digest 必须是普通对象')
  assert.equal(digest.url, 'https://page.test/')
  assert.equal(digest.status, 200)
  assert.equal(digest.bytes, Buffer.byteLength('hello', 'utf8'))
})

test('webfetch 二进制结果带 digest {url,status,bytes=资产体积}', async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 254])
  const router = prefixRouter([
    [
      'https://bin.test/',
      execOk(
        fetcherStdout({
          contentType: 'application/octet-stream',
          body: bytes,
          url: 'https://bin.test/',
        }),
      ),
    ],
  ])
  const { backend } = makeBackend(router)
  const result = await webfetch({ url: 'https://bin.test/' }, makeCtx(testConfig(), backend))
  assert.equal(result.ok, true)
  const digest = result.result.digest
  assert.ok(isPlainObject(digest))
  assert.equal(digest.url, 'https://bin.test/')
  assert.equal(digest.bytes, bytes.length)
})

test('websearch 结果带 digest {query,hits,sources}', async () => {
  const config = testConfig({ sources: SEARCH_SOURCES })
  const result = await websearch({ query: 'chrono' }, makeCtx(config, searchBackend()))
  assert.equal(result.ok, true)
  const digest = result.result.digest
  assert.ok(isPlainObject(digest))
  assert.equal(digest.query, 'chrono')
  assert.equal(digest.hits, result.result.results.length)
  assert.deepEqual(digest.sources, ['Alpha'])
})

test('webresearch 结果带 digest {query,hits,sources}', async () => {
  const config = testConfig({ sources: SEARCH_SOURCES })
  const result = await webresearch({ query: 'chrono', read: 0 }, makeCtx(config, searchBackend()))
  assert.equal(result.ok, true)
  const digest = result.result.digest
  assert.ok(isPlainObject(digest))
  assert.equal(digest.query, 'chrono')
  assert.equal(digest.hits, 1)
  assert.deepEqual(digest.sources, ['Alpha'])
})
