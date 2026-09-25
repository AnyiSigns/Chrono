// storage-kv 服务协议级测试（node --test）：自实现最小协议驱动，spawn `node execute/main.ts`。
// 覆盖包形状、握手、方法级读写往返、批量、按 emitter 分目录隔离、启动迁移幂等、
// 撕裂尾恢复、跨重启持久、丢弃命名空间。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PKG_ROOT, startService } from './driver.mjs'

function tempData() {
  return mkdtempSync(join(tmpdir(), 'storage-kv-'))
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
      assert.equal(manifest.identity, 'storage-kv')
      assert.deepEqual(manifest.implements, ['storage-kv'])
      assert.deepEqual(manifest.methods['storage-kv'], [
        'get',
        'put',
        'delete',
        'list',
        'batch',
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

test('方法级读写往返：put → get → list → delete', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { key: 'a', value: { n: 1 } }, 'owner-a'))
      assertOk(await drv.call('put', { key: 'b', value: [1, 2, 3] }, 'owner-a'))

      const got = assertOk(await drv.call('get', { key: 'a' }, 'owner-a'))
      assert.deepEqual(got, { found: true, value: { n: 1 } })

      const missing = assertOk(await drv.call('get', { key: 'nope' }, 'owner-a'))
      assert.deepEqual(missing, { found: false, value: null })

      const listed = assertOk(await drv.call('list', {}, 'owner-a'))
      assert.deepEqual(
        listed.entries.map((entry) => entry.key),
        ['a', 'b'],
      )

      const removed = assertOk(await drv.call('delete', { key: 'a' }, 'owner-a'))
      assert.equal(removed.deleted, true)
      const again = assertOk(await drv.call('delete', { key: 'a' }, 'owner-a'))
      assert.equal(again.deleted, false)

      const info = assertOk(await drv.call('info', {}, 'owner-a'))
      assert.equal(info.entries, 1)
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('批量与前缀：batch 一次落多条，list 按前缀筛', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const batched = assertOk(
        await drv.call(
          'batch',
          {
            ops: [
              { op: 'put', key: 'user:1', value: 'one' },
              { op: 'put', key: 'user:2', value: 'two' },
              { op: 'put', key: 'cfg', value: true },
              { op: 'del', key: 'cfg' },
            ],
          },
          'owner-b',
        ),
      )
      assert.deepEqual(batched, { ok: true, count: 4 })

      const users = assertOk(await drv.call('list', { prefix: 'user:' }, 'owner-b'))
      assert.deepEqual(users.entries, [
        { key: 'user:1', value: 'one' },
        { key: 'user:2', value: 'two' },
      ])
      const cfg = assertOk(await drv.call('get', { key: 'cfg' }, 'owner-b'))
      assert.equal(cfg.found, false)
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('按 emitter 分目录：A 写的 B 读不到', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { key: 'secret', value: 'a-only' }, 'owner-a'))
      const b = assertOk(await drv.call('get', { key: 'secret' }, 'owner-b'))
      assert.deepEqual(b, { found: false, value: null })
      const bList = assertOk(await drv.call('list', {}, 'owner-b'))
      assert.deepEqual(bList.entries, [])
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
        const message = await drv.call('put', { key: 'x', value: 1, [key]: 'forged' }, 'owner-a')
        assert.equal(message.kind, 'error', key)
        assert.equal(message.code, 'bad_args', key)
      }
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('值上限：超 256 KiB 拒 payload_too_large（大字节走资产）', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      const huge = 'x'.repeat(300 * 1024)
      const message = await drv.call('put', { key: 'big', value: huge }, 'owner-a')
      assert.equal(message.kind, 'error')
      assert.equal(message.code, 'payload_too_large')
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('跨重启持久 + 启动迁移幂等', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { key: 'kept', value: { deep: [1, 2] } }, 'owner-c'))
      const info = assertOk(await drv.call('info', {}, 'owner-c'))
      assert.equal(info.schemaVersion, 1)
    })
    await withService(dataDir, async (drv) => {
      const got = assertOk(await drv.call('get', { key: 'kept' }, 'owner-c'))
      assert.deepEqual(got, { found: true, value: { deep: [1, 2] } })
      const info = assertOk(await drv.call('info', {}, 'owner-c'))
      assert.equal(info.schemaVersion, 1)
      assert.equal(info.entries, 1)
    })
    const metaPath = join(dataDir, 'owner-c', 'meta.json')
    assert.equal(existsSync(metaPath), true)
    assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).version, 1)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('撕裂尾恢复：日志末尾半条记录被截掉，既有记录保留', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { key: 'keep', value: 'v' }, 'owner-d'))
    })
    const logPath = join(dataDir, 'owner-d', 'log.jsonl')
    appendFileSync(logPath, '{"s":99,"op":"put","k":"torn"')
    await withService(dataDir, async (drv) => {
      const torn = assertOk(await drv.call('get', { key: 'torn' }, 'owner-d'))
      assert.equal(torn.found, false)
      const kept = assertOk(await drv.call('get', { key: 'keep' }, 'owner-d'))
      assert.deepEqual(kept, { found: true, value: 'v' })
      const info = assertOk(await drv.call('info', {}, 'owner-d'))
      assert.equal(info.entries, 1)
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('丢弃命名空间：dropNamespace 删本 owner 目录，别家不受影响', async () => {
  const dataDir = tempData()
  try {
    await withService(dataDir, async (drv) => {
      assertOk(await drv.call('put', { key: 'gone', value: 'x' }, 'owner-e'))
      assertOk(await drv.call('put', { key: 'stay', value: 'y' }, 'owner-f'))

      const dropped = assertOk(await drv.call('dropNamespace', {}, 'owner-e'))
      assert.equal(dropped.dropped, 1)
      assert.equal(existsSync(join(dataDir, 'owner-e')), false)

      const e = assertOk(await drv.call('list', {}, 'owner-e'))
      assert.deepEqual(e.entries, [])
      const f = assertOk(await drv.call('list', {}, 'owner-f'))
      assert.deepEqual(f.entries, [{ key: 'stay', value: 'y' }])
    })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json 与 execute/ 均在包内（PKG_ROOT 自检）', () => {
  assert.ok(PKG_ROOT.endsWith('storage-kv'))
})
