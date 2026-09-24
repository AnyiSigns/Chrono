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

interface BuildTask {
  promise: Promise<IndexData>
  /** 构建所用 body 的条目数：兑现时据此判断是否落后于当前内存索引。 */
  count: number
  /** 是否由 force 发起：force 调用不得复用未 force 的在途构建。 */
  force: boolean
  /** 由覆盖判据失败发起：兑现时允许覆盖「计数超前」的内存索引（否则世界追加被永久掩盖）。 */
  authoritative: boolean
}

interface IndexState {
  data: IndexData | null
  building: BuildTask | null
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
 * body 链上的存活条目（有非空文本者）是否都被索引 `records` 覆盖。
 * 未落账 put 会把 `index.count` 抬到超过 `body.count`；此时若世界另有写者追加条目，
 * 单看计数会误判「不落后」，故用覆盖判据兜底：链上条目在 records 中缺席即索引与 body 链不一致。
 */
function indexCoversBody(index: IndexData, body: Rec, refs: Rec): boolean {
  const covered = new Set(index.records.map((record) => record.entryId))
  for (const { entry } of linkedEntries(body, refs)) {
    if (isDeleted(body, entry)) continue
    const id = entryIdOf(entry)
    if (id === null) continue
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
    if (text.length === 0) continue
    if (!covered.has(id)) return false
  }
  return true
}

/**
 * 取索引：就绪且未落后即回内存索引；否则按 `block` 决定等待重建或立即回 null（「索引构建中」）。
 * 落后判据 = `index.count < body.count`；计数相等即就绪（保留「未落账 put 超前不回退」语义）。
 * 计数超前（未落账 put 抬高）时再核验 `records` 是否覆盖 body 链：覆盖则沿用，不覆盖即强制重建，
 * 否则世界追加会被超前计数永久掩盖。
 * 在途构建仅当覆盖目标 body 且（非 force 调用或本身为 force）时复用；force 不得复用未 force 的在途构建。
 * 构建兑现只在「不落后于当前内存索引」时覆盖：put 已就地追加 / 换代的索引不被旧构建回退。
 */
async function ensureIndex(
  state: IndexState,
  deps: MemoryDeps,
  body: Rec,
  refs: Rec,
  options: EnsureOptions,
): Promise<IndexData | null> {
  const targetCount = countOf(body)
  let coverageFailed = false
  if (!options.force && state.data !== null) {
    if (state.data.count === targetCount) return state.data
    if (state.data.count > targetCount) {
      if (indexCoversBody(state.data, body, refs)) return state.data
      coverageFailed = true
    }
  }

  // 覆盖失败视同 force：不得复用基于旧 body 的在途构建，必须按当前 body 重建。
  const mustRebuild = options.force || coverageFailed
  const inFlight = state.building
  const reusable =
    inFlight !== null && inFlight.count >= targetCount && (!mustRebuild || inFlight.force)
  if (reusable) return options.block ? inFlight.promise : null

  const promise = rebuildIndex(state, deps, body, refs)
  const task: BuildTask = { promise, count: targetCount, force: options.force, authoritative: coverageFailed }
  state.building = task
  promise.then(
    (data) => {
      const current = state.building === task
      if (current) state.building = null
      // 被更新构建取代的旧构建不覆盖；authoritative 构建可覆盖「计数超前」的索引（否则世界追加被永久掩盖）。
      if (state.data === null || data.count >= state.data.count || (current && task.authoritative)) {
        state.data = data
      }
    },
    (err: unknown) => {
      if (state.building === task) state.building = null
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
    let chunks = await deps.embedding.chunk(text)
    // 与 put 同口径：chunk 为空时兜底整段一块，保证每条有文本的存活条目都有 records（覆盖判据成立）。
    if (chunks.length === 0) chunks = [{ index: 0, start: 0, end: [...text].length, text }]
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

  // embedding 期间可能已有重建 / 追加落定：以当前内存索引为准，落后于 body 即重建后再用。
  if (state.data === null || state.data.count < countOf(ctx.body)) {
    try {
      index = await ensureIndex(state, deps, ctx.body, ctx.refs, { block: true, force: true })
    } catch (err) {
      return errorValue(toFailure(err).code, toFailure(err).message)
    }
    if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')
  } else {
    index = state.data
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

  // copy-on-write 追加：不改写共享索引对象，避免与在途重建的兑现相互覆盖。
  // count 取「索引现有计数与 body 计数」的较大者 +1：未落账 put 造成的超前不回退。
  const nextIndex: IndexData = {
    ...index,
    records: [...index.records],
    count: Math.max(index.count, countOf(ctx.body)) + 1,
  }
  appendRecords(
    nextIndex,
    chunks.map((chunk, position) => ({
      entryId: ctx.id,
      chunkIndex: chunk.index,
      vector: vectors[position],
    })),
  )
  saveIndex(state.stateDir, nextIndex)
  state.data = nextIndex

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
