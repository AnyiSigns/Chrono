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
    ['https://www.bing.com/search', execOk(fetcherStdout({ contentType: 'application/rss+xml', body: '<rss><channel><item><title>Bing</title><link>https://bing.test/a</link><description>bing snip</description></item></channel></rss>' }))],
    ['https://www.mojeek.com/search', execOk(fetcherStdout({ body: '<a class="ob" href="https://mojeek.test/a">Mojeek</a><p class="s">mojeek snip</p></a>' }))],
  ])
  const { backend } = makeBackend(router)
  const config = mergeConfig({ obey_robots: false })
  const result = await websearch({ query: 'chrono' }, makeCtx(config, backend))
  assert.equal(result.ok, true)
  assert.equal(result.result.sources_used.length, 2)
  assert.deepEqual(result.result.sources_failed, [])
  assert.ok(result.result.results.length >= 2)
})
