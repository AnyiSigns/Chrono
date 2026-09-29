// `tool-dispatch` 逻辑级测试：直接 import execute 源码（不 spawn 服务），覆盖并发配置 / 结果缓存 / 目录索引。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  resolveCacheEnabled,
  resolveConcurrency,
} from '../execute/config.ts'
import { ResultCache } from '../execute/cache.ts'
import { indexDirectory } from '../execute/dispatch.ts'

test('配置：并发上限解析与缓存开关', () => {
  assert.equal(resolveConcurrency({}), DEFAULT_CONCURRENCY)
  assert.equal(resolveConcurrency({ concurrency: 2 }), 2)
  assert.equal(resolveConcurrency({ concurrency: 0 }), DEFAULT_CONCURRENCY)
  assert.equal(resolveConcurrency({ concurrency: 10000 }), MAX_CONCURRENCY)
  assert.equal(resolveCacheEnabled({}, true), true)
  assert.equal(resolveCacheEnabled({ cache: false }, true), false)
  assert.equal(resolveCacheEnabled({ cache: { enabled: false } }, true), false)
})

test('结果缓存：同键单飞、失败不登记、超限淘汰', async () => {
  let calls = 0
  const cache = new ResultCache(2, true)
  const loader = async () => {
    calls += 1
    return { n: calls }
  }
  const [first, second] = await Promise.all([cache.run('k', loader), cache.run('k', loader)])
  assert.deepEqual(first, second)
  assert.equal(calls, 1, '同键并发应单飞')
  assert.equal(cache.size(), 1)

  let failed = 0
  await assert.rejects(
    cache.run('bad', async () => {
      failed += 1
      throw new Error('boom')
    }),
  )
  assert.equal(failed, 1)
  assert.equal(cache.size(), 1, '失败条目应被摘除')

  await cache.run('a', loader)
  await cache.run('b', loader)
  await cache.run('c', loader)
  assert.equal(cache.size(), 2, '超上限应淘汰最旧')
})

test('indexDirectory：按名索引并保留 provider / kind / method / read', () => {
  const directory = indexDirectory({
    tools: [{ name: 'read', provider: 'tool-fs', kind: 'invoke' }],
    rejected: [{ name: 'broken', code: 'bad_tool_decl', message: 'missing boundaries' }],
  })
  assert.equal(directory.tools.length, 1)
  assert.equal(directory.byName.get('read').provider, 'tool-fs')
  assert.equal(directory.rejected[0].message, 'missing boundaries')
  const empty = indexDirectory(null)
  assert.equal(empty.tools.length, 0)
  assert.equal(empty.rejected.length, 0)
})
