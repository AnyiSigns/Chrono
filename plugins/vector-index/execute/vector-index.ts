// ③ 向量索引本体：二进制文件编解码、原子写与 stale GC、L2 归一、点积、最小堆 top-k 部分选择。
// 位置：`CHRONO_PLUGIN_STATE/index.bin`（本身份目录，可重算、可统一 GC；env 缺失则只驻内存）。
// 记录 = {key, chunk_index, vector}：key 是消费方给的**逻辑键**（如条目 id），本服务不解析条目哈希，
// 只回 key；条目 → 哈希的映射由消费方完成。

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { MinHeap } from './heap.ts'

const MAGIC = Buffer.from('VECIDX01', 'ascii')
const VERSION = 1
/** 逻辑键在记录里的定长字节数（超长截断；消费方键通常是短 id）。 */
const KEY_BYTES = 32

/** 进程内写序号：与 pid 一起防同一目标文件的临时名相撞。 */
let writeSeq = 0

/** 崩溃残留的临时文件视为过期的阈值：活跃写者的临时文件不会存活这么久。 */
const STALE_TEMP_MS = 60 * 60 * 1000

/** 机会式回收：清理同目录中本模块遗留的过期临时文件，避免崩溃残留的 `.tmp` 堆积。 */
function sweepStaleTemps(dir: string, prefix: string): void {
  try {
    const cutoff = Date.now() - STALE_TEMP_MS
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch {
        // 单文件 stat / 删除失败不影响本次写入
      }
    }
  } catch {
    // 目录不可读：跳过回收
  }
}

export interface IndexRecord {
  key: string
  chunk_index: number
  vector: number[]
}

export interface IndexData {
  modelId: string
  dim: number
  /** 消费方给的版本计数（如世界条目计数）：由消费方在 upsert 时写入，本服务只存不解释。 */
  count: number
  records: IndexRecord[]
}

/** chunk 级命中（对外形状：key + chunk_index + score）。 */
export interface Hit {
  key: string
  chunk_index: number
  score: number
}

/** ③ 目录：宿主起服务时以 `CHRONO_PLUGIN_STATE` 注入本身份路径；未注入则索引只驻内存。 */
export function resolveStateDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dir = env['CHRONO_PLUGIN_STATE']
  return typeof dir === 'string' && dir.length > 0 ? dir : null
}

/** 索引文件路径（本身份 ③ 下固定名；model / dim 在文件头，换锚即重建）。 */
export function indexFilePath(stateDir: string): string {
  return join(stateDir, 'index.bin')
}

/** L2 归一；零向量原样返回零向量（不产生 NaN）。 */
export function normalize(vector: number[]): number[] {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return vector.map(() => 0)
  return vector.map((value) => value / norm)
}

/** 点积（dim 已 L2 归一 ⇒ 即余弦）。 */
export function dot(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index++) sum += left[index] * right[index]
  return sum
}

/** 编码为二进制（小端）：magic / version / dim / count / modelId / recordCount / records。 */
export function encodeIndex(data: IndexData): Buffer {
  const model = Buffer.from(data.modelId, 'utf8')
  const header = 8 + 4 + 4 + 4 + 4 + model.length + 4
  const recordBytes = KEY_BYTES + 4 + data.dim * 4
  const buffer = Buffer.allocUnsafe(header + data.records.length * recordBytes)
  let offset = 0
  MAGIC.copy(buffer, offset)
  offset += MAGIC.length
  buffer.writeUInt32LE(VERSION, offset)
  offset += 4
  buffer.writeUInt32LE(data.dim, offset)
  offset += 4
  buffer.writeUInt32LE(data.count, offset)
  offset += 4
  buffer.writeUInt32LE(model.length, offset)
  offset += 4
  model.copy(buffer, offset)
  offset += model.length
  buffer.writeUInt32LE(data.records.length, offset)
  offset += 4
  for (const record of data.records) {
    const keyBytes = Buffer.from(record.key, 'utf8')
    keyBytes.copy(buffer, offset, 0, Math.min(keyBytes.length, KEY_BYTES))
    offset += KEY_BYTES
    buffer.writeUInt32LE(record.chunk_index, offset)
    offset += 4
    for (let index = 0; index < data.dim; index++) {
      buffer.writeFloatLE(record.vector[index] ?? 0, offset)
      offset += 4
    }
  }
  return buffer
}

/** 解码二进制；magic / version / 长度不符即回 null（视为缺失，触发重建）。 */
export function decodeIndex(buffer: Buffer): IndexData | null {
  if (buffer.length < 8 + 4 + 4 + 4 + 4 + 4) return null
  if (!buffer.subarray(0, 8).equals(MAGIC)) return null
  let offset = 8
  if (buffer.readUInt32LE(offset) !== VERSION) return null
  offset += 4
  const dim = buffer.readUInt32LE(offset)
  offset += 4
  const count = buffer.readUInt32LE(offset)
  offset += 4
  const modelLength = buffer.readUInt32LE(offset)
  offset += 4
  if (dim <= 0 || offset + modelLength > buffer.length) return null
  const modelId = buffer.subarray(offset, offset + modelLength).toString('utf8')
  offset += modelLength
  if (offset + 4 > buffer.length) return null
  const recordCount = buffer.readUInt32LE(offset)
  offset += 4
  const recordBytes = KEY_BYTES + 4 + dim * 4
  if (offset + recordCount * recordBytes !== buffer.length) return null
  const records: IndexRecord[] = []
  for (let index = 0; index < recordCount; index++) {
    const keyBytes = buffer.subarray(offset, offset + KEY_BYTES)
    offset += KEY_BYTES
    const end = keyBytes.indexOf(0)
    const key = keyBytes.subarray(0, end === -1 ? keyBytes.length : end).toString('utf8')
    const chunkIndex = buffer.readUInt32LE(offset)
    offset += 4
    const vector: number[] = []
    for (let position = 0; position < dim; position++) {
      vector.push(buffer.readFloatLE(offset))
      offset += 4
    }
    records.push({ key, chunk_index: chunkIndex, vector })
  }
  return { modelId, dim, count, records }
}

/** 读索引文件；缺失 / 损坏均回 null（视为缺失，触发重建）。 */
export function loadIndex(stateDir: string | null): IndexData | null {
  if (stateDir === null) return null
  try {
    return decodeIndex(readFileSync(indexFilePath(stateDir)))
  } catch {
    return null
  }
}

/**
 * 原子写索引文件：先写同目录临时文件，再 `rename` 替换（同目录内原子），避免读到半截文件。
 * 无 ③ 目录（未注入 env）时静默跳过，索引只驻内存；失败不致命（可重算，下次重建重试）。
 */
export function saveIndex(stateDir: string | null, data: IndexData): void {
  if (stateDir === null) return
  const target = indexFilePath(stateDir)
  const temp = `${target}.${process.pid}.${writeSeq++}.tmp`
  try {
    mkdirSync(stateDir, { recursive: true })
    sweepStaleTemps(stateDir, `${basename(target)}.`)
    writeFileSync(temp, encodeIndex(data))
    renameSync(temp, target)
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // 临时文件可能尚未创建或已被 rename 消费：忽略
    }
  }
}

/** 删除索引文件（③ 可重算，clear 即回到空索引）；缺失 / 删除失败均忽略。 */
export function clearIndex(stateDir: string | null): void {
  if (stateDir === null) return
  try {
    unlinkSync(indexFilePath(stateDir))
  } catch {
    // 文件不存在或不可删：忽略（空索引即等价结果）
  }
}

/** 追加记录（增量 append）。 */
export function appendRecords(data: IndexData, records: IndexRecord[]): void {
  for (const record of records) data.records.push(record)
}

/** 命中排序：score 降序，同分按 key、chunk_index 升序（确定）。 */
function rankCompare(left: Hit, right: Hit): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.key !== right.key) return left.key < right.key ? -1 : 1
  return left.chunk_index - right.chunk_index
}

/** 暴力余弦 top-k：用大小为 k 的最小堆做部分选择 O(N·log k)；返回逻辑 key，不解析哈希。 */
export function topK(data: IndexData, query: number[], k: number): Hit[] {
  const heap = new MinHeap<Hit>((left, right) => rankCompare(right, left))
  for (const record of data.records) {
    const hit: Hit = {
      key: record.key,
      chunk_index: record.chunk_index,
      score: dot(query, record.vector),
    }
    if (heap.size < k) {
      heap.push(hit)
      continue
    }
    const worst = heap.peek()
    if (worst !== undefined && rankCompare(hit, worst) < 0) {
      heap.pop()
      heap.push(hit)
    }
  }
  return heap.toArray().sort(rankCompare)
}
