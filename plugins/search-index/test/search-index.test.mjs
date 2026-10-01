// search-index 门面方法级测试（注入假反向通道，离线零依赖）：
// 多后端检索合并去重、后端失败隔离、写入委派、规模汇总、入参门禁。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHandlers, SEARCH_INDEX_PROVIDER } from '../execute/methods.ts'

/** 假反向通道：按 (provider, method) 路由到 router，未命中回 not_loaded。 */
function makeLink(router) {
  const calls = []
  return {
    calls,
    link: {
      async call(port, method, args, options = {}) {
        calls.push({ port, method, args, provider: options.provider })
        const outcome = router(port, method, args, options.provider)
        return outcome ?? { ok: false, code: 'not_loaded', message: 'no route' }
      },
    },
  }
}

function ok(value) {
  return { ok: true, value }
}

test('检索：多后端按 URL 去重，取名次更优者，确定排序', async () => {
  const { link } = makeLink((port, method, _args, provider) => {
    if (port !== SEARCH_INDEX_PROVIDER || method !== 'search') return undefined
    if (provider === 'p1') {
      return ok({ results: [{ url: 'https://a.test/1', title: 'A' }, { url: 'https://b.test/1', title: 'B-from-p1' }] })
    }
    if (provider === 'p2') {
      return ok({ results: [{ url: 'https://b.test/1', title: 'B-from-p2' }, { url: 'https://c.test/1', title: 'C' }] })
    }
    return undefined
  })
  const handlers = createHandlers({ link, providers: ['p1', 'p2'] })
  const { value } = await handlers.search({ query: 'x', limit: 10 }, {})
  assert.deepEqual(
    value.results.map((item) => item.url),
    ['https://a.test/1', 'https://b.test/1', 'https://c.test/1'],
  )
  // p2 的 B 名次更优（rank 1），条目取 p2
  const b = value.results.find((item) => item.url === 'https://b.test/1')
  assert.equal(b.title, 'B-from-p2')
  assert.equal(b.source, 'p2')
  assert.deepEqual(value.results.map((item) => item.rank), [1, 2, 3])
})

test('后端失败只隔离该成员，其余照回；全失败回空结果', async () => {
  const { link } = makeLink((port, method, _args, provider) => {
    if (provider === 'down') return { ok: false, code: 'transport_failed', message: 'boom' }
    if (provider === 'up' && method === 'search') return ok({ results: [{ url: 'https://up.test/1', title: 'U' }] })
    return undefined
  })
  const handlers = createHandlers({ link, providers: ['down', 'up'] })
  const { value } = await handlers.search({ query: 'x' }, {})
  assert.equal(value.results.length, 1)
  assert.equal(value.results[0].url, 'https://up.test/1')

  const allDown = createHandlers({ link, providers: ['down'] })
  const { value: empty } = await allDown.search({ query: 'x' }, {})
  assert.deepEqual(empty.results, [])
})

test('写入：逐后端委派，stored 取各后端回报最大值', async () => {
  const { link, calls } = makeLink((port, method, _args, provider) => {
    if (method !== 'put') return undefined
    return ok({ stored: provider === 'p2' ? 3 : 2 })
  })
  const handlers = createHandlers({ link, providers: ['p1', 'p2'] })
  const documents = [{ url: 'https://a.test/', title: 'A' }]
  const { value } = await handlers.put({ documents }, {})
  assert.equal(value.stored, 3)
  assert.equal(calls.filter((call) => call.method === 'put').length, 2)
  assert.deepEqual(calls[0].args.documents[0].url, 'https://a.test/')
})

test('规模汇总：逐后端 docs 求和，失败按 0 记', async () => {
  const { link } = makeLink((port, method, _args, provider) => {
    if (method !== 'stats') return undefined
    if (provider === 'p1') return ok({ docs: 4 })
    if (provider === 'p2') return { ok: false, code: 'transport_failed', message: 'down' }
    return ok({ docs: 6 })
  })
  const handlers = createHandlers({ link, providers: ['p1', 'p2', 'p3'] })
  const { value } = await handlers.stats({}, {})
  assert.equal(value.docs, 10)
  assert.deepEqual(value.providers, [
    { provider: 'p1', docs: 4 },
    { provider: 'p2', docs: 0 },
    { provider: 'p3', docs: 6 },
  ])
})

test('入参门禁：空 query / 非法 limit / documents 非数组 → BadArgsError', async () => {
  const { link } = makeLink(() => undefined)
  const handlers = createHandlers({ link, providers: [] })
  await assert.rejects(() => handlers.search({ query: '  ' }, {}))
  await assert.rejects(() => handlers.search({ query: 'x', limit: 0 }, {}))
  await assert.rejects(() => handlers.put({ documents: 'nope' }, {}))
  await assert.rejects(() => handlers.put({}, {}))
})
