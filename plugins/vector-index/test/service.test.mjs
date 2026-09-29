// `vector-index` 服务协议级测试：spawn `node execute/main.ts`，按能力类调用。
// 覆盖：握手 / 控制 / EOF 自退出；upsert（按 key 覆盖 + 归一）/ search / info / remove / clear；
// ③ 持久化跨重启；无 ③ 目录只驻内存；形态非法结构化拒；无反向调用、无写通道。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const PORT = 'vector-index'
const ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

function drive(stateDir) {
  const env = stateDir === undefined ? {} : { CHRONO_PLUGIN_STATE: stateDir }
  const drv = startService({ entry: ENTRY, cwd: PKG_ROOT, env })
  return {
    ...drv,
    hello: () => drv.hello('vector-index'),
    call: (method, args, env2 = ENV) => drv.call(PORT, method, args, env2),
  }
}

const RECORDS = [
  { key: 'm-a', chunk_index: 0, vector: [1, 0, 0] },
  { key: 'm-b', chunk_index: 0, vector: [0.5, 0.5, 0] },
]

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = drive()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'vector-index')
    assert.deepEqual(manifest.implements, ['vector-index'])
    assert.deepEqual(manifest.methods[PORT], ['upsert', 'remove', 'search', 'info', 'clear'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
  assert.equal(await drv.exit, 0)
})

test('upsert / search / info / remove / clear：只回逻辑 key、向量写入时归一', async () => {
  const drv = drive()
  try {
    await drv.hello()
    const empty = await drv.call('info', {})
    assert.equal(empty.value.present, false)
    assert.deepEqual(empty.value.records, [])

    const up = await drv.call('upsert', {
      model: 'granite-97m',
      dim: 3,
      count: 2,
      records: RECORDS,
    })
    assert.equal(up.value.ok, true)
    assert.equal(up.value.model, 'granite-97m')
    assert.equal(up.value.dim, 3)
    assert.equal(up.value.count, 2)
    assert.equal(up.value.size, 2)

    const info = await drv.call('info', {})
    assert.equal(info.value.present, true)
    assert.equal(info.value.size, 2)
    assert.deepEqual(info.value.records[1].vector, [1 / Math.SQRT2, 1 / Math.SQRT2, 0])

    const hits = await drv.call('search', { query_vector: [1, 0, 0], top_k: 2 })
    assert.deepEqual(
      hits.value.hits.map((hit) => [hit.key, hit.score]),
      [
        ['m-a', 1],
        ['m-b', 1 / Math.SQRT2],
      ],
    )

    const removed = await drv.call('remove', { keys: ['m-a'] })
    assert.equal(removed.value.removed, 1)
    assert.equal(removed.value.size, 1)
    assert.deepEqual(
      (await drv.call('search', { query_vector: [1, 0, 0] })).value.hits.map((h) => h.key),
      ['m-b'],
    )

    const cleared = await drv.call('clear', {})
    assert.equal(cleared.value.ok, true)
    assert.equal((await drv.call('info', {})).value.present, false)
    assert.deepEqual((await drv.call('search', { query_vector: [1, 0, 0] })).value.hits, [])
  } finally {
    drv.close()
  }
})

test('upsert 按 key 覆盖：同 key 旧记录先删再追加，保持插入序', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await drv.call('upsert', {
      model: 'm',
      dim: 2,
      count: 1,
      records: [{ key: 'a', chunk_index: 0, vector: [1, 0] }],
    })
    await drv.call('upsert', {
      model: 'm',
      dim: 2,
      count: 1,
      records: [{ key: 'b', chunk_index: 0, vector: [0, 1] }],
    })
    await drv.call('upsert', {
      model: 'm',
      dim: 2,
      count: 2,
      records: [
        { key: 'a', chunk_index: 0, vector: [0, 1] },
        { key: 'a', chunk_index: 1, vector: [1, 0] },
      ],
    })
    const info = await drv.call('info', {})
    assert.deepEqual(
      info.value.records.map((r) => [r.key, r.chunk_index]),
      [
        ['b', 0],
        ['a', 0],
        ['a', 1],
      ],
    )
  } finally {
    drv.close()
  }
})

test('③ 持久化：同 ③ 目录重启后索引仍在（loadIndex 往返）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'vecidx-state-'))
  try {
    const first = drive(stateDir)
    try {
      await first.hello()
      await first.call('upsert', { model: 'granite-97m', dim: 3, count: 2, records: RECORDS })
    } finally {
      first.close()
      await first.exit
    }
    const second = drive(stateDir)
    try {
      await second.hello()
      const info = await second.call('info', {})
      assert.equal(info.value.present, true)
      assert.equal(info.value.count, 2)
      assert.deepEqual(
        (await second.call('search', { query_vector: [1, 0, 0], top_k: 2 })).value.hits.map(
          (h) => h.key,
        ),
        ['m-a', 'm-b'],
      )
    } finally {
      second.close()
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('无 ③ 目录：只驻内存，仍可 upsert / search', async () => {
  const drv = drive()
  try {
    await drv.hello()
    await drv.call('upsert', {
      model: 'm',
      dim: 2,
      count: 1,
      records: [{ key: 'a', chunk_index: 0, vector: [1, 0] }],
    })
    assert.deepEqual(
      (await drv.call('search', { query_vector: [1, 0] })).value.hits.map((h) => h.key),
      ['a'],
    )
  } finally {
    drv.close()
  }
})

test('形态非法 / 未知方法 / 未知能力类 → 结构化错误', async () => {
  const drv = drive()
  try {
    await drv.hello()
    assert.equal((await drv.call('upsert', {})).code, 'bad_args')
    assert.equal(
      (
        await drv.call('upsert', {
          model: 'm',
          dim: 2,
          count: 0,
          records: [{ key: 'a', chunk_index: 0, vector: [1] }],
        })
      ).code,
      'bad_args',
    )
    assert.equal((await drv.call('remove', {})).code, 'bad_args')
    assert.equal((await drv.call('search', {})).code, 'bad_args')
    assert.equal(
      (await drv.request('call', { port: PORT, method: 'nope', args: {}, env: ENV }, 'error')).code,
      'unknown_method',
    )
    assert.equal(
      (await drv.request('call', { port: 'other', method: 'info', args: {}, env: ENV }, 'error'))
        .code,
      'unresolved_cap',
    )
    assert.equal(drv.portCalls.length, 0, '本服务不应发反向调用')
  } finally {
    drv.close()
  }
})
