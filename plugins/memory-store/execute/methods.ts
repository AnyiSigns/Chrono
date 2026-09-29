// 能力类 `memory` 的方法表：put / read / search / list / append / delete / pin / edit。
// 条目与 body 是运行记录，已出世界：住本服务自有持久存储（④），写即时落盘、读从自有存储取。
// 向量索引是 ③（可重算）——已下沉到 `vector-index` 提供方：索引读写 / top-k 经反向 `port.call vector-index.*`，
// 本服务只编排「何时建 / 何时用」，并做 key → 条目哈希映射；服务不读投影、不自取时钟。
// put 去重后直接写自有存储；read / search 只读；list / append / delete / pin / edit 供记忆维护调用。

import { log } from './log.ts'
import { errorValue, integerField, isRecord, nowOf, numberField } from './plan.ts'
import { MemoryStore } from './persist.ts'
import {
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
} from './store.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type {
  EmbeddingBackend,
  TokenizerBackend,
  VectorIndexBackend,
  VectorRecord,
  VectorIndexInfo,
} from './port-link.ts'

const DEFAULT_TOP_K = 10
const DEFAULT_DEDUP_THRESHOLD = 0.95

/** 后端注入：生产环境是反向调用 `embedding.embed` / `tokenizer.chunk` / `vector-index.*`，单测注入假后端。 */
export interface MemoryDeps {
  embedding: EmbeddingBackend
  tokenizer: TokenizerBackend
  vectorIndex: VectorIndexBackend
}

/** 索引描述（本地缓存）：锚 + 版本计数；记录本体住 `vector-index`。 */
interface IndexMeta {
  modelId: string
  dim: number
  count: number
}

interface BuildTask {
  promise: Promise<IndexMeta>
  /** 构建所用 body 的条目数：兑现时据此判断是否落后于当前缓存。 */
  count: number
  /** 是否由 force 发起：force 调用不得复用未 force 的在途构建。 */
  force: boolean
  /** 由覆盖判据失败发起：兑现时允许覆盖「计数超前」的缓存。 */
  authoritative: boolean
}

interface IndexState {
  data: IndexMeta | null
  /** 是否已从提供方读过一次索引状态（区分「未读」与「提供方为空」）。 */
  loaded: boolean
  building: BuildTask | null
  modelId: string
  dim: number
}

interface PutContext {
  text: string
  meta: Rec
  weight: number | undefined
  id: string
  threshold: number
}

interface EnsureOptions {
  block: boolean
  force: boolean
}

/** 对外命中形状（`search` 公共面：entry_hash + chunk_index + score）。 */
interface SearchHit {
  entry_hash: string
  chunk_index: number
  score: number
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  if (err instanceof BadArgsError) return { code: 'bad_args', message: err.message }
  return { code: 'internal', message: err instanceof Error ? err.message : 'index rebuild failed' }
}

function modelJson(state: IndexState): Rec {
  return { id: state.modelId, dim: state.dim }
}

/** body 链上的存活条目（有非空文本者）是否都被索引 `records` 覆盖。 */
function indexCoversBody(records: VectorRecord[], body: Rec, refs: Rec): boolean {
  const covered = new Set(records.map((record) => record.key))
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
 * 取索引描述：就绪且未落后即回缓存；否则按 `block` 决定等待重建或立即回 null（「索引构建中」）。
 * 索引状态首读经 `vector-index.info`；记录本体不在本服务，只在需要时（覆盖判据 / 去重）拉取。
 */
async function ensureIndex(
  state: IndexState,
  deps: MemoryDeps,
  body: Rec,
  refs: Rec,
  options: EnsureOptions,
): Promise<IndexMeta | null> {
  const targetCount = countOf(body)
  let coverageFailed = false
  if (!options.force) {
    if (!state.loaded) {
      const info = await deps.vectorIndex.info()
      state.loaded = true
      if (info !== null && info.modelId === state.modelId && info.dim === state.dim) {
        state.data = { modelId: info.modelId, dim: info.dim, count: info.count }
      }
    }
    if (state.data !== null) {
      if (state.data.count === targetCount) return state.data
      if (state.data.count > targetCount) {
        const info = await deps.vectorIndex.info()
        if (
          info !== null &&
          info.modelId === state.modelId &&
          info.dim === state.dim &&
          indexCoversBody(info.records, body, refs)
        ) {
          return state.data
        }
        coverageFailed = true
      }
    }
  }

  const mustRebuild = options.force || coverageFailed
  const inFlight = state.building
  const reusable =
    inFlight !== null && inFlight.count >= targetCount && (!mustRebuild || inFlight.force)
  if (reusable) return options.block ? inFlight.promise : null

  const promise = rebuildIndex(state, deps, body, refs)
  const task: BuildTask = {
    promise,
    count: targetCount,
    force: options.force,
    authoritative: coverageFailed,
  }
  state.building = task
  promise.then(
    (data) => {
      const current = state.building === task
      if (current) state.building = null
      if (
        state.data === null ||
        data.count >= state.data.count ||
        (current && task.authoritative)
      ) {
        state.data = data
      }
      state.loaded = true
    },
    (err: unknown) => {
      if (state.building === task) state.building = null
      // 重建失败（如提供方清空后写入失败）：丢弃本地描述，下次从提供方重读状态、必要时再重建。
      state.loaded = false
      state.data = null
      log(`index rebuild failed: ${toFailure(err).code} ${toFailure(err).message}`)
    },
  )
  return options.block ? promise : null
}

/** 全量重建：④ 条目（链序）→ tokenizer.chunk + embedding.embed → 清空并灌入 `vector-index`；结果确定、可重算。 */
async function rebuildIndex(
  state: IndexState,
  deps: MemoryDeps,
  body: Rec,
  refs: Rec,
): Promise<IndexMeta> {
  const entries = linkedEntries(body, refs).filter(({ entry }) => !isDeleted(body, entry))
  const texts: string[] = []
  const meta: Array<{ key: string; chunkIndex: number }> = []
  for (const { entry } of entries) {
    const id = entryIdOf(entry)
    const text = typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
    if (id === null || text.length === 0) continue
    let chunks = await deps.tokenizer.chunk(text)
    if (chunks.length === 0) chunks = [{ index: 0, start: 0, end: [...text].length, text }]
    for (const chunk of chunks) {
      texts.push(chunk.text)
      meta.push({ key: id, chunkIndex: chunk.index })
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
  const records: VectorRecord[] = meta.map((item, index) => ({
    key: item.key,
    chunk_index: item.chunkIndex,
    vector: vectors[index] ?? [],
  }))
  const count = countOf(body)
  await deps.vectorIndex.clear()
  const result = await deps.vectorIndex.upsert({
    model: state.modelId,
    dim: state.dim,
    count,
    records,
  })
  return { modelId: result.modelId, dim: result.dim, count: result.count }
}

/** 去重：新条目各 chunk 向量与存活条目记录的最大余弦；≥ 阈值即判重（与拆分前逐字节等价）。 */
function findDuplicate(
  records: VectorRecord[],
  vectors: number[][],
  resolve: (key: string) => string | null,
  threshold: number,
): SearchHit | null {
  let best: SearchHit | null = null
  for (const record of records) {
    const entryHash = resolve(record.key)
    if (entryHash === null) continue
    for (const vector of vectors) {
      let score = 0
      for (let position = 0; position < vector.length; position++) {
        score += vector[position] * (record.vector[position] ?? 0)
      }
      if (best === null || score > best.score) {
        best = { entry_hash: entryHash, chunk_index: record.chunk_index, score }
      }
    }
  }
  if (best === null || best.score < threshold) return null
  return best
}

/** 对外命中排序：score 降序，同分按 entry_hash、chunk_index 升序（确定，与拆分前一致）。 */
function rankCompare(left: SearchHit, right: SearchHit): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.entry_hash !== right.entry_hash) return left.entry_hash < right.entry_hash ? -1 : 1
  return left.chunk_index - right.chunk_index
}

function parsePutArgs(args: Json, env: CallEnv): PutContext {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const text = args['text']
  if (typeof text !== 'string' || text.length === 0)
    throw new BadArgsError('text must be a non-empty string')
  const meta = parseMeta(args, nowOf(env, args))
  const weight = parseWeight(args['weight'])
  const at = typeof meta['at'] === 'string' ? (meta['at'] as string) : ''
  const id =
    typeof args['id'] === 'string' && (args['id'] as string).length > 0
      ? (args['id'] as string)
      : deriveEntryId(text, at)
  const threshold = numberField(
    args['dedup_threshold'],
    'dedup_threshold',
    DEFAULT_DEDUP_THRESHOLD,
    0,
    1,
  )
  return { text, meta, weight, id, threshold }
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

/** 按 id 取条目；缺失或已按 `body.deleted` 逻辑删除均回 null。 */
function readOne(store: MemoryStore, id: string): Json {
  const entry = store.entryOf(id)
  if (entry === null) return null
  if (isDeleted(store.body(), entry)) return null
  return entry
}

/** 向量化一条文本：tokenizer.chunk（空则整段一块）+ embedding.embed（dim 校验）。 */
async function embedText(
  deps: MemoryDeps,
  state: IndexState,
  text: string,
): Promise<{
  chunks: Array<{ index: number; start: number; end: number; text: string }>
  vectors: number[][]
}> {
  let chunks = await deps.tokenizer.chunk(text)
  if (chunks.length === 0) chunks = [{ index: 0, start: 0, end: [...text].length, text }]
  const result = await deps.embedding.embed(
    chunks.map((chunk) => chunk.text),
    state.modelId,
  )
  if (result.dim !== state.dim) {
    throw new BackendError('dim_mismatch', `embedding dim ${result.dim} != ${state.dim}`)
  }
  return { chunks, vectors: result.vectors }
}

/** 取提供方当前记录（仅锚相符时）；不一致 / 不可用回空表（去重退化为不命中）。 */
async function currentRecords(deps: MemoryDeps, state: IndexState): Promise<VectorRecord[]> {
  const info: VectorIndexInfo | null = await deps.vectorIndex.info()
  if (info === null || info.modelId !== state.modelId || info.dim !== state.dim) return []
  return info.records
}

/** agent 显式保存入口：去重后写自有存储；重复则只回值（不写）。 */
async function put(
  args: Json,
  env: CallEnv,
  deps: MemoryDeps,
  state: IndexState,
  store: MemoryStore,
): Promise<Json> {
  const ctx = parsePutArgs(args, env)
  let index: IndexMeta | null
  try {
    index = await ensureIndex(state, deps, store.body(), store.refs(), {
      block: true,
      force: false,
    })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')

  let embedded: {
    chunks: Array<{ index: number; start: number; end: number; text: string }>
    vectors: number[][]
  }
  try {
    embedded = await embedText(deps, state, ctx.text)
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }

  if (state.data === null || state.data.count < store.count()) {
    try {
      index = await ensureIndex(state, deps, store.body(), store.refs(), {
        block: true,
        force: true,
      })
    } catch (err) {
      return errorValue(toFailure(err).code, toFailure(err).message)
    }
    if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')
  } else {
    index = state.data
  }

  let records: VectorRecord[]
  try {
    records = await currentRecords(deps, state)
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  const live = liveIdToHash(store.body(), store.refs())
  const duplicate = findDuplicate(
    records,
    embedded.vectors,
    (key) => live.get(key) ?? null,
    ctx.threshold,
  )
  if (duplicate !== null) {
    return {
      ok: true,
      kind: 'put',
      saved: false,
      duplicate: true,
      dedup: 'vector',
      duplicate_of: duplicate,
    }
  }

  const nextCount = Math.max(index.count, store.count()) + 1
  const newRecords: VectorRecord[] = embedded.chunks.map((chunk, position) => ({
    key: ctx.id,
    chunk_index: chunk.index,
    vector: embedded.vectors[position],
  }))
  try {
    await deps.vectorIndex.upsert({
      model: state.modelId,
      dim: state.dim,
      count: nextCount,
      records: newRecords,
    })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  state.data = { modelId: state.modelId, dim: state.dim, count: nextCount }

  const entry = buildEntry({
    id: ctx.id,
    text: ctx.text,
    meta: ctx.meta,
    weight: ctx.weight,
    chunks: embedded.chunks,
    prev: store.tailId(),
  })
  store.turnOpen(env.run)
  store.appendEntry(env.run, entry)
  store.setBody(
    env.run,
    buildBody({
      body: store.body(),
      tailId: ctx.id,
      count: store.count() + 1,
      anchor: store.anchorOf(),
    }),
  )
  store.turnClose(env.run)
  return {
    ok: true,
    kind: 'put',
    saved: true,
    id: ctx.id,
    count: store.count(),
    chunks: embedded.chunks.length,
    dedup: 'vector',
    model: modelJson(state),
  }
}

/** 按 id 取条目（消费方 = 检索插件 / 记忆维护；服务不读投影）。 */
async function read(args: Json, store: MemoryStore): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const hash =
    typeof args['hash'] === 'string' && (args['hash'] as string).length > 0
      ? (args['hash'] as string)
      : null
  const rawHashes = args['hashes']
  let hashes: string[] | null = null
  if (rawHashes !== undefined && rawHashes !== null) {
    if (!Array.isArray(rawHashes)) throw new BadArgsError('hashes must be an array')
    hashes = rawHashes.filter((item): item is string => typeof item === 'string')
  }
  if (hash !== null && hashes !== null)
    throw new BadArgsError('hash and hashes are mutually exclusive')
  if (hash === null && hashes === null) throw new BadArgsError('hash or hashes is required')
  if (hash !== null) {
    return { ok: true, kind: 'read', hash, entry: readOne(store, hash) }
  }
  const entries = (hashes as string[]).map((item) => ({ hash: item, entry: readOne(store, item) }))
  const missing = entries.filter((item) => item.entry === null).map((item) => item.hash)
  return { ok: true, kind: 'read', entries, missing }
}

/** 经 `vector-index` 在 ③ 索引上暴力余弦 top-k；未就绪即回「索引构建中」，不静默阻塞。 */
async function search(
  args: Json,
  deps: MemoryDeps,
  state: IndexState,
  store: MemoryStore,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const query = parseQueryVector(args['query_vector'])
  if (query.length !== state.dim) {
    return errorValue('dim_mismatch', `query_vector dim ${query.length} != ${state.dim}`)
  }
  const topKValue = integerField(args['top_k'], 'top_k', DEFAULT_TOP_K, 1)
  const force = args['rebuild'] === true
  let data: IndexMeta | null
  try {
    data = await ensureIndex(state, deps, store.body(), store.refs(), { block: false, force })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  if (data === null) {
    return { ok: true, kind: 'search', status: 'index_building', model: modelJson(state), hits: [] }
  }
  let providerHits
  try {
    providerHits = await deps.vectorIndex.search(query, topKValue)
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  const live = liveIdToHash(store.body(), store.refs())
  const hits: SearchHit[] = []
  for (const hit of providerHits) {
    const hash = live.get(hit.key)
    if (hash === undefined) continue
    hits.push({ entry_hash: hash, chunk_index: hit.chunk_index, score: hit.score })
  }
  hits.sort(rankCompare)
  return { ok: true, kind: 'search', status: 'ready', model: modelJson(state), hits }
}

/** 存活条目清单（新→旧）：供记忆维护读取与去重；`pinned` 供淘汰跳过。 */
async function list(_args: Json, store: MemoryStore): Promise<Json> {
  const entries = store.liveEntries().map((entry) => ({
    id: entryIdOf(entry),
    text: typeof entry['text'] === 'string' ? entry['text'] : '',
    meta: isRecord(entry['meta']) ? entry['meta'] : {},
    weight: typeof entry['weight'] === 'number' ? entry['weight'] : null,
  }))
  const pinned = isRecord(store.body()['pinned']) ? (store.body()['pinned'] as Rec) : {}
  return { ok: true, kind: 'list', entries, count: store.count(), pinned }
}

/** 批量追加条目（记忆维护固化用）：各自算 chunks / 向量后写自有存储并经提供方增量入索引。 */
async function append(
  args: Json,
  env: CallEnv,
  deps: MemoryDeps,
  state: IndexState,
  store: MemoryStore,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const rawEntries = args['entries']
  if (!Array.isArray(rawEntries)) throw new BadArgsError('entries must be an array')
  const added: string[] = []
  let index: IndexMeta | null
  try {
    index = await ensureIndex(state, deps, store.body(), store.refs(), {
      block: true,
      force: false,
    })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')
  const newRecords: VectorRecord[] = []
  store.turnOpen(env.run)
  for (const raw of rawEntries) {
    if (!isRecord(raw)) throw new BadArgsError('entries must contain objects')
    const text = raw['text']
    if (typeof text !== 'string' || text.length === 0)
      throw new BadArgsError('entry.text must be a non-empty string')
    const meta = isRecord(raw['meta']) ? (raw['meta'] as Rec) : parseMeta(raw, nowOf(env, args))
    const weight = parseWeight(raw['weight'])
    const at = typeof meta['at'] === 'string' ? (meta['at'] as string) : ''
    const id =
      typeof raw['id'] === 'string' && (raw['id'] as string).length > 0
        ? (raw['id'] as string)
        : deriveEntryId(text, at)
    const existing = store.entryOf(id)
    if (existing !== null && existing['text'] === text) continue
    let embedded
    try {
      embedded = await embedText(deps, state, text)
    } catch (err) {
      return errorValue(toFailure(err).code, toFailure(err).message)
    }
    const entry = buildEntry({
      id,
      text,
      meta,
      weight,
      chunks: embedded.chunks,
      prev: store.tailId(),
    })
    store.appendEntry(env.run, entry)
    store.setBody(
      env.run,
      buildBody({
        body: store.body(),
        tailId: id,
        count: store.count() + 1,
        anchor: store.anchorOf(),
      }),
    )
    for (let position = 0; position < embedded.chunks.length; position++) {
      newRecords.push({
        key: id,
        chunk_index: embedded.chunks[position].index,
        vector: embedded.vectors[position],
      })
    }
    added.push(id)
  }
  store.turnClose(env.run)
  if (added.length > 0) {
    const nextCount = Math.max(index.count, store.count())
    try {
      await deps.vectorIndex.upsert({
        model: state.modelId,
        dim: state.dim,
        count: nextCount,
        records: newRecords,
      })
    } catch (err) {
      return errorValue(toFailure(err).code, toFailure(err).message)
    }
    state.data = { modelId: state.modelId, dim: state.dim, count: nextCount }
  }
  return { ok: true, kind: 'append', added, count: store.count() }
}

/** 逻辑删除若干条目（body.deleted）；链上条目不动，读取方按 body.deleted 过滤，并同步摘除索引记录。 */
async function remove(
  args: Json,
  env: CallEnv,
  deps: MemoryDeps,
  store: MemoryStore,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const ids = args['ids']
  if (!Array.isArray(ids)) throw new BadArgsError('ids must be an array')
  const deleted = { ...(isRecord(store.body()['deleted']) ? (store.body()['deleted'] as Rec) : {}) }
  const removed: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    deleted[id] = typeof args['at'] === 'string' ? (args['at'] as string) : ''
    removed.push(id)
  }
  if (removed.length > 0) {
    store.setBody(env.run, { ...store.body(), deleted })
    try {
      await deps.vectorIndex.remove(removed)
    } catch (err) {
      // 索引摘除失败不致命：读取方按 body.deleted 过滤，结果仍正确；下次重建会收敛。
      log(`index remove failed: ${toFailure(err).code} ${toFailure(err).message}`)
    }
  }
  return { ok: true, kind: 'delete', deleted: removed }
}

/** 置顶 / 取消置顶（body.pinned）。 */
async function pin(args: Json, env: CallEnv, store: MemoryStore): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const id = args['id']
  if (typeof id !== 'string' || id.length === 0) throw new BadArgsError('id is required')
  const pinned = { ...(isRecord(store.body()['pinned']) ? (store.body()['pinned'] as Rec) : {}) }
  const on = args['pinned'] !== false
  if (on) pinned[id] = true
  else delete pinned[id]
  store.setBody(env.run, { ...store.body(), pinned })
  return { ok: true, kind: 'pin', id, pinned: on }
}

/** 文本编辑：同 id 覆盖条目（保留链位置），重算 chunks / 向量并经提供方替换索引记录。 */
async function edit(
  args: Json,
  env: CallEnv,
  deps: MemoryDeps,
  state: IndexState,
  store: MemoryStore,
): Promise<Json> {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const id = args['id']
  if (typeof id !== 'string' || id.length === 0) throw new BadArgsError('id is required')
  const text = args['text']
  if (typeof text !== 'string' || text.length === 0)
    throw new BadArgsError('text must be a non-empty string')
  const existing = store.entryOf(id)
  if (existing === null || isDeleted(store.body(), existing)) {
    return { ok: false, kind: 'edit', id, reason: 'not_found' }
  }
  let index: IndexMeta | null
  try {
    index = await ensureIndex(state, deps, store.body(), store.refs(), {
      block: true,
      force: false,
    })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  if (index === null) return errorValue('index_unavailable', 'index rebuild did not complete')
  let embedded
  try {
    embedded = await embedText(deps, state, text)
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  const prev =
    isRecord(existing['prev']) && typeof existing['prev']['def'] === 'string'
      ? (existing['prev']['def'] as string)
      : null
  const meta = isRecord(args['meta'])
    ? { ...(isRecord(existing['meta']) ? existing['meta'] : {}), ...(args['meta'] as Rec) }
    : existing['meta']
  const weight =
    args['weight'] !== undefined ? parseWeight(args['weight']) : parseWeight(existing['weight'])
  const entry = buildEntry({
    id,
    text,
    meta: isRecord(meta) ? meta : {},
    weight,
    chunks: embedded.chunks,
    prev,
  })
  store.turnOpen(env.run)
  store.appendEntry(env.run, entry)
  store.turnClose(env.run)
  const newRecords: VectorRecord[] = embedded.chunks.map((chunk, position) => ({
    key: id,
    chunk_index: chunk.index,
    vector: embedded.vectors[position],
  }))
  try {
    await deps.vectorIndex.upsert({
      model: state.modelId,
      dim: state.dim,
      count: index.count,
      records: newRecords,
    })
  } catch (err) {
    return errorValue(toFailure(err).code, toFailure(err).message)
  }
  state.data = { modelId: state.modelId, dim: state.dim, count: index.count }
  return { ok: true, kind: 'edit', id, text }
}

/** 构造方法表（依赖注入：向量化 / 索引后端由 main 提供；存储由 env 打开，可注入便于测试）。 */
export function createHandlers(
  deps: MemoryDeps,
  anchor: { id: string; dim: number },
  store: MemoryStore = MemoryStore.open(anchor),
): Record<string, Handler> {
  const state: IndexState = {
    data: null,
    loaded: false,
    building: null,
    modelId: anchor.id,
    dim: anchor.dim,
  }
  return {
    put: (args: Json, env: CallEnv): Promise<Json> => put(args, env, deps, state, store),
    read: (args: Json): Promise<Json> => read(args, store),
    search: (args: Json): Promise<Json> => search(args, deps, state, store),
    list: (args: Json): Promise<Json> => list(args, store),
    append: (args: Json, env: CallEnv): Promise<Json> => append(args, env, deps, state, store),
    delete: (args: Json, env: CallEnv): Promise<Json> => remove(args, env, deps, store),
    pin: (args: Json, env: CallEnv): Promise<Json> => pin(args, env, store),
    edit: (args: Json, env: CallEnv): Promise<Json> => edit(args, env, deps, state, store),
  }
}
