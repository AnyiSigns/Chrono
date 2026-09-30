// 能力类 `vector-index` 的方法表：upsert / remove / search / info / clear。
// 索引本体是 ③ 可重算件：由调用方经 upsert 灌入并落本身份 ③ 目录；
// 本服务只持有记录（逻辑 key + chunk_index + 向量），不读投影、无反向调用、无写通道，只回逻辑 key。
// - upsert：按 key 覆盖（先删同 key 旧记录再追加，保持插入序）+ 覆写版本计数；锚（model/dim）变即重建；
// - remove：删若干 key 的记录；- search：暴力余弦最小堆 top-k；- info：当前索引描述（含记录）；
// - clear：清空索引（删除 ③ 文件，回到空索引）。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { appendRecords, clearIndex, loadIndex, normalize, saveIndex, topK } from './vector-index.ts'
import type { Handler, HandlerResult, Json, Rec } from 'plugin-sdk'
import type { IndexData, IndexRecord } from './vector-index.ts'

const DEFAULT_TOP_K = 10

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

/** 非空字符串；否则结构化拒。 */
function nonEmptyString(value: Json | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new BadArgsError(`${field} must be a non-empty string`)
  return value
}

/** 正整数；否则结构化拒。 */
function positiveInteger(value: Json | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadArgsError(`${field} must be a positive integer`)
  }
  return value
}

/** 非负整数；否则结构化拒。 */
function nonNegativeInteger(value: Json | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadArgsError(`${field} must be a non-negative integer`)
  }
  return value
}

/** 入参记录：{key, chunk_index, vector}；vector 全有限数、非空。dim 校验由 upsert 统一做。 */
function parseRecords(value: Json | undefined): IndexRecord[] {
  if (!Array.isArray(value)) throw new BadArgsError('records must be an array')
  const out: IndexRecord[] = []
  for (const item of value) {
    if (!isRecord(item)) throw new BadArgsError('records must contain objects')
    const key = nonEmptyString(item['key'], 'record.key')
    const chunkIndex = nonNegativeInteger(item['chunk_index'], 'record.chunk_index')
    const raw = item['vector']
    if (!Array.isArray(raw) || raw.length === 0)
      throw new BadArgsError('record.vector must be a non-empty array')
    const vector: number[] = []
    for (const value of raw) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadArgsError('record.vector must contain finite numbers')
      }
      vector.push(value)
    }
    out.push({ key, chunk_index: chunkIndex, vector })
  }
  return out
}

/** 查询向量：全有限数、非空。 */
function parseQueryVector(value: Json | undefined): number[] {
  if (!Array.isArray(value)) throw new BadArgsError('query_vector must be an array')
  const out: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new BadArgsError('query_vector must contain finite numbers')
    }
    out.push(item)
  }
  if (out.length === 0) throw new BadArgsError('query_vector must not be empty')
  return out
}

/** 按 key 覆盖记录：先删同 key 旧记录再追加，保持插入序。 */
function replaceKeys(data: IndexData, records: IndexRecord[]): void {
  const keys = new Set(records.map((record) => record.key))
  if (keys.size > 0) data.records = data.records.filter((record) => !keys.has(record.key))
  appendRecords(data, records)
}

/** 构造方法表；`stateDir` 是本身份 ③ 目录（null = 只驻内存）。 */
export function createHandlers(stateDir: string | null = null): Record<string, Handler> {
  const state: { data: IndexData | null } = { data: loadIndex(stateDir) }

  function upsert(args: Json): Json {
    const parsed = requireRecord(args)
    const model = nonEmptyString(parsed['model'], 'model')
    const dim = positiveInteger(parsed['dim'], 'dim')
    const count = nonNegativeInteger(parsed['count'], 'count')
    const records = parseRecords(parsed['records'])
    for (const record of records) {
      if (record.vector.length !== dim) {
        throw new BadArgsError(`record.vector dim ${record.vector.length} != ${dim}`)
      }
    }
    let data = state.data
    if (data === null || data.modelId !== model || data.dim !== dim) {
      data = { modelId: model, dim, count, records: [] }
    }
    replaceKeys(
      data,
      records.map((record) => ({
        key: record.key,
        chunk_index: record.chunk_index,
        vector: normalize(record.vector),
      })),
    )
    data.count = count
    state.data = data
    saveIndex(stateDir, data)
    return { ok: true, present: true, model, dim, count, size: data.records.length }
  }

  function remove(args: Json): Json {
    const parsed = requireRecord(args)
    const rawKeys = parsed['keys']
    if (!Array.isArray(rawKeys)) throw new BadArgsError('keys must be an array')
    const keys = new Set<string>()
    for (const item of rawKeys) {
      if (typeof item !== 'string' || item.length === 0)
        throw new BadArgsError('keys must contain non-empty strings')
      keys.add(item)
    }
    if (state.data === null || keys.size === 0) {
      return { ok: true, removed: 0, size: state.data?.records.length ?? 0 }
    }
    const before = state.data.records.length
    state.data.records = state.data.records.filter((record) => !keys.has(record.key))
    saveIndex(stateDir, state.data)
    return {
      ok: true,
      removed: before - state.data.records.length,
      size: state.data.records.length,
    }
  }

  function search(args: Json): Json {
    const parsed = requireRecord(args)
    const query = parseQueryVector(parsed['query_vector'])
    const rawTopK = parsed['top_k']
    let topKValue = DEFAULT_TOP_K
    if (rawTopK !== undefined && rawTopK !== null) {
      if (typeof rawTopK !== 'number' || !Number.isInteger(rawTopK) || rawTopK < 1) {
        throw new BadArgsError('top_k must be a positive integer')
      }
      topKValue = rawTopK
    }
    if (state.data === null) return { ok: true, hits: [] }
    return { ok: true, hits: topK(state.data, query, topKValue) }
  }

  function info(): Json {
    if (state.data === null) return { ok: true, present: false, records: [] }
    return {
      ok: true,
      present: true,
      model: state.data.modelId,
      dim: state.data.dim,
      count: state.data.count,
      size: state.data.records.length,
      records: state.data.records.map((record) => ({
        key: record.key,
        chunk_index: record.chunk_index,
        vector: [...record.vector],
      })),
    }
  }

  function clear(): Json {
    state.data = null
    clearIndex(stateDir)
    return { ok: true }
  }

  return {
    upsert: (args: Json): HandlerResult => ({ value: upsert(args), events: [] }),
    remove: (args: Json): HandlerResult => ({ value: remove(args), events: [] }),
    search: (args: Json): HandlerResult => ({ value: search(args), events: [] }),
    info: (): HandlerResult => ({ value: info(), events: [] }),
    clear: (): HandlerResult => ({ value: clear(), events: [] }),
  }
}
