// invoke 路由测试：未知工具统一为 unknown_tool；顶层兜底把异常转结构化错误；
// 合并后的 websearch 依 read>0 决定是否继续抓正文（等价旧 webresearch）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { invoke } from '../execute/methods.ts'
import { execOk, fetcherStdout, makeBackend, prefixRouter, testConfig } from './support.mjs'

function sourceConfig() {
  return {
    id: 'x',
    name: 'X',
    kind: 'html',
    parse: 'ddg-html',
    enabled: true,
    endpoint: 'https://search.test/s',
    query_param: 'q',
    timeout_ms: 8000,
  }
}

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

test('未知工具 → unknown_tool（与 tool-shell 统一）', async () => {
  const result = await invoke({ tool: 'nope', args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown_tool')
})

test('缺 tool → bad_args', async () => {
  const result = await invoke({ args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad_args')
})

test('websearch：无 read / read=0 只检索；read>0 继续抓正文（旧 webresearch 形态）', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ contentType: 'text/html', body: searchHtml(['https://page1.test/a']) }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article('Body here.') }))],
  ])
  const { backend } = makeBackend(router)
  const config = { ...testConfig(), sources: [sourceConfig()] }

  const search = await invoke({ tool: 'websearch', args: { query: 'q' }, config }, null, backend)
  assert.equal(search.ok, true)
  assert.equal(search.result.results[0].read, undefined)

  const zero = await invoke({ tool: 'websearch', args: { query: 'q', read: 0 }, config }, null, backend)
  assert.equal(zero.ok, true)
  assert.equal(zero.result.results[0].read, undefined)

  const research = await invoke({ tool: 'websearch', args: { query: 'q', read: 1 }, config }, null, backend)
  assert.equal(research.ok, true)
  assert.equal(research.result.results[0].read, true)
  assert.ok(research.result.results[0].content.includes('Body here.'))
})

test('webresearch 旧名仍直达研究形态', async () => {
  const router = prefixRouter([
    ['https://search.test/s', execOk(fetcherStdout({ contentType: 'text/html', body: searchHtml(['https://page1.test/a']) }))],
    ['https://page1.test/a', execOk(fetcherStdout({ contentType: 'text/html', body: article('Body here.') }))],
  ])
  const { backend } = makeBackend(router)
  const config = { ...testConfig(), sources: [sourceConfig()] }
  const result = await invoke({ tool: 'webresearch', args: { query: 'q', read: 1 }, config }, null, backend)
  assert.equal(result.ok, true)
  assert.equal(result.result.results[0].read, true)
})
