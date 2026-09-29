// 逻辑级单元测试：世界数据形状的解析与派生纯函数（不 spawn 服务；索引原语测试归 `vector-index`）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBody,
  buildEntry,
  countOf,
  deriveEntryId,
  isDeleted,
  linkedEntries,
  liveIdToHash,
  parseMeta,
  parseWeight,
  tailHashOf,
} from '../execute/store.ts'

test('store：链式遍历从新到旧、环即停；deleted 过滤；id 解析', () => {
  const entryA = { id: 'm-a', text: 'a', prev: null }
  const entryB = { id: 'm-b', text: 'b', prev: { def: 'hA' } }
  const entryC = { id: 'm-c', text: 'c', prev: { def: 'hB' } }
  const refs = { hA: entryA, hB: entryB, hC: entryC }
  const body = { tail: { def: 'hC' }, count: 3, deleted: { 'm-b': 'at' } }

  const chain = linkedEntries(body, refs)
  assert.deepEqual(
    chain.map((item) => item.hash),
    ['hC', 'hB', 'hA'],
  )
  assert.equal(isDeleted(body, entryB), true)
  assert.deepEqual(
    [...liveIdToHash(body, refs).entries()],
    [
      ['m-c', 'hC'],
      ['m-a', 'hA'],
    ],
  )

  const cyclic = { tail: { def: 'hB' }, count: 2, deleted: {} }
  const cycRefs = { hA: { id: 'm-a', prev: { def: 'hB' } }, hB: { id: 'm-b', prev: { def: 'hA' } } }
  assert.deepEqual(
    linkedEntries(cyclic, cycRefs).map((item) => item.hash),
    ['hB', 'hA'],
  )
})

test('store：buildEntry / buildBody / deriveEntryId / meta / weight', () => {
  const entry = buildEntry({
    id: 'm-1',
    text: 'hello',
    meta: { source: 'manual', at: 'now', tags: [] },
    weight: 0.5,
    chunks: [{ index: 0, start: 0, end: 5 }],
    prev: 'hPrev',
  })
  assert.deepEqual(entry.prev, { def: 'hPrev' })
  assert.equal(entry.weight, 0.5)
  assert.deepEqual(entry.chunks, [{ index: 0, start: 0, end: 5 }])

  const body = buildBody({
    body: { count: 2, deleted: { x: 'at' }, pinned: { y: true } },
    tailId: 'm-9',
    count: 3,
    anchor: { id: 'm', dim: 2 },
  })
  assert.deepEqual(body.tail, { def: 'm-9' })
  assert.equal(body.count, 3)
  assert.deepEqual(body.deleted, { x: 'at' })
  assert.deepEqual(body.pinned, { y: true })
  assert.deepEqual(body.model, { id: 'm', dim: 2 })
  assert.equal(countOf(body), 3)
  assert.equal(tailHashOf({ tail: null }), null)

  assert.equal(deriveEntryId('x', 'at'), deriveEntryId('x', 'at'))
  assert.notEqual(deriveEntryId('x', 'at'), deriveEntryId('y', 'at'))

  const meta = parseMeta({ meta: { source: 'consolidate', workspace: 'w', tags: ['t'] } }, 0)
  assert.equal(meta.source, 'consolidate')
  assert.equal(meta.workspace, 'w')
  assert.equal(meta.at, new Date(0).toISOString())
  assert.throws(() => parseMeta({ meta: { source: 'nope' } }, 0))
  assert.equal(parseWeight(undefined), undefined)
  assert.equal(parseWeight(0.2), 0.2)
  assert.throws(() => parseWeight(2))
})
