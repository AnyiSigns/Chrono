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
  assert.ok(!('pins' in decl), 'pins 字段已删除')
  assert.deepEqual(decl.needs, {
    host: { mode: 'one' },
    sandbox: { mode: 'one' },
    'search-index': { mode: 'many', methods: ['search', 'put'] },
  })
  assert.ok(!JSON.stringify(decl).includes('secrets'))
})

test('缺省清单零配置可检索（假后端，离线）', async () => {
  const router = prefixRouter([
    [
      'https://www.bing.com/search',
      execOk(
        fetcherStdout({
          contentType: 'application/rss+xml',
          body: '<rss><channel><item><title>Bing</title><link>https://bing.test/a</link><description>bing snip</description></item></channel></rss>',
        }),
      ),
    ],
    [
      'https://www.mojeek.com/search',
      execOk(
        fetcherStdout({
          body: '<a class="ob" href="https://mojeek.test/a">Mojeek</a><p class="s">mojeek snip</p></a>',
        }),
      ),
    ],
    [
      'https://api.openalex.org/works',
      execOk(
        fetcherStdout({
          contentType: 'application/json',
          body: '{"results":[{"display_name":"OpenAlex Paper","doi":"https://doi.org/10.1/a","publication_year":2024}]}',
        }),
      ),
    ],
    [
      'https://api.stackexchange.com/2.3/search/advanced',
      execOk(
        fetcherStdout({
          contentType: 'application/json',
          body: '{"items":[{"title":"Stack Q","link":"https://stackoverflow.test/q","excerpt":"stack snip"}]}',
        }),
      ),
    ],
    [
      'https://hn.algolia.com/api/v1/search',
      execOk(
        fetcherStdout({
          contentType: 'application/json',
          body: '{"hits":[{"title":"HN Story","url":"https://hn.test/s","objectID":"1"}]}',
        }),
      ),
    ],
    [
      'https://export.arxiv.org/api/query',
      execOk(
        fetcherStdout({
          contentType: 'application/atom+xml',
          body: '<feed><entry><title>Arxiv Paper</title><id>https://arxiv.org/abs/2401.00001</id><summary>arxiv snip</summary></entry></feed>',
        }),
      ),
    ],
  ])
  const { backend } = makeBackend(router)
  const config = mergeConfig({ obey_robots: false })
  const result = await websearch({ query: 'chrono' }, makeCtx(config, backend))
  assert.equal(result.ok, true)
  assert.equal(result.result.sources_used.length, 6)
  assert.deepEqual(result.result.sources_failed, [])
  assert.ok(result.result.results.length >= 6)
})
