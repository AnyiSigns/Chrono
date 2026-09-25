// `memory-store` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到确定性假向量化后端。
// 覆盖：握手 / 控制 / EOF 自退出；put/read/list 往返；世界不再新增世代；边跑边追加与中断残留；
// ③/④ 分界（删 ③ 后由 ④ 重建索引）；append/delete/pin/edit；search 暴力余弦；去重；形态非法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultBridge, queryVector, startService, testVector, waitReady } from './driver.mjs'

const AT = new Date(1_700_000_000_000).toISOString()

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'memory-store')
    assert.deepEqual(manifest.implements, ['memory'])
    assert.deepEqual(manifest.methods.memory, ['put', 'read', 'search', 'list', 'append', 'delete', 'pin', 'edit'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'durable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('put/read/list 往返；不产世界写计划', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha' })
    assert.equal(put.kind, 'result')
    assert.equal(put.value.ok, true)
    assert.equal(put.value.saved, true)
    assert.equal(put.value.dedup, 'vector')
    assert.equal(put.value.$directives, undefined, '运行记录不得产世界写计划')

    const id = put.value.id
    const read = await drv.call('read', { hash: id })
    assert.equal(read.value.entry.text, 'alpha')
    assert.equal(read.value.entry.meta.source, 'manual')
    assert.equal(read.value.entry.chunks.length, 1)
    assert.equal(read.value.entry.chunks[0].text, undefined)
    assert.equal(read.value.entry.prev, null)

    const batch = await drv.call('read', { hashes: [id, 'm-missing'] })
    assert.equal(batch.value.entries[0].entry.text, 'alpha')
    assert.equal(batch.value.entries[1].entry, null)
    assert.deepEqual(batch.value.missing, ['m-missing'])

    const list = await drv.call('list', {})
    assert.equal(list.value.kind, 'list')
    assert.deepEqual(list.value.entries.map((entry) => entry.text), ['alpha'])
    assert.equal(list.value.count, 1)
  } finally {
    drv.close()
  }
})

test('世界不再新增世代：服务只回 result / port.call，绝不发 write / put / commit / add_gen', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha' })
    assert.equal(put.value.$directives, undefined)
    assert.equal(
      drv.frames.some((frame) => ['write', 'put', 'commit', 'batch', 'add_gen'].includes(frame.kind)),
      false,
    )
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'chunk'))
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
  } finally {
    drv.close()
  }
})

test('链式 prev：第二条 prev 指向第一条 id，count 递增', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const first = await drv.call('put', { text: 'alpha' })
    const second = await drv.call('put', { text: 'beta' })
    const entryB = (await drv.call('read', { hash: second.value.id })).value.entry
    assert.deepEqual(entryB.prev, { def: first.value.id })
    assert.equal((await drv.call('list', {})).value.count, 2)
    assert.deepEqual(
      (await drv.call('list', {})).value.entries.map((entry) => entry.text),
      ['beta', 'alpha'],
    )
  } finally {
    drv.close()
  }
})

test('put 去重：同文本同 at ⇒ 重复、不新增', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const first = await drv.call('put', { text: 'alpha' })
    const again = await drv.call('put', { text: 'alpha' })
    assert.equal(again.value.saved, false)
    assert.equal(again.value.duplicate, true)
    assert.equal(again.value.duplicate_of.entry_hash, first.value.id)
    assert.equal((await drv.call('list', {})).value.count, 1)
  } finally {
    drv.close()
  }
})

test('search：暴力余弦确定、最小堆 top-k 部分选择', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const a = await drv.call('put', { text: 'alpha' })
    const b = await drv.call('put', { text: 'beta' })

    const exact = await drv.call('search', { query_vector: testVector('alpha'), top_k: 2 })
    assert.equal(exact.value.status, 'ready')
    assert.equal(exact.value.hits[0].entry_hash, a.value.id)
    assert.equal(exact.value.hits[0].score, 1)
    assert.equal(exact.value.hits[0].chunk_index, 0)
    assert.equal(exact.value.hits[1].entry_hash, b.value.id)

    const weighted = queryVector({ alpha: 1, beta: 0.5 })
    const top1 = await drv.call('search', { query_vector: weighted, top_k: 1 })
    assert.deepEqual(top1.value.hits.map((hit) => hit.entry_hash), [a.value.id])
    const top2 = await drv.call('search', { query_vector: weighted, top_k: 2 })
    assert.deepEqual(
      top2.value.hits.map((hit) => [hit.entry_hash, hit.score]),
      [
        [a.value.id, 1],
        [b.value.id, 0.5],
      ],
    )
  } finally {
    drv.close()
  }
})

test('③/④ 分界：删掉整个 CHRONO_PLUGIN_STATE 后，仍能从 ④ 重建索引并正常应答', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ms-data-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'ms-state-'))
  let idA
  try {
    const first = startService({ dataDir, stateDir })
    try {
      await first.hello()
      idA = (await first.call('put', { text: 'alpha' })).value.id
      await first.call('put', { text: 'beta' })
      const ready = await waitReady(first, { query_vector: testVector('alpha'), top_k: 2 })
      assert.equal(ready.value.hits[0].entry_hash, idA)
    } finally {
      first.close()
      await first.exit
    }

    // 删除整个 ③ 目录：索引与任何派生物都消失，只留 ④ 条目与 body。
    rmSync(stateDir, { recursive: true, force: true })

    const second = startService({ dataDir, stateDir })
    try {
      await second.hello()
      const list = await second.call('list', {})
      assert.deepEqual(list.value.entries.map((entry) => entry.text), ['beta', 'alpha'])
      const rebuilt = await waitReady(second, { query_vector: testVector('alpha'), top_k: 2 })
      assert.equal(rebuilt.value.hits[0].entry_hash, idA)
      assert.equal(rebuilt.value.hits[0].score, 1)
    } finally {
      second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('边跑边追加 + 中断残留可辨：append 中途失败留下 open 回合标记', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ms-data-'))
  try {
    const drv = startService({
      dataDir,
      bridge: (port, method, args) => {
        if (port === 'embedding' && method === 'embed' && Array.isArray(args?.texts) && args.texts.includes('boom')) {
          return Promise.resolve({ error: 'embedding_unavailable', message: 'boom' })
        }
        return Promise.resolve(defaultBridge(port, method, args))
      },
    })
    try {
      await drv.hello()
      const result = await drv.call('append', {
        entries: [
          { id: 'm-1', text: 'good', meta: { source: 'consolidate', at: AT, tags: [] } },
          { id: 'm-2', text: 'boom', meta: { source: 'consolidate', at: AT, tags: [] } },
        ],
      })
      assert.equal(result.value.ok, false)
      assert.equal(result.value.error.code, 'embedding_unavailable')
      // 已发生的事实已落盘：good 可读；回合仍 open（中断残留可辨）。
      const list = await drv.call('list', {})
      assert.deepEqual(list.value.entries.map((entry) => entry.text), ['good'])
      const log = readFileSync(join(dataDir, 'memory.jsonl'), 'utf8')
      assert.ok(log.includes('"state":"open"'), '未闭合回合应留在 ④')
      assert.equal(log.includes('"state":"closed"'), false)
    } finally {
      drv.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('append / delete / pin / edit：写自有存储并可读回', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const appended = await drv.call('append', {
      entries: [
        { id: 'm-1', text: 'one', meta: { source: 'consolidate', workspace: 'w-1', at: AT, tags: [] } },
        { id: 'm-2', text: 'two', meta: { source: 'consolidate', at: AT, tags: [] } },
      ],
    })
    assert.equal(appended.value.ok, true)
    assert.deepEqual(appended.value.added, ['m-1', 'm-2'])

    await drv.call('delete', { ids: ['m-1'], at: AT })
    const afterDelete = await drv.call('list', {})
    assert.deepEqual(afterDelete.value.entries.map((entry) => entry.id), ['m-2'])
    assert.equal((await drv.call('read', { hash: 'm-1' })).value.entry, null)

    await drv.call('pin', { id: 'm-2' })
    // 置顶不改链上条目，只改 body.pinned；read 仍可读。
    assert.equal((await drv.call('read', { hash: 'm-2' })).value.entry.text, 'two')

    const edited = await drv.call('edit', { id: 'm-2', text: 'two-edited' })
    assert.equal(edited.value.ok, true)
    assert.equal((await drv.call('read', { hash: 'm-2' })).value.entry.text, 'two-edited')
    const ready = await waitReady(drv, { query_vector: testVector('two-edited'), top_k: 5 })
    assert.equal(ready.value.hits[0].entry_hash, 'm-2')
  } finally {
    drv.close()
  }
})

test('形态非法 / 维度不符 / 未知方法 / 未知能力类 → 结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call('put', { text: '' })).code, 'bad_args')
    assert.equal((await drv.call('read', {})).code, 'bad_args')
    assert.equal((await drv.call('read', { hash: 'a', hashes: ['b'] })).code, 'bad_args')
    assert.equal((await drv.call('append', {})).code, 'bad_args')
    const dim = await drv.call('search', { query_vector: [1, 0] })
    assert.equal(dim.value.ok, false)
    assert.equal(dim.value.error.code, 'dim_mismatch')
    assert.equal(
      (await drv.request('call', { port: 'memory', method: 'nope', args: {} }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'read', args: {} }, 'error')).code,
      'unresolved_cap',
    )
  } finally {
    drv.close()
  }
})

test('向量化后端不可用 → put 明确失败、不半写', async () => {
  const drv = startService({
    bridge: () => ({ error: 'embedding_unavailable', message: 'down' }),
  })
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha' })
    assert.equal(put.value.ok, false)
    assert.equal(put.value.error.code, 'embedding_unavailable')
    assert.equal(put.value.$directives, undefined)
    assert.deepEqual((await drv.call('list', {})).value.entries, [])
  } finally {
    drv.close()
  }
})
