// `memory-store` 服务协议级测试：spawn `node execute/main.ts`，把反向调用桥接到确定性假向量化后端。
// 覆盖：握手 / 控制 / EOF 自退出；空库；put 计划形状与 tail 链；read 按 refs 取条目；
// search 暴力余弦与最小堆部分选择；索引重建分支；deleted 过滤；重复去重；不写链；形态非法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIM,
  defaultBridge,
  directivesOf,
  externOf,
  opsOf,
  queryVector,
  startService,
  testVector,
  waitReady,
} from './driver.mjs'

const MODEL = { id: 'granite-97m', dim: DIM }

/** 组装一份世界快照：链尾 + 条目（hash → def）。 */
function snapshot(tail, entries, overrides = {}) {
  const refs = {}
  for (const { hash, entry } of entries) refs[hash] = entry
  return {
    body: {
      tail: tail === null ? null : { def: tail },
      count: entries.length,
      deleted: {},
      pinned: {},
      model: MODEL,
      ...overrides,
    },
    refs,
  }
}

test('hello 回 manifest；reload/probe/drain；EOF 自退出', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'memory-store')
    assert.deepEqual(manifest.implements, ['memory'])
    assert.deepEqual(manifest.methods.memory, ['put', 'read', 'search'])
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

test('空库：read 回 null；search 重建后就绪且命中为空', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const read = await drv.call('read', { body: {}, refs: {}, hash: 'h-none' })
    assert.equal(read.kind, 'result')
    assert.equal(read.value.entry, null)

    const first = await drv.call('search', { query_vector: testVector('x'), body: {}, refs: {} })
    assert.equal(first.value.status, 'index_building')
    const ready = await waitReady(drv, { query_vector: testVector('x'), body: {}, refs: {} })
    assert.deepEqual(ready.value.hits, [])
    assert.equal(ready.value.model.id, 'granite-97m')
  } finally {
    drv.close()
  }
})

test('put：计划形状 = 条目 def + 新 body（tail 指向新条目）+ add_gen；链式 prev', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const first = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    assert.equal(first.kind, 'result')
    const ops1 = opsOf(first.value)
    assert.deepEqual(ops1.map((op) => op.op), ['put', 'put', 'add_gen'])
    const entryA = ops1[0].args.body
    assert.equal(entryA.text, 'alpha')
    assert.equal(entryA.meta.source, 'manual')
    assert.equal(entryA.prev, null)
    assert.equal(entryA.chunks.length, 1)
    assert.equal(typeof entryA.chunks[0].start, 'number')
    assert.equal(entryA.chunks[0].text, undefined)
    const bodyA = ops1[1].args.body
    assert.deepEqual(bodyA.tail, { def: { $n: 0 } })
    assert.equal(bodyA.count, 1)
    assert.deepEqual(ops1[2].args, { id: 'memory-store', payload: { $n: 1 }, sig: { $n: 1 }, pins: {} })
    assert.equal(externOf(first.value).saved, true)
    assert.equal(externOf(first.value).dedup, 'vector')

    const snap = snapshot('hA', [{ hash: 'hA', entry: entryA }])
    const second = await drv.call('put', { text: 'beta', body: snap.body, refs: snap.refs })
    const ops2 = opsOf(second.value)
    const entryB = ops2[0].args.body
    assert.equal(entryB.prev.def, 'hA')
    assert.equal(ops2[1].args.body.count, 2)
    assert.deepEqual(ops2[1].args.body.tail, { def: { $n: 0 } })
  } finally {
    drv.close()
  }
})

test('read：按传入 refs 取条目；hash / hashes 两形；缺失计入 missing', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    const entryA = opsOf(put.value)[0].args.body
    const snap = snapshot('hA', [{ hash: 'hA', entry: entryA }])

    const single = await drv.call('read', { body: snap.body, refs: snap.refs, hash: 'hA' })
    assert.equal(single.value.hash, 'hA')
    assert.equal(single.value.entry.text, 'alpha')

    const batch = await drv.call('read', { body: snap.body, refs: snap.refs, hashes: ['hA', 'h-missing'] })
    assert.equal(batch.value.entries[0].entry.text, 'alpha')
    assert.equal(batch.value.entries[1].entry, null)
    assert.deepEqual(batch.value.missing, ['h-missing'])
  } finally {
    drv.close()
  }
})

test('search：暴力余弦确定、最小堆 top-k 部分选择', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const putA = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    const entryA = opsOf(putA.value)[0].args.body
    const snapA = snapshot('hA', [{ hash: 'hA', entry: entryA }])
    const putB = await drv.call('put', { text: 'beta', body: snapA.body, refs: snapA.refs })
    const entryB = opsOf(putB.value)[0].args.body
    const snap = snapshot('hB', [
      { hash: 'hA', entry: entryA },
      { hash: 'hB', entry: entryB },
    ])

    const exact = await drv.call('search', {
      query_vector: testVector('alpha'),
      top_k: 2,
      body: snap.body,
      refs: snap.refs,
    })
    assert.equal(exact.value.status, 'ready')
    assert.equal(exact.value.hits[0].entry_hash, 'hA')
    assert.equal(exact.value.hits[0].score, 1)
    assert.equal(exact.value.hits[0].chunk_index, 0)
    assert.equal(exact.value.hits[1].entry_hash, 'hB')

    const weighted = queryVector({ alpha: 1, beta: 0.5 })
    const top1 = await drv.call('search', {
      query_vector: weighted,
      top_k: 1,
      body: snap.body,
      refs: snap.refs,
    })
    assert.equal(top1.value.hits.length, 1)
    assert.equal(top1.value.hits[0].entry_hash, 'hA')

    const top2 = await drv.call('search', {
      query_vector: weighted,
      top_k: 2,
      body: snap.body,
      refs: snap.refs,
    })
    assert.deepEqual(
      top2.value.hits.map((hit) => [hit.entry_hash, hit.score]),
      [
        ['hA', 1],
        ['hB', 0.5],
      ],
    )
  } finally {
    drv.close()
  }
})

test('search：索引缺失 → 先回「索引构建中」，重建后同结果（可重算）', async () => {
  const build = startService()
  let entryA
  let entryB
  try {
    await build.hello()
    const putA = await build.call('put', { text: 'alpha', body: {}, refs: {} })
    entryA = opsOf(putA.value)[0].args.body
    const snapA = snapshot('hA', [{ hash: 'hA', entry: entryA }])
    const putB = await build.call('put', { text: 'beta', body: snapA.body, refs: snapA.refs })
    entryB = opsOf(putB.value)[0].args.body
  } finally {
    build.close()
    await build.exit
  }

  const drv = startService()
  try {
    await drv.hello()
    const snap = snapshot('hB', [
      { hash: 'hA', entry: entryA },
      { hash: 'hB', entry: entryB },
    ])
    const args = { query_vector: testVector('alpha'), top_k: 2, body: snap.body, refs: snap.refs }
    const first = await drv.call('search', args)
    assert.equal(first.value.status, 'index_building')
    const ready = await waitReady(drv, args)
    assert.equal(ready.value.hits[0].entry_hash, 'hA')
    assert.equal(ready.value.hits[0].score, 1)

    // 强制重建：同输入同输出（force 只发一次，随后轮询不带 force，否则每次轮询都会再触发一次重建）
    const firstForced = await drv.call('search', { ...args, rebuild: true })
    assert.equal(firstForced.value.status, 'index_building')
    const forced = await waitReady(drv, args)
    assert.deepEqual(forced.value.hits, ready.value.hits)
  } finally {
    drv.close()
  }
})

test('deleted 过滤：read 与 search 均按 body.deleted 过滤', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const putA = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    const entryA = opsOf(putA.value)[0].args.body
    const snap = snapshot('hA', [{ hash: 'hA', entry: entryA }])
    const deleted = snapshot('hA', [{ hash: 'hA', entry: entryA }], {
      deleted: { [entryA.id]: '2020-01-01T00:00:00.000Z' },
    })

    const read = await drv.call('read', { body: deleted.body, refs: deleted.refs, hash: 'hA' })
    assert.equal(read.value.entry, null)

    const args = { query_vector: testVector('alpha'), top_k: 5, body: deleted.body, refs: deleted.refs }
    const ready = await waitReady(drv, args)
    assert.deepEqual(ready.value.hits, [])

    // 未删除时仍可命中（同一服务，索引未变）
    const live = await drv.call('search', {
      query_vector: testVector('alpha'),
      top_k: 5,
      body: snap.body,
      refs: snap.refs,
    })
    assert.equal(live.value.hits[0].entry_hash, 'hA')
  } finally {
    drv.close()
  }
})

test('put 去重：同文本同 at ⇒ 重复，只回 extern（不产写计划）', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const first = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    const entryA = opsOf(first.value)[0].args.body
    const snap = snapshot('hA', [{ hash: 'hA', entry: entryA }])

    const again = await drv.call('put', { text: 'alpha', body: snap.body, refs: snap.refs })
    const payload = externOf(again.value)
    assert.equal(payload.saved, false)
    assert.equal(payload.duplicate, true)
    assert.equal(payload.duplicate_of.entry_hash, 'hA')
    assert.deepEqual(directivesOf(again.value).map((item) => item.kind), ['extern'])
    assert.equal(opsOf(again.value).length, 0)
  } finally {
    drv.close()
  }
})

test('不写链：服务只回 result / port.call，绝不发 write / put / commit', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    assert.ok(directivesOf(put.value).some((item) => item.kind === 'write'))
    assert.equal(
      drv.frames.some((frame) => ['write', 'put', 'commit', 'batch'].includes(frame.kind)),
      false,
    )
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'chunk'))
    assert.ok(drv.portCalls.some((call) => call.port === 'embedding' && call.method === 'embed'))
  } finally {
    drv.close()
  }
})

test('形态非法 / 维度不符 / 未知方法 / 未知能力类 → 结构化错误', async () => {
  const drv = startService()
  try {
    await drv.hello()
    assert.equal((await drv.call('put', { text: '', body: {}, refs: {} })).code, 'bad_args')
    assert.equal((await drv.call('put', { text: 'x' })).code, 'bad_args')
    assert.equal((await drv.call('read', { body: {}, refs: {} })).code, 'bad_args')
    assert.equal(
      (await drv.call('read', { body: {}, refs: {}, hash: 'a', hashes: ['b'] })).code,
      'bad_args',
    )
    const dim = await drv.call('search', { query_vector: [1, 0], body: {}, refs: {} })
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

/** 手工条目 def（不 spawn 服务即可组装快照，用于制造索引落后）。 */
function makeEntry(id, text, prev = null) {
  return {
    id,
    text,
    meta: { source: 'manual', at: '2020-01-01T00:00:00.000Z', tags: [] },
    chunks: [{ index: 0, start: 0, end: [...text].length }],
    prev: prev === null ? null : { def: prev },
  }
}

test('索引重建竞态：后台旧重建不覆盖 put 已追加的索引，且陈旧在途构建不被 put 复用', async () => {
  let releaseAlphaEmbed
  const alphaGate = new Promise((resolveGate) => {
    releaseAlphaEmbed = resolveGate
  })
  // 只卡住「仅 alpha」的重建（旧快照 S1）；新快照 / 新条目照常立即完成。
  const bridge = (port, method, args) => {
    if (port === 'embedding' && method === 'embed') {
      const texts = Array.isArray(args?.texts) ? args.texts : []
      if (texts.length === 1 && texts[0] === 'alpha') {
        return alphaGate.then(() => defaultBridge(port, method, args))
      }
    }
    return Promise.resolve(defaultBridge(port, method, args))
  }

  const entryA = makeEntry('m-a', 'alpha')
  const entryB = makeEntry('m-b', 'beta', 'hA')
  const snapA = snapshot('hA', [{ hash: 'hA', entry: entryA }])
  const snapB = snapshot('hB', [
    { hash: 'hA', entry: entryA },
    { hash: 'hB', entry: entryB },
  ])

  const drv = startService({ bridge })
  try {
    await drv.hello()
    // 后台重建 P 基于旧快照 S1（count=1），embed 被卡住 → 在途
    const first = await drv.call('search', {
      query_vector: testVector('alpha'),
      top_k: 5,
      body: snapA.body,
      refs: snapA.refs,
    })
    assert.equal(first.value.status, 'index_building')

    // put 用新快照 S2（count=2）：不得复用 count=1 的在途构建
    const putPromise = drv.call('put', { text: 'gamma', body: snapB.body, refs: snapB.refs })
    releaseAlphaEmbed()
    const putC = await putPromise
    assert.equal(externOf(putC.value).saved, true)

    // 放行后的旧重建（count=1）不得覆盖已含 beta 的索引
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    const ready = await waitReady(drv, {
      query_vector: testVector('beta'),
      top_k: 5,
      body: snapB.body,
      refs: snapB.refs,
    })
    const hashes = ready.value.hits.map((hit) => hit.entry_hash)
    assert.ok(hashes.includes('hB'), `索引不应永久缺 beta 条目：${JSON.stringify(ready.value.hits)}`)
    assert.ok(hashes.includes('hA'))
  } finally {
    drv.close()
  }
})

test('索引计数超前（未落账 put）不掩盖世界追加：records 未覆盖 body 链即强制重建', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const putA = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    const entryA = opsOf(putA.value)[0].args.body
    const snapA = snapshot('hA', [{ hash: 'hA', entry: entryA }])
    const readyA = await waitReady(drv, {
      query_vector: testVector('alpha'),
      top_k: 5,
      body: snapA.body,
      refs: snapA.refs,
    })
    assert.equal(readyA.value.hits[0].entry_hash, 'hA')

    // 两次未落账 put：index.count 被抬到 3，而 body 仍 count=1
    await drv.call('put', { text: 'beta', body: snapA.body, refs: snapA.refs })
    await drv.call('put', { text: 'gamma', body: snapA.body, refs: snapA.refs })

    // 世界另有写者追加 delta（body count=2，链 alpha → delta）；未落账 put 的条目不在链上
    const entryD = makeEntry('m-d', 'delta', 'hA')
    const snapD = snapshot('hD', [
      { hash: 'hA', entry: entryA },
      { hash: 'hD', entry: entryD },
    ])
    const args = { query_vector: testVector('delta'), top_k: 5, body: snapD.body, refs: snapD.refs }
    const first = await drv.call('search', args)
    // 计数超前但 records 不覆盖 delta → 触发重建（先回「索引构建中」）
    assert.equal(first.value.status, 'index_building')
    const rebuilt = await waitReady(drv, args)
    assert.equal(rebuilt.value.hits[0].entry_hash, 'hD')
  } finally {
    drv.close()
  }
})

test('向量化后端不可用 → put 明确失败、不半写（无写计划）', async () => {
  const drv = startService({
    bridge: () => ({ error: 'embedding_unavailable', message: 'down' }),
  })
  try {
    await drv.hello()
    const put = await drv.call('put', { text: 'alpha', body: {}, refs: {} })
    assert.equal(put.value.ok, false)
    assert.equal(put.value.error.code, 'embedding_unavailable')
    assert.equal(put.value.$directives, undefined)
  } finally {
    drv.close()
  }
})
