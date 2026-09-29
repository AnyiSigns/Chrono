// 逻辑级单元测试：纯函数与二进制索引格式（不 spawn 服务）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MinHeap } from '../execute/heap.ts'
import {
  appendRecords,
  clearIndex,
  decodeIndex,
  dot,
  encodeIndex,
  indexFilePath,
  loadIndex,
  normalize,
  saveIndex,
  topK,
} from '../execute/vector-index.ts'

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
      { key: 'm-1', chunk_index: 0, vector: [1, 0, 0] },
      { key: 'm-2', chunk_index: 1, vector: [0, 0.5, 0.5] },
    ],
  }
  const decoded = decodeIndex(encodeIndex(data))
  assert.deepEqual(decoded, data)

  const badMagic = encodeIndex(data)
  badMagic[0] = 0
  assert.equal(decodeIndex(badMagic), null)
  assert.equal(decodeIndex(encodeIndex(data).subarray(0, 10)), null)
})

test('topK：部分选择、分数降序、同分按 key / chunk 定序；只回逻辑 key', () => {
  const data = {
    modelId: 'm',
    dim: 2,
    count: 3,
    records: [
      { key: 'a', chunk_index: 0, vector: [1, 0] },
      { key: 'b', chunk_index: 0, vector: [0.5, 0.5] },
      { key: 'c', chunk_index: 0, vector: [0, 1] },
    ],
  }
  const hits = topK(data, [1, 0], 2)
  assert.deepEqual(
    hits.map((hit) => [hit.key, hit.score]),
    [
      ['a', 1],
      ['b', 0.5],
    ],
  )
  assert.equal(topK(data, [1, 0], 5).length, 3)
  assert.deepEqual(topK({ ...data, records: [] }, [1, 0], 3), [])
})

test('appendRecords：追加记录', () => {
  const data = { modelId: 'm', dim: 1, count: 0, records: [] }
  appendRecords(data, [{ key: 'x', chunk_index: 0, vector: [1] }])
  assert.equal(data.records.length, 1)
})

test('indexFilePath：本身份 ③ 下固定名', () => {
  assert.ok(indexFilePath('/s').endsWith('index.bin'))
  assert.equal(indexFilePath('/s'), join('/s', 'index.bin'))
})

test('saveIndex：原子替换（临时文件 + rename），无临时残留；loadIndex / clearIndex 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vecidx-'))
  try {
    const data = {
      modelId: 'granite-97m',
      dim: 2,
      count: 1,
      records: [{ key: 'm-1', chunk_index: 0, vector: [1, 0] }],
    }
    saveIndex(dir, data)
    assert.deepEqual(loadIndex(dir), data)
    assert.deepEqual(readdirSync(dir), ['index.bin'])

    saveIndex(dir, { ...data, count: 2 })
    assert.equal(loadIndex(dir).count, 2)
    assert.deepEqual(readdirSync(dir), ['index.bin'])

    clearIndex(dir)
    assert.equal(loadIndex(dir), null)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveIndex：机会式回收过期 .tmp，保留新鲜临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vecidx-tmp-'))
  try {
    const stale = join(dir, 'index.bin.999.0.tmp')
    const fresh = join(dir, 'index.bin.111.0.tmp')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    utimesSync(stale, old, old)
    saveIndex(dir, { modelId: 'granite-97m', dim: 2, count: 1, records: [] })
    assert.deepEqual(readdirSync(dir).sort(), ['index.bin', 'index.bin.111.0.tmp'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
