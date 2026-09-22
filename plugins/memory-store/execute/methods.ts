// 能力类 `memory` 的方法表：put / read / search。
// put：去重后返回写计划（条目 def → 新 body → add_gen），不直接写链；read：按传入 refs 取条目；
// search：在 ③ 索引上暴力余弦 top-k（最小堆部分选择），索引缺失 / 落后即异步全量重建。
// 服务不读投影、不自取时钟、不落账；body + refs 由调用方入口 term 读出随 args 传入。

import { log } from './frames.ts'
import {
  addGenOp,
  asString,
  asStringList,
  errorValue,
  externOnly,
  integerField,
  isRecord,
  nowOf,
  numberField,
  planOf,
  putOp,
} from './plan.ts'
import { IDENTITY } from './plugin.ts'
import {
  asBody,
  asRefs,
  buildBody,
  buildEntry,
  countOf,
  deriveEntryId,
  entryIdOf,
  isDeleted,
  linkedEntries,
  liveIdToHash,
  parseMeta,
  parseWeight,
  tailHashOf,
} from './store.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import { appendRecords, loadIndex, normalize, resolveStateDir, saveIndex, topK } from './vector-index.ts'
import type { IndexData, IndexRecord } from './vector-index.ts'
import type { EmbeddingBackend } from './port-link.ts'

const DEFAULT_TOP_K = 10
const DEFAULT_DEDUP_THRESHOLD = 0.95

/** 后端注入：生产环境是反向调用 `embedding.*`，单测注入假后端。 */
export interface MemoryDeps {
  embedding: EmbeddingBackend
}

interface IndexState {
  data: IndexData | null
  building: Promise<IndexData> | null
  modelId: string
  dim: number
  stateDir: string | null
}

interface PutContext {
  text: string
  meta: Rec
  weight: number | undefined
  id: string
  threshold: number
  body: Rec
  refs: Rec
}

interface EnsureOptions {
  block: boolean
  force: boolean
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  if (err instanceof BadArgsError) return { code: 'bad_args', message: err.message }
  return { code: 'internal', message: err instanceof Error ? err.message : 'index rebuild failed' }
}

function modelJson(state: IndexState): Rec {
  return { id: state.modelId, dim: state.dim }
}

/**
 * 取索引：就绪且未落后即回内存索引；否则按 `block` 决定等待重建或立即回 null（「索引构建中」）。
 * 落后判据 = `index.count < body.count`（其它写者直接加条目时触发重建；未落账的 put 造成的超前不回退）。
 */
async function ensureIndex(
  state: IndexState,
  deps: MemoryDeps,
  body: Rec,
  refs: Rec,
  options: EnsureOptions,
): Promise<IndexData | null> {
  const stale = state.data !== null && state.data.count < countOf(body)
  if (!options.force && state.data !== null && !stale) return state.data
  if (options.force) state.data = null
  if (state.building !== null) {
    return options.block ? state.building : null
  }
  const promise = rebuildIndex(state, deps, body, refs)
  state.building = promise
  promise.then(
    (data) => {
      state.data = data
      state.building = null
    },
    (err: unknown) => {
      state.building = null
      log(`index rebuild failed: ${toFailure(err).code} ${toFailure(err).message}`)
    },
  )
  return options.block ? promise : null
}

/** 全量重建：世界条目（链序）→ 向量化服务 `chunk` + `embed` → 记录；结果确定、可重算。 */
async function rebuildIndex(state: IndexState, deps: MemoryDeps, body: Rec, refs: Rec): Promise<IndexData> {
  const entries = linkedEntries(body, refs).filter(({ entry }) => !isDeleted(body, entry))
  const texts: string[] = []
  const meta: Array<{ entryId: string; chunkIndex: number }> = []
  for (const { entry } of entries) {
    const id = entryIdOf(entry)
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
    if (id === null || text.length === 0) continue
    const chunks = await deps.embedding.chunk(text)
    for (const chunk of chunks) {
      texts.push(chunk.text)
      meta.push({ entryId: id, chunkIndex: chunk.index })
    }
  }
  let vectors: number[][] = []
  if (texts.length > 0) {
    const result = await deps.embedding.embed(texts, state.modelId)
    if (result.dim !== state.dim) {
      throw new BackendError('dim_mismatch', `embedding dim ${result.dim} != ${state.dim}`)
    }
    vectors = result.vectors
  }
  const records: IndexRecord[] = meta.map((item, index) => ({
    entryId: item.entryId,
    chunkIndex: item.chunkIndex,
    vector: normalize(vectors[index] ?? []),
  }))
  const data: IndexData = { modelId: state.modelId, dim: state.dim, count: countOf(body), records }
  saveIndex(state.stateDir, data)
  return data
}

/** 去重：新条目各 chunk 向量与存活条目记录的最大余弦；≥ 阈值即判重。 */
function findDuplicate(
  index: IndexData,
  vectors: number[][],
  resolve: (entryId: string) => string | null,
  threshold: number,
): Rec | null {
  let best: { entry_hash: string; chunk_index: number; score: number } | null = null
  for (const record of index.records) {
    const entryHash = resolve(record.entryId)
    if (entryHash === null) continue
    for (const vector of vectors) {
      let score = 0
      for (let position = 0; position < vector.length; position++) {
        score += vector[position] * (record.vector[position] ?? 0)
      }
      if (best === null || score > best.score) {
        best = { entry_hash: entryHash, chunk_index: record.chunkIndex, score }
      }
    }
  }
  if (best === null || best.score < threshold) return null
  return best
}

function parsePutArgs(args: Json, env: CallEnv): PutContext {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const text = asString(args['text'])
  if (text === null) throw new BadArgsError('text must be a non-empty string')
  const body = asBody(args['body'])
  const refs = asRefs(args['refs'])
  const meta = parseMeta(args, nowOf(env, args))
  const weight = parseWeight(args['weight'])
  const at = typeof meta['at'] === 'string' ? (meta['at'] as string) : ''
  const id = asString(args['id']) ?? deriveEntryId(text, at)
  const threshold = numberField(
    args['dedup_threshold'],
    'dedup_threshold',
    DEFAULT_DEDUP_THRESHOLD,
    0,
    1,
  )
  return { text, meta, weight, id, threshold, body, refs }
}

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

/** 从传入 refs 取条目；缺失或已按 `body.deleted` 逻辑删除均回 null。 */
function readOne(body: Rec, refs: Rec, hash: string): Json {
  const entry = refs[hash]
  if (!isRecord(entry)) return null
  if (isDeleted(body, entry)) return null
  return entry
}

/** agent 显式保存入口：去重后回写计划；重复则只回 extern（不产写）。 */
async function put(args: Json, env: CallEnv, deps: MemoryDeps, state: IndexState): Promise<Json> {
  const ctx = parsePutArgs(args, env)
  let index: IndexData | null
  try {
    index = await ensureIndex(state, deps, ctx.body, ctx.refs, { block: true, force: false })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')

  let chunks: Array<{ index: number; start: number; end: number; text: string }>
  let vectors: number[][]
  try {
    chunks = await deps.embedding.chunk(ctx.text)
    if (chunks.length === 0) {
      chunks = [{ index: 0, start: 0, end: [...ctx.text].length, text: ctx.text }]
    }
    const result = await deps.embedding.embed(chunks.map((chunk) => chunk.text), state.modelId)
    if (result.dim !== state.dim) {
      return errorValue('dim_mismatch', `embedding dim ${result.dim} != ${state.dim}`)
    }
    vectors = result.vectors.map(normalize)
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }

  const live = liveIdToHash(ctx.body, ctx.refs)
  const duplicate = findDuplicate(index, vectors, (id) => live.get(id) ?? null, ctx.threshold)
  if (duplicate !== null) {
    return externOnly({
      ok: true,
      kind: 'put',
      saved: false,
      duplicate: true,
      dedup: 'vector',
      duplicate_of: duplicate,
    })
  }

  appendRecords(
    index,
    chunks.map((chunk, position) => ({
      entryId: ctx.id,
      chunkIndex: chunk.index,
      vector: vectors[position],
    })),
  )
  index.count = countOf(ctx.body) + 1
  saveIndex(state.stateDir, index)

  const entry = buildEntry({
    id: ctx.id,
    text: ctx.text,
    meta: ctx.meta,
    weight: ctx.weight,
    chunks,
    prev: tailHashOf(ctx.body),
  })
  const newBody = buildBody({ body: ctx.body, entryIndex: 0, anchor: { id: state.modelId, dim: state.dim } })
  const ops = [putOp(entry), putOp(newBody), addGenOp(IDENTITY, 1)]
  return planOf(ops, {
    ok: true,
    kind: 'put',
    saved: true,
    id: ctx.id,
    count: countOf(ctx.body) + 1,
    chunks: chunks.length,
    dedup: 'vector',
    model: modelJson(state),
  })
}

/** 按 hash / hashes 从传入 refs 取条目（消费方 = 检索插件；服务不读投影）。 */
async function read(args: Json): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const body = asBody(args['body'])
  const refs = asRefs(args['refs'])
  const hash = asString(args['hash'])
  const hashes =
    args['hashes'] === undefined || args['hashes'] === null ? null : asStringList(args['hashes'], 'hashes')
  if (hash !== null && hashes !== null) throw new BadArgsError('hash and hashes are mutually exclusive')
  if (hash === null && hashes === null) throw new BadArgsError('hash or hashes is required')
  if (hash !== null) {
    return { ok: true, kind: 'read', hash, entry: readOne(body, refs, hash) }
  }
  const entries = (hashes as string[]).map((item) => ({ hash: item, entry: readOne(body, refs, item) }))
  const missing = entries.filter((item) => item.entry === null).map((item) => item.hash)
  return { ok: true, kind: 'read', entries, missing }
}

/** 在 ③ 索引上暴力余弦 top-k；未就绪即回「索引构建中」，不静默阻塞。 */
async function search(args: Json, deps: MemoryDeps, state: IndexState): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const body = asBody(args['body'])
  const refs = asRefs(args['refs'])
  const query = parseQueryVector(args['query_vector'])
  if (query.length !== state.dim) {
    return errorValue('dim_mismatch', `query_vector dim ${query.length} != ${state.dim}`)
  }
  const topKValue = integerField(args['top_k'], 'top_k', DEFAULT_TOP_K, 1)
  const force = args['rebuild'] === true
  const data = await ensureIndex(state, deps, body, refs, { block: false, force })
  if (data === null) {
    return { ok: true, kind: 'search', status: 'index_building', model: modelJson(state), hits: [] }
  }
  const live = liveIdToHash(body, refs)
  const hits = topK(data, query, topKValue, (id) => live.get(id) ?? null)
  return { ok: true, kind: 'search', status: 'ready', model: modelJson(state), hits }
}

/** 构造方法表（依赖注入：向量化后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: MemoryDeps, anchor: { id: string; dim: number }): Record<string, Handler> {
  const stateDir = resolveStateDir()
  const state: IndexState = {
    data: loadIndex(stateDir, anchor.id, anchor.dim),
    building: null,
    modelId: anchor.id,
    dim: anchor.dim,
    stateDir,
  }
  return {
    put: (args: Json, env: CallEnv): Promise<Json> => put(args, env, deps, state),
    read: (args: Json): Promise<Json> => read(args),
    search: (args: Json): Promise<Json> => search(args, deps, state),
  }
}
