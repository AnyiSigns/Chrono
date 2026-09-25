// storage-sql 服务协议级测试（node --test）：自实现最小协议驱动，spawn `node execute/main.ts`。
// 覆盖包形状、握手、方法级读写往返、按 emitter 分库隔离、并发写事务、启动迁移幂等、丢弃命名空间。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PKG_ROOT, startService } from './driver.mjs'

function tempData() {
  return mkdtempSync(join(tmpdir(), 'storage-sql-'))
}

async function withService(dataDir, fn) {
  const drv = startService({ dataDir })
  try {
    return await fn(drv)
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
      assert.equal(manifest.identity, 'storage-sql')
      assert.deepEqual(manifest.implements, ['storage-sql'])
      assert.deepEqual(manifest.methods['storage-sql'], [
        'createTable',
        'query',
        'write',
        'batch',
        'listTables',
        'info',
        'dropNamespace',
      ])
      assert.equal(manifest.protocol, '1')
      assert.equal(manifest.state, 'durable')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('方法级读写往返：createTable → write → query', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const created = assertOk(
        await drv.call(
          'createTable',
          {
            name: 'notes',
            columns: [
              { name: 'id', type: 'INTEGER', primaryKey: true },
              { name: 'body', type: 'TEXT', notNull: true },
            ],
          },
          'owner-a',
        ),
      )
      assert.deepEqual(created, { table: 'notes' })

      const written = assertOk(
        await drv.call('write', { sql: 'INSERT INTO notes (id, body) VALUES (?, ?)', params: [1, 'hello'] }, 'owner-a'),
      )
      assert.equal(written.changes, 1)
      assert.equal(written.lastInsertRowid, 1)

      const queried = assertOk(
        await drv.call('query', { sql: 'SELECT id, body FROM notes ORDER BY id' }, 'owner-a'),
      )
      assert.deepEqual(queried.rows, [{ id: 1, body: 'hello' }])

      const listed = assertOk(await drv.call('listTables', {}, 'owner-a'))
      assert.deepEqual(listed.tables, ['notes'])
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('事务批：全有或全无，失败整批回滚', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('createTable', { name: 't', columns: [{ name: 'v', type: 'INTEGER' }] }, 'owner-b'))
      const ok = assertOk(
        await drv.call(
          'batch',
          { statements: [{ sql: 'INSERT INTO t (v) VALUES (?)', params: [1] }, { sql: 'INSERT INTO t (v) VALUES (?)', params: [2] }] },
          'owner-b',
        ),
      )
      assert.equal(ok.count, 2)

      const failed = await drv.call(
        'batch',
        { statements: [{ sql: 'INSERT INTO t (v) VALUES (?)', params: [3] }, { sql: 'INSERT INTO missing (v) VALUES (?)', params: [4] }] },
        'owner-b',
      )
      assert.equal(failed.kind, 'error')
      assert.equal(failed.code, 'bad_sql')

      const rows = assertOk(await drv.call('query', { sql: 'SELECT v FROM t ORDER BY v' }, 'owner-b'))
      assert.deepEqual(rows.rows, [{ v: 1 }, { v: 2 }])
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('按 emitter 分库：A 写的 B 读不到', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('createTable', { name: 'private', columns: [{ name: 'v', type: 'TEXT' }] }, 'owner-a'))
      assertOk(await drv.call('write', { sql: 'INSERT INTO private (v) VALUES (?)', params: ['a-only'] }, 'owner-a'))

      const bTables = assertOk(await drv.call('listTables', {}, 'owner-b'))
      assert.deepEqual(bTables.tables, [])
      const bQuery = await drv.call('query', { sql: 'SELECT v FROM private' }, 'owner-b')
      assert.equal(bQuery.kind, 'error')
      assert.equal(bQuery.code, 'bad_sql')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('拒绝调用方自报 namespace / owner 参数', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      for (const key of ['namespace', 'owner', 'db', 'emitter']) {
        const message = await drv.call(
          'createTable',
          { name: 'x', columns: [{ name: 'v', type: 'TEXT' }], [key]: 'forged' },
          'owner-a',
        )
        assert.equal(message.kind, 'error', key)
        assert.equal(message.code, 'bad_args', key)
      }
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('载荷上限：超 256 KiB 拒 payload_too_large（大字节走资产）', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('createTable', { name: 'big', columns: [{ name: 'v', type: 'TEXT' }] }, 'owner-a'))
      const huge = 'x'.repeat(300 * 1024)
      const message = await drv.call('write', { sql: 'INSERT INTO big (v) VALUES (?)', params: [huge] }, 'owner-a')
      assert.equal(message.kind, 'error')
      assert.equal(message.code, 'payload_too_large')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('并发写事务：两实例同库同 owner 各写 5 行都成功（WAL + busy_timeout）', async () => {
  const dataDir = tempData()
  const a = startService({ dataDir })
  const b = startService({ dataDir })
  try {
    assertOk(await a.call('createTable', { name: 'c', columns: [{ name: 'v', type: 'INTEGER' }] }, 'owner-c'))
    const insert = (n) => ({
      statements: Array.from({ length: 5 }, (_, i) => ({ sql: 'INSERT INTO c (v) VALUES (?)', params: [n * 10 + i] })),
    })
    const [ra, rb] = await Promise.all([
      a.call('batch', insert(1), 'owner-c'),
      b.call('batch', insert(2), 'owner-c'),
    ])
    assert.equal(ra.kind, 'result', JSON.stringify(ra))
    assert.equal(rb.kind, 'result', JSON.stringify(rb))
    const rows = assertOk(await a.call('query', { sql: 'SELECT COUNT(*) AS n FROM c' }, 'owner-c'))
    assert.equal(rows.rows[0].n, 10)
  } finally {
    a.close()
    b.close()
    await Promise.all([a.exit, b.exit])
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('启动迁移幂等：重启后 schemaVersion 不变、内部表不重复、数据保留', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('createTable', { name: 'keep', columns: [{ name: 'v', type: 'TEXT' }] }, 'owner-d'))
      assertOk(await drv.call('write', { sql: 'INSERT INTO keep (v) VALUES (?)', params: ['persisted'] }, 'owner-d'))
      const info = assertOk(await drv.call('info', {}, 'owner-d'))
      assert.equal(info.schemaVersion, 1)
    })
    await withService(dataDir, async (drv) => {
      const info = assertOk(await drv.call('info', {}, 'owner-d'))
      assert.equal(info.schemaVersion, 1)
      assert.deepEqual(info.tables, ['keep'])
      const meta = assertOk(await drv.call('query', { sql: 'SELECT COUNT(*) AS n FROM _chrono_meta' }, 'owner-d'))
      assert.equal(meta.rows[0].n, 1)
      const rows = assertOk(await drv.call('query', { sql: 'SELECT v FROM keep' }, 'owner-d'))
      assert.deepEqual(rows.rows, [{ v: 'persisted' }])
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('丢弃命名空间：dropNamespace 清净本 owner 全部表，别家不受影响', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('createTable', { name: 'gone', columns: [{ name: 'v', type: 'TEXT' }] }, 'owner-e'))
      assertOk(await drv.call('write', { sql: 'INSERT INTO gone (v) VALUES (?)', params: ['x'] }, 'owner-e'))
      assertOk(await drv.call('createTable', { name: 'stay', columns: [{ name: 'v', type: 'TEXT' }] }, 'owner-f'))

      const dropped = assertOk(await drv.call('dropNamespace', {}, 'owner-e'))
      assert.equal(dropped.dropped, 1)

      const eTables = assertOk(await drv.call('listTables', {}, 'owner-e'))
      assert.deepEqual(eTables.tables, [])
      const eQuery = await drv.call('query', { sql: 'SELECT v FROM gone' }, 'owner-e')
      assert.equal(eQuery.code, 'bad_sql')

      const fTables = assertOk(await drv.call('listTables', {}, 'owner-f'))
      assert.deepEqual(fTables.tables, ['stay'])
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json 与 execute/ 均在包内（PKG_ROOT 自检）', () => {
  assert.ok(PKG_ROOT.endsWith('storage-sql'))
})
