// 逻辑级单元测试：纯函数与二进制索引格式（不 spawn 服务）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MinHeap } from '../execute/heap.ts'
import {
  appendRecords,
  decodeIndex,
  dot,
  encodeIndex,
  indexFilePath,
  loadIndex,
  normalize,
  saveIndex,
  topK,
} from '../execute/vector-index.ts'
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

test('MinHeap：按比较器弹出堆顶（最小）', () => {
  const heap = new MinHeap((a, b) => a - b)
  for (const value of [5, 1, 3, 2, 4]) heap.push(value)
  assert.equal(heap.size, 5)
  const out = []
  while (heap.size > 0) out.push(heap.pop())
  assert.deepEqual(out, [1, 2, 3, 4, 5])
})

test('normalize / dot：L2 归一后点积即余弦；零向量不产生 NaN', () => {
  const unit = normalize([3, 4])
  assert.deepEqual(unit, [0.6, 0.8])
  assert.equal(dot(unit, unit), 1)
  assert.deepEqual(normalize([0, 0]), [0, 0])
  assert.equal(dot([1, 2], [3, 4, 5]), 11)
})

test('二进制索引：编解码往返；坏 magic / 长度不符回 null', () => {
  const data = {
    modelId: 'granite-97m',
    dim: 3,
    count: 2,
    records: [
      { entryId: 'm-1', chunkIndex: 0, vector: [1, 0, 0] },
      { entryId: 'm-2', chunkIndex: 1, vector: [0, 0.5, 0.5] },
    ],
  }
  const decoded = decodeIndex(encodeIndex(data))
  assert.deepEqual(decoded, data)

  const badMagic = encodeIndex(data)
  badMagic[0] = 0
  assert.equal(decodeIndex(badMagic), null)
  assert.equal(decodeIndex(encodeIndex(data).subarray(0, 10)), null)
})

test('topK：部分选择、分数降序、同分按 hash/chunk 定序、allow 过滤', () => {
  const data = {
    modelId: 'm',
    dim: 2,
    count: 3,
    records: [
      { entryId: 'a', chunkIndex: 0, vector: [1, 0] },
      { entryId: 'b', chunkIndex: 0, vector: [0.5, 0.5] },
      { entryId: 'c', chunkIndex: 0, vector: [0, 1] },
    ],
  }
  const resolve = (id) => ({ a: 'hA', b: 'hB', c: 'hC' })[id] ?? null
  const hits = topK(data, [1, 0], 2, resolve)
  assert.deepEqual(
    hits.map((hit) => [hit.entry_hash, hit.score]),
    [
      ['hA', 1],
      ['hB', 0.5],
    ],
  )
  assert.deepEqual(topK(data, [1, 0], 3, () => null), [])
  assert.equal(topK(data, [1, 0], 5, resolve).length, 3)
})

test('二进制索引：appendRecords 追加', () => {
  const data = { modelId: 'm', dim: 1, count: 0, records: [] }
  appendRecords(data, [{ entryId: 'x', chunkIndex: 0, vector: [1] }])
  assert.equal(data.records.length, 1)
})

test('indexFilePath：model / dim 进文件名且净化非法字符', () => {
  assert.ok(indexFilePath('/s', 'granite-97m', 384).endsWith('index-granite-97m-384.bin'))
  assert.ok(indexFilePath('/s', 'a/b:c', 2).endsWith('index-a_b_c-2.bin'))
})

test('saveIndex：原子替换（临时文件 + rename），无临时残留；loadIndex 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msidx-'))
  try {
    const data = {
      modelId: 'granite-97m',
      dim: 2,
      count: 1,
      records: [{ entryId: 'm-1', chunkIndex: 0, vector: [1, 0] }],
    }
    saveIndex(dir, data)
    assert.deepEqual(loadIndex(dir, 'granite-97m', 2), data)
    assert.deepEqual(readdirSync(dir), ['index-granite-97m-2.bin'])

    // 覆盖写：替换旧文件，仍无 .tmp 残留
    saveIndex(dir, { ...data, count: 2 })
    assert.equal(loadIndex(dir, 'granite-97m', 2).count, 2)
    assert.deepEqual(readdirSync(dir), ['index-granite-97m-2.bin'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveIndex：机会式回收过期 .tmp，保留新鲜临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msidx-tmp-'))
  try {
    const stale = join(dir, 'index-granite-97m-2.bin.999.0.tmp')
    const fresh = join(dir, 'index-granite-97m-2.bin.111.0.tmp')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(stale, old, old)
    saveIndex(dir, { modelId: 'granite-97m', dim: 2, count: 1, records: [] })
    assert.deepEqual(readdirSync(dir).sort(), [
      'index-granite-97m-2.bin',
      'index-granite-97m-2.bin.111.0.tmp',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store：链式遍历从新到旧、环即停；deleted 过滤；id 解析', () => {
  const entryA = { id: 'm-a', text: 'a', prev: null }
  const entryB = { id: 'm-b', text: 'b', prev: { def: 'hA' } }
  const entryC = { id: 'm-c', text: 'c', prev: { def: 'hB' } }
  const refs = { hA: entryA, hB: entryB, hC: entryC }
  const body = { tail: { def: 'hC' }, count: 3, deleted: { 'm-b': 'at' } }

  const chain = linkedEntries(body, refs)
  assert.deepEqual(chain.map((item) => item.hash), ['hC', 'hB', 'hA'])
  assert.equal(isDeleted(body, entryB), true)
  assert.deepEqual([...liveIdToHash(body, refs).entries()], [
    ['m-c', 'hC'],
    ['m-a', 'hA'],
  ])

  const cyclic = { tail: { def: 'hB' }, count: 2, deleted: {} }
  const cycRefs = { hA: { id: 'm-a', prev: { def: 'hB' } }, hB: { id: 'm-b', prev: { def: 'hA' } } }
  assert.deepEqual(linkedEntries(cyclic, cycRefs).map((item) => item.hash), ['hB', 'hA'])
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

  const body = buildBody({ body: { count: 2, deleted: { x: 'at' }, pinned: { y: true } }, tailId: 'm-9', count: 3, anchor: { id: 'm', dim: 2 } })
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
