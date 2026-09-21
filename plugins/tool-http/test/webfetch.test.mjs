// webfetch 测试：content-type 分流、HTML→markdown 确定性、raw 原样、超限截断、
// 二进制资产存取、net_denied / http_status 透传、bad_url。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { webfetch } from '../execute/webfetch.ts'
import { execFail, execOk, execOkTruncated, fetcherStdout, makeBackend, makeCtx, prefixRouter, testConfig } from './support.mjs'

const ARTICLE =
  '<html><head><title>T</title></head><body><article>' +
  '<h1>Hello</h1>' +
  '<p>World <a href="https://x.test/">link</a>.</p>' +
  '<ul><li>alpha</li><li>beta</li></ul>' +
  '<pre><code>const a = 1</code></pre>' +
  '</article></body></html>'

function ctxFor(router, overrides = {}) {
  const { backend, execCalls, assetCalls } = makeBackend(router)
  return { ctx: makeCtx(testConfig(overrides), backend), execCalls, assetCalls }
}

test('text/html → markdown，且同输入同输出', async () => {
  const router = prefixRouter([['https://page.test/', execOk(fetcherStdout({ contentType: 'text/html; charset=utf-8', body: ARTICLE }))]])
  const { ctx } = ctxFor(router)
  const first = await webfetch({ url: 'https://page.test/' }, ctx)
  assert.equal(first.ok, true)
  assert.equal(first.result.status, 200)
  assert.equal(first.result.content_type, 'text/html')
  assert.equal(first.result.truncated, false)
  assert.ok(first.result.content.includes('# Hello'))
  assert.ok(first.result.content.includes('World [link](https://x.test/).'))
  assert.ok(first.result.content.includes('```\nconst a = 1\n```'))
  const second = await webfetch({ url: 'https://page.test/' }, ctx)
  assert.equal(first.result.content, second.result.content)
})

test('format=raw 原样返回 HTML；format=text 去标记', async () => {
  const router = prefixRouter([['https://page.test/', execOk(fetcherStdout({ contentType: 'text/html', body: ARTICLE }))]])
  const { ctx } = ctxFor(router)
  const raw = await webfetch({ url: 'https://page.test/', format: 'raw' }, ctx)
  assert.equal(raw.result.content, ARTICLE)
  const text = await webfetch({ url: 'https://page.test/', format: 'text' }, ctx)
  assert.ok(text.result.content.includes('Hello'))
  assert.ok(!text.result.content.includes('<'))
})

test('application/json / text/* 原样返回', async () => {
  const router = prefixRouter([
    ['https://json.test/', execOk(fetcherStdout({ contentType: 'application/json', body: '{"a":1}' }))],
    ['https://txt.test/', execOk(fetcherStdout({ contentType: 'text/plain', body: 'plain body' }))],
  ])
  const { ctx } = ctxFor(router)
  const json = await webfetch({ url: 'https://json.test/' }, ctx)
  assert.equal(json.result.content, '{"a":1}')
  const text = await webfetch({ url: 'https://txt.test/' }, ctx)
  assert.equal(text.result.content, 'plain body')
})

test('文本超限截断并标记 truncated', async () => {
  const router = prefixRouter([['https://big.test/', execOk(fetcherStdout({ contentType: 'text/plain', body: 'abcdefghijklmnop' }))]])
  const { ctx } = ctxFor(router, { output_max: 10 })
  const result = await webfetch({ url: 'https://big.test/' }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.result.content, 'abcdefghij')
  assert.equal(result.result.truncated, true)
})

test('二进制 → host.asset.put 被调，结果带资产引用', async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 254])
  const router = prefixRouter([['https://bin.test/', execOk(fetcherStdout({ contentType: 'application/octet-stream', body: bytes }))]])
  const { ctx, assetCalls } = ctxFor(router)
  const result = await webfetch({ url: 'https://bin.test/' }, ctx)
  assert.equal(result.ok, true)
  assert.equal(assetCalls.length, 1)
  assert.equal(assetCalls[0].mime, 'application/octet-stream')
  assert.deepEqual(Buffer.from(assetCalls[0].bytes, 'base64'), bytes)
  assert.equal(result.result.content, '')
  assert.equal(result.result.asset.kind, 'asset')
  assert.equal(result.result.asset.size, bytes.length)
})

test('net_denied 透传，webfetch 声明 caps.net = all', async () => {
  const { ctx, execCalls } = ctxFor(() => execFail('net_denied', 'declared net all exceeds tier net none'))
  const result = await webfetch({ url: 'https://denied.test/' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'net_denied')
  assert.equal(execCalls[0].caps.net, 'all')
})

test('4xx / 5xx → http_status（附 status）', async () => {
  const router = prefixRouter([['https://missing.test/', execOk(fetcherStdout({ status: 404, contentType: 'text/html', body: 'nope' }))]])
  const { ctx } = ctxFor(router)
  const result = await webfetch({ url: 'https://missing.test/' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'http_status')
  assert.equal(result.error.status, 404)
})

test('obey_robots 开启且被禁 → robots_disallowed', async () => {
  const router = prefixRouter([
    ['https://page.test/robots.txt', execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nDisallow: /' }))],
    ['https://page.test/', execOk(fetcherStdout({ body: ARTICLE }))],
  ])
  const { ctx } = ctxFor(router, { obey_robots: true })
  const result = await webfetch({ url: 'https://page.test/' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'robots_disallowed')
})

test('sandbox 超时码映射为 tool_timeout', async () => {
  const timeoutValue = { exit_code: null, stdout: '', stderr: '', truncated: false, duration_ms: 10, code: 'timeout' }
  const { ctx } = ctxFor(() => ({ ok: true, value: timeoutValue }))
  const result = await webfetch({ url: 'https://slow.test/' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'tool_timeout')
})

test('bad_url：非 http(s) 与内网地址', async () => {
  const { ctx } = ctxFor(() => execOk(fetcherStdout({ body: '' })))
  const scheme = await webfetch({ url: 'ftp://x.test/a' }, ctx)
  assert.equal(scheme.error.code, 'bad_url')
  const privateHost = await webfetch({ url: 'http://127.0.0.1/admin' }, ctx)
  assert.equal(privateHost.error.code, 'bad_url')
  const missing = await webfetch({}, ctx)
  assert.equal(missing.error.code, 'bad_args')
})

test('exec 截断（stdout 被隔离执行截断）合并进 truncated：文本标记、二进制 too_large 不存资产', async () => {
  const router = prefixRouter([
    ['https://big.test/trunc', execOkTruncated(fetcherStdout({ contentType: 'text/plain', body: 'abc' }))],
    [
      'https://bin.test/trunc',
      execOkTruncated(fetcherStdout({ contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2]) })),
    ],
  ])
  const { ctx, assetCalls } = ctxFor(router)
  const text = await webfetch({ url: 'https://big.test/trunc' }, ctx)
  assert.equal(text.ok, true)
  assert.equal(text.result.truncated, true)
  const binary = await webfetch({ url: 'https://bin.test/trunc' }, ctx)
  assert.equal(binary.ok, false)
  assert.equal(binary.error.code, 'too_large')
  assert.equal(assetCalls.length, 0, '被截断的二进制不得存资产')
})

test('重定向后最终 URL 落到内网 → bad_url（不放过 SSRF 绕行）', async () => {
  const router = prefixRouter([
    ['https://page.test/', execOk(fetcherStdout({ contentType: 'text/html', body: 'x', url: 'http://127.0.0.1/secret' }))],
  ])
  const { ctx } = ctxFor(router)
  const result = await webfetch({ url: 'https://page.test/' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad_url')
})

test('robots 对重定向后的最终 URL 复查：最终路径被禁 → robots_disallowed', async () => {
  const router = prefixRouter([
    [
      'https://page.test/robots.txt',
      execOk(fetcherStdout({ contentType: 'text/plain', body: 'User-agent: *\nDisallow: /b' })),
    ],
    [
      'https://page.test/a',
      execOk(fetcherStdout({ contentType: 'text/html', body: ARTICLE, url: 'https://page.test/b' })),
    ],
  ])
  const { ctx } = ctxFor(router, { obey_robots: true })
  const result = await webfetch({ url: 'https://page.test/a' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'robots_disallowed')
})
