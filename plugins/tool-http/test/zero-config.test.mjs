// 零配置红线测试：不读环境变量、不 pin 密钥面，缺省清单即可检索。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { mergeConfig } from '../execute/config.ts'
import { websearch } from '../execute/websearch.ts'
import { execOk, fetcherStdout, makeBackend, makeCtx, prefixRouter } from './support.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTE_DIR = join(PKG_ROOT, 'execute')

test('服务代码不读环境变量', () => {
  for (const name of readdirSync(EXECUTE_DIR)) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(join(EXECUTE_DIR, name), 'utf8')
    assert.ok(!text.includes('process.env'), `${name} 读取了 process.env`)
  }
})

test('plugin.json 不 pin 密钥面（零配置）', () => {
  const decl = JSON.parse(readFileSync(join(PKG_ROOT, 'plugin.json'), 'utf8'))
  assert.deepEqual(decl.pins, { sandbox: 'sandbox', host: 'host' })
  assert.ok(!JSON.stringify(decl).includes('secrets'))
})

test('缺省清单零配置可检索（假后端，离线）', async () => {
  const router = prefixRouter([
    ['https://html.duckduckgo.com/html/', execOk(fetcherStdout({ body: '<a class="result__a" href="https://ddg.test/a">DDG</a><a class="result__snippet">ddg snip</a>' }))],
    ['https://lite.duckduckgo.com/lite/', execOk(fetcherStdout({ body: '<a class="result-link" href="https://lite.test/a">Lite</a><td class="result-snippet">lite snip</td>' }))],
    ['https://www.bing.com/search', execOk(fetcherStdout({ body: '<li class="b_algo"><h2><a href="https://bing.test/a">Bing</a></h2><p>bing snip</p></li>' }))],
    ['https://www.mojeek.com/search', execOk(fetcherStdout({ body: '<a class="ob" href="https://mojeek.test/a">Mojeek</a><p class="s">mojeek snip</p>' }))],
    ['https://searx.be', execOk(fetcherStdout({ contentType: 'application/json', body: '{"results":[{"title":"SX","url":"https://searx.test/a","content":"sx snip"}]}' }))],
    ['https://en.wikipedia.org/w/api.php', execOk(fetcherStdout({ contentType: 'application/json', body: '{"query":{"search":[{"title":"Wiki","snippet":"wiki snip"}]}}' }))],
  ])
  const { backend } = makeBackend(router)
  const config = mergeConfig({ obey_robots: false })
  const result = await websearch({ query: 'chrono' }, makeCtx(config, backend))
  assert.equal(result.ok, true)
  assert.equal(result.result.sources_used.length, 6)
  assert.deepEqual(result.result.sources_failed, [])
  assert.ok(result.result.results.length >= 6)
})
