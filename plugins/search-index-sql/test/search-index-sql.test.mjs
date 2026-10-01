// search-index-sql 服务协议级测试：SDK 驱动 spawn `node execute/main.ts`。
// 覆盖包形状、握手、写入 / 检索往返、按 emitter 分命名空间、同 URL 覆盖、CJK 子串、重启持久化、门禁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const CAP = 'search-index-provider'

function tempData() {
  return mkdtempSync(join(tmpdir(), 'search-index-sql-'))
}

function wrap(drv) {
  return {
    ...drv,
    hello: () => drv.hello(CAP),
    call: (method, args, emitter = null) =>
      drv.call(CAP, method, args, {
        run: null,
        thread: null,
        now: 1_700_000_000_000,
        emitter,
      }),
  }
}

async function withService(dataDir, fn) {
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT, env: { CHRONO_PLUGIN_DATA: dataDir } })
  try {
    return await fn(wrap(drv))
  } finally {
    drv.close()
    await drv.exit
  }
}

function assertOk(message) {
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

test('hello 回 manifest：身份 / 能力类 / 方法与 plugin.json 一致，state=durable', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const manifest = await drv.hello()
      assert.equal(manifest.identity, 'search-index-sql')
      assert.deepEqual(manifest.implements, [CAP])
      assert.deepEqual(manifest.methods[CAP], ['search', 'put', 'stats'])
      assert.equal(manifest.protocol, '1')
      assert.equal(manifest.state, 'durable')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('写入 / 检索往返：英文 token 命中并按 bm25 排序', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const put = assertOk(
        await drv.call(
          'put',
          {
            documents: [
              { url: 'https://a.test/1', title: 'Chrono agent tools', snippet: 'search quality', body: 'chrono websearch pipeline' },
              { url: 'https://a.test/2', title: 'Unrelated', snippet: 'nothing', body: 'gardening' },
            ],
          },
          'tool-http',
        ),
      )
      assert.equal(put.stored, 2)
      assert.deepEqual(assertOk(await drv.call('stats', {}, 'tool-http')), { docs: 2 })

      const found = assertOk(await drv.call('search', { query: 'chrono websearch' }, 'tool-http'))
      assert.equal(found.results.length, 1)
      assert.equal(found.results[0].url, 'https://a.test/1')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('CJK 子串：trigram 分词命中中文片段', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(
        await drv.call(
          'put',
          { documents: [{ url: 'https://cn.test/1', title: '工具链体验报告', snippet: '联网检索', body: '质量很关键' }] },
          'tool-http',
        ),
      )
      const found = assertOk(await drv.call('search', { query: '工具链' }, 'tool-http'))
      assert.equal(found.results.length, 1)
      assert.equal(found.results[0].url, 'https://cn.test/1')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('同 URL 覆盖写：stats 不增，检索见新内容', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { documents: [{ url: 'https://x.test/a', title: 'Old', body: 'old body' }] }, 'tool-http'))
      assertOk(await drv.call('put', { documents: [{ url: 'https://x.test/a', title: 'New', body: 'new body' }] }, 'tool-http'))
      assert.deepEqual(assertOk(await drv.call('stats', {}, 'tool-http')), { docs: 1 })
      const found = assertOk(await drv.call('search', { query: 'new body' }, 'tool-http'))
      assert.equal(found.results[0].title, 'New')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('按 emitter 分命名空间：A 写的 B 查不到', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { documents: [{ url: 'https://a.test/p', title: 'owner-a only' }] }, 'owner-a'))
      const bFound = assertOk(await drv.call('search', { query: 'owner-a' }, 'owner-b'))
      assert.deepEqual(bFound.results, [])
      assert.deepEqual(assertOk(await drv.call('stats', {}, 'owner-b')), { docs: 0 })
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('门禁：空 query / documents 非数组 / 自报 namespace 一律 bad_args', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const empty = await drv.call('search', { query: '   ' }, 'owner-a')
      assert.equal(empty.kind, 'error')
      assert.equal(empty.code, 'bad_args')

      const badDocs = await drv.call('put', { documents: 'nope' }, 'owner-a')
      assert.equal(badDocs.code, 'bad_args')

      for (const key of ['namespace', 'owner', 'db', 'emitter']) {
        const forged = await drv.call('search', { query: 'x', [key]: 'forged' }, 'owner-a')
        assert.equal(forged.code, 'bad_args', key)
      }
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('重启持久化：同 CHRONO_PLUGIN_DATA 二次启动数据仍在', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { documents: [{ url: 'https://keep.test/1', title: 'persisted', body: 'durable' }] }, 'tool-http'))
    })
    await withService(dataDir, async (drv) => {
      assert.deepEqual(assertOk(await drv.call('stats', {}, 'tool-http')), { docs: 1 })
      const found = assertOk(await drv.call('search', { query: 'persisted' }, 'tool-http'))
      assert.equal(found.results[0].url, 'https://keep.test/1')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json 与 execute/ 均在包内（PKG_ROOT 自检）', () => {
  assert.ok(PKG_ROOT.endsWith('search-index-sql'))
})
