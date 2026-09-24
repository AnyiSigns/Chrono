// 能力类 `memory-maintenance` 的方法表：consolidate / sweep / candidates / view / edit。
// 只构造写计划（`$directives`）与结果值，不读投影、不落账、不自取时钟。
// #3 L1/L2、#11 会话、#21 body + refs 由调用方入口 term / 宿主 periodic.reads 装配进 args（服务不读投影）。
// 去重 / 切块经反向调用 #20；需要摘要时经反向调用 #19（失败即明确失败、不半写）。

import { resolveParams } from './config.ts'
import {
  addGenOp,
  asString,
  asStringList,
  errorValue,
  externOnly,
  isRecord,
  isoAt,
  nowOf,
  planOf,
  putOp,
  uniqueStrings,
} from './plan.ts'
import type { MaintenanceParams } from './config.ts'
import {
  asShortMemory,
  countOf,
  deriveEntryId,
  liveEntries,
  parseIso,
  recordAt,
  sessionsOf,
  stringArray,
  tailHashOf,
  workspacesOf,
} from './memory.ts'
import type { LiveEntry } from './memory.ts'
import { chunkText, dedupByCosine } from './vectors.ts'
import { atOrBefore, readWatermark, writeWatermark } from './watermark.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type { CompressBackend, EmbeddingBackend } from './port-link.ts'

const DEFAULT_EMBEDDING_MODEL = 'granite-97m'
const LIST_FIELDS = ['facts', 'decisions', 'open_questions', 'files']

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface MaintenanceDeps {
  embedding: EmbeddingBackend
  compress: CompressBackend
}

interface Context {
  args: Rec
  shortMemory: Rec
  session: Rec
  memoryStore: Rec
  refs: Rec
  params: MaintenanceParams
  model: string
  at: string
  now: number
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  if (err instanceof BadArgsError) return { code: 'bad_args', message: err.message }
  return { code: 'internal', message: err instanceof Error ? err.message : 'memory-maintenance failed' }
}

/** 解析 args（bag）为上下文；形态非法抛 `BadArgsError`（结构化 `bad_args`）。 */
function parseContext(args: Json, env: CallEnv): Context {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  const now = nowOf(env, args)
  return {
    args,
    shortMemory: asShortMemory(args['short_memory']),
    session: isRecord(args['session']) ? (args['session'] as Rec) : {},
    memoryStore: isRecord(args['memory_store']) ? (args['memory_store'] as Rec) : {},
    refs: isRecord(args['memory_store_refs']) ? (args['memory_store_refs'] as Rec) : {},
    params: resolveParams(args),
    model: asString(args['embedding_model']) ?? DEFAULT_EMBEDDING_MODEL,
    at: isoAt(now),
    now,
  }
}

/** #21 新 body：保留 tail / count / deleted / pinned / model，按写入改对应字段。 */
function memoryStoreBody(input: {
  body: Rec
  tailRef: Json
  count: number
  deleted?: Rec
  pinned?: Rec
}): Rec {
  const body: Rec = {
    tail: input.tailRef === null ? null : { def: input.tailRef },
    count: input.count,
    deleted: input.deleted ?? (isRecord(input.body['deleted']) ? (input.body['deleted'] as Rec) : {}),
    pinned: input.pinned ?? (isRecord(input.body['pinned']) ? (input.body['pinned'] as Rec) : {}),
  }
  if (isRecord(input.body['model'])) body['model'] = input.body['model']
  return body
}

/** #21 条目 def（chunks 只存偏移；prev 为字面哈希或批内占位符）。 */
function buildEntry(input: {
  id: string
  text: string
  meta: Rec
  weight: number | undefined
  chunks: Array<{ index: number; start: number; end: number }>
  prev: Json
}): Rec {
  const entry: Rec = {
    id: input.id,
    text: input.text,
    meta: input.meta,
    chunks: input.chunks.map((chunk) => ({ index: chunk.index, start: chunk.start, end: chunk.end })),
    prev: input.prev === null ? null : { def: input.prev },
  }
  if (input.weight !== undefined) entry['weight'] = input.weight
  return entry
}

/** 追加 L3 条目写（entry def → 新 body → add_gen），占位符按批内下标机械接链。 */
function appendL3(ops: Json[], body: Rec, entries: Rec[]): void {
  let prev: Json = tailHashOf(body)
  for (const entry of entries) {
    ops.push(putOp({ ...entry, prev: prev === null ? null : { def: prev } }))
    prev = { $n: ops.length - 1 }
  }
  const next = memoryStoreBody({ body, tailRef: prev, count: countOf(body) + entries.length })
  ops.push(putOp(next))
  ops.push(addGenOp('memory-store', ops.length - 1))
}

/** 只写 #21 body（删除 / 置顶 / 编辑的 body 变更路径）。 */
function appendL3Body(ops: Json[], body: Rec): void {
  ops.push(putOp(body))
  ops.push(addGenOp('memory-store', ops.length - 1))
}

/** #11 会话 → 工作区归属（按 conversations[].workspace_id）。 */
function conversationWorkspaceMap(session: Rec): Map<string, string> {
  const map = new Map<string, string>()
  const list = Array.isArray(session['conversations']) ? (session['conversations'] as Json[]) : []
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = asString(item['id'])
    const workspace = asString(item['workspace_id'])
    if (id !== null && workspace !== null && !map.has(id)) map.set(id, workspace)
  }
  return map
}

function sameStringList(left: Json | undefined, right: Json | undefined): boolean {
  const a = stringArray(left)
  const b = stringArray(right)
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

/** L2 是否实质变化（不含 `at` 刷新）：goal / 四个列表 / sources 任一不同即变。 */
function l2Changed(existing: Rec, next: Rec): boolean {
  const left = isRecord(existing['summary']) ? (existing['summary'] as Rec) : {}
  const right = isRecord(next['summary']) ? (next['summary'] as Rec) : {}
  if ((asString(left['goal']) ?? '') !== (asString(right['goal']) ?? '')) return true
  for (const field of LIST_FIELDS) {
    if (!sameStringList(left[field], right[field])) return true
  }
  return !sameStringList(existing['sources'], next['sources'])
}

interface L1Record {
  id: string
  at: string
  atMs: number
  workspace: string
  summary: Rec
}

/** 分组 L1：按工作区归属；无归属（#11 未映射且无显式 workspace）的会话跳过，不盲合并。 */
function groupL1(ctx: Context): Map<string, L1Record[]> {
  const sessions = sessionsOf(ctx.shortMemory)
  const wsMap = conversationWorkspaceMap(ctx.session)
  const explicit = asString(ctx.args['workspace'])
  const groups = new Map<string, L1Record[]>()
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const workspace = wsMap.get(conversationId) ?? explicit
    if (workspace === null) continue
    const at = asString(record['at']) ?? ctx.at
    const list = groups.get(workspace) ?? []
    list.push({
      id: conversationId,
      at,
      atMs: parseIso(at) ?? ctx.now,
      workspace,
      summary: isRecord(record['summary']) ? (record['summary'] as Rec) : {},
    })
    groups.set(workspace, list)
  }
  return groups
}

/** 需要摘要时 eff #19：把合并后的列表交给 compress.summarize，取回结构化 goal / facts。 */
async function summarizeWorkspace(
  ctx: Context,
  deps: MaintenanceDeps,
  workspace: string,
  l1s: L1Record[],
  merged: Rec,
): Promise<{ goal: string; facts: string[] } | { error: { code: string; message: string } }> {
  try {
    const payload = await deps.compress.summarize({
      memory: ctx.shortMemory,
      conversation: l1s[0]?.id ?? '',
      workspace,
      mode: 'algorithmic',
      goal: asString(merged['goal']) ?? '',
      facts: stringArray(merged['facts']),
      decisions: stringArray(merged['decisions']),
      open_questions: stringArray(merged['open_questions']),
      files: stringArray(merged['files']),
    })
    const summary = isRecord(payload['summary']) ? (payload['summary'] as Rec) : {}
    return { goal: asString(summary['goal']) ?? '', facts: stringArray(summary['facts']) }
  } catch (err) {
    const failure = toFailure(err)
    return { error: { code: failure.code, message: failure.message } }
  }
}

/** L1 合并进 L2（去重向量由 #20 提供）→ L2 高价值项固化进 L3 → 产计划。 */
async function consolidate(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const ctx = parseContext(args, env)
  const summarize = args['summarize'] === true
  const groups = groupL1(ctx)
  if (groups.size === 0) {
    return externOnly({ ok: true, kind: 'consolidate', at: ctx.at, no_input: true, merged: [], solidified: [] })
  }

  const existingWorkspaces = workspacesOf(ctx.shortMemory)
  const nextWorkspaces: Rec = { ...existingWorkspaces }
  const mergedPayload: Rec[] = []
  const sourcesByWorkspace = new Map<string, string[]>()
  const nextSummaries = new Map<string, Rec>()

  for (const workspace of [...groups.keys()].sort()) {
    const l1s = (groups.get(workspace) ?? []).sort((left, right) =>
      left.atMs !== right.atMs ? right.atMs - left.atMs : left.id < right.id ? -1 : 1,
    )
    const existingL2 = recordAt(existingWorkspaces, workspace)
    const existingSummary = isRecord(existingL2['summary']) ? (existingL2['summary'] as Rec) : {}
    const nextSummary: Rec = {}
    // L2 列表按最旧在前（与 compress 追加写一致）：sweep 超容量时从最旧一端裁。
    for (const field of LIST_FIELDS) {
      const items = []
      for (const l1 of l1s) {
        for (const text of stringArray(l1.summary[field])) {
          items.push({ key: `l1:${l1.id}:${field}:${text}`, text, at: l1.at, priority: 1 })
        }
      }
      for (const text of stringArray(existingSummary[field])) {
        items.push({
          key: `l2:${workspace}:${field}:${text}`,
          text,
          at: asString(existingL2['at']) ?? '',
          priority: 2,
        })
      }
      const result = await dedupByCosine(items, ctx.params.dedupThreshold, deps.embedding, ctx.model)
      nextSummary[field] = result.accepted.map((item) => item.text).reverse()
    }
    nextSummary['goal'] = asString(existingSummary['goal']) ?? ''
    if (summarize) {
      const summarized = await summarizeWorkspace(ctx, deps, workspace, l1s, nextSummary)
      if ('error' in summarized) return errorValue(summarized.error.code, summarized.error.message)
      nextSummary['goal'] = summarized.goal
      const items = summarized.facts.map((text, index) => ({
        key: `s:${index}:${text}`,
        text,
        at: ctx.at,
        priority: 1,
      }))
      const result = await dedupByCosine(items, ctx.params.dedupThreshold, deps.embedding, ctx.model)
      nextSummary['facts'] = result.accepted.map((item) => item.text).reverse()
    }
    const existingSources = stringArray(existingL2['sources'])
    const added = l1s.map((l1) => l1.id).filter((id) => !existingSources.includes(id))
    const sources = uniqueStrings([...added, ...existingSources])
    sourcesByWorkspace.set(workspace, sources)
    nextSummaries.set(workspace, nextSummary)
    const nextL2: Rec = { ...existingL2, summary: nextSummary, sources, at: ctx.at }
    if (l2Changed(existingL2, nextL2)) {
      nextWorkspaces[workspace] = nextL2
      mergedPayload.push({ workspace, facts: stringArray(nextSummary['facts']).length, sources: added })
    }
  }

  const shortChanged = mergedPayload.length > 0

  // L2 高价值项固化进 L3：weight ≥ 阈值（或 high_value 强制）；与现有 L3 / 彼此余弦去重。
  const weights = isRecord(ctx.args['item_weights']) ? (ctx.args['item_weights'] as Rec) : {}
  const highValue = asStringList(ctx.args['high_value'], 'high_value')
  const candidates: Array<{ workspace: string; text: string; weight: number }> = []
  for (const workspace of [...nextSummaries.keys()].sort()) {
    const summary = nextSummaries.get(workspace) as Rec
    const sources = sourcesByWorkspace.get(workspace) ?? []
    const derived = Math.min(1, sources.length / ctx.params.solidifyFullSources)
    for (const field of ['facts', 'decisions']) {
      for (const text of stringArray(summary[field])) {
        const explicit = typeof weights[text] === 'number' && Number.isFinite(weights[text]) ? (weights[text] as number) : null
        const weight = explicit ?? derived
        if (weight >= ctx.params.weightThreshold || highValue.includes(text)) {
          candidates.push({ workspace, text, weight })
        }
      }
    }
  }

  const existingEntries = liveEntries(ctx.memoryStore, ctx.refs)
  let toAdd: Array<{ workspace: string; text: string; weight: number }> = []
  if (candidates.length > 0) {
    const items = [
      ...existingEntries.map((entry) => ({ key: `l3:${entry.id}`, text: entry.text, at: entry.at, priority: 0 })),
      ...candidates.map((candidate) => ({
        key: `new:${candidate.workspace}:${candidate.text}`,
        text: candidate.text,
        at: '',
        priority: 1,
      })),
    ]
    const result = await dedupByCosine(items, ctx.params.dedupThreshold, deps.embedding, ctx.model)
    const accepted = new Set(result.accepted.map((item) => item.key))
    toAdd = candidates.filter((candidate) => accepted.has(`new:${candidate.workspace}:${candidate.text}`))
  }

  if (!shortChanged && toAdd.length === 0) {
    return externOnly({ ok: true, kind: 'consolidate', at: ctx.at, merged: [], solidified: [], no_change: true })
  }

  const entries: Rec[] = []
  const solidifiedPayload: Rec[] = []
  for (const candidate of toAdd) {
    const chunks = await chunkText(candidate.text, deps.embedding)
    const id = deriveEntryId(candidate.workspace, candidate.text, ctx.at)
    const sources = sourcesByWorkspace.get(candidate.workspace) ?? []
    const meta: Rec = { source: 'consolidate', workspace: candidate.workspace, at: ctx.at, tags: [] }
    if (sources.length > 0) meta['session'] = sources[0]
    entries.push(
      buildEntry({ id, text: candidate.text, meta, weight: candidate.weight, chunks, prev: null }),
    )
    solidifiedPayload.push({ id, workspace: candidate.workspace, weight: candidate.weight, text: candidate.text })
  }

  const ops: Json[] = []
  if (shortChanged) {
    ops.push(putOp({ ...ctx.shortMemory, workspaces: nextWorkspaces }))
    ops.push(addGenOp('short-memory', ops.length - 1))
  }
  if (entries.length > 0) appendL3(ops, ctx.memoryStore, entries)

  return planOf(ops, {
    ok: true,
    kind: 'consolidate',
    at: ctx.at,
    dedup: 'vector',
    summary_used: summarize,
    merged: mergedPayload,
    solidified: solidifiedPayload,
  })
}

/** 待删 L1（到期 24h）/ L2（超容量）/ L3（低权重、超容量，跳过 pinned）→ 产删除计划。 */
async function sweep(args: Json, env: CallEnv): Promise<Json> {
  const ctx = parseContext(args, env)
  const explicitCursor = asString(args['cursor'])
  const cursor = explicitCursor ?? readWatermark()

  const sessions = sessionsOf(ctx.shortMemory)
  const nextSessions: Rec = {}
  const l1Deleted: string[] = []
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) {
      nextSessions[conversationId] = record
      continue
    }
    const expiresAt = parseIso(record['expires_at'])
    const at = parseIso(record['at'])
    const deadline = expiresAt ?? (at === null ? null : at + ctx.params.l1TtlMs)
    if (deadline !== null && deadline <= ctx.now) {
      l1Deleted.push(conversationId)
      continue
    }
    nextSessions[conversationId] = record
  }

  const workspaces = workspacesOf(ctx.shortMemory)
  const nextWorkspaces: Rec = {}
  const l2Trimmed: Rec[] = []
  for (const workspace of Object.keys(workspaces).sort()) {
    const record = workspaces[workspace]
    if (!isRecord(record)) {
      nextWorkspaces[workspace] = record
      continue
    }
    const summary = isRecord(record['summary']) ? (record['summary'] as Rec) : {}
    const facts = stringArray(summary['facts'])
    if (facts.length > ctx.params.l2Capacity) {
      const keep = facts.slice(facts.length - ctx.params.l2Capacity)
      l2Trimmed.push({ workspace, removed: facts.length - keep.length })
      nextWorkspaces[workspace] = { ...record, summary: { ...summary, facts: keep } }
    } else {
      nextWorkspaces[workspace] = record
    }
  }
  const shortChanged = l1Deleted.length > 0 || l2Trimmed.length > 0

  const live = liveEntries(ctx.memoryStore, ctx.refs)
  const pinned = isRecord(ctx.memoryStore['pinned']) ? (ctx.memoryStore['pinned'] as Rec) : {}
  const l3Deleted: Array<{ id: string; reason: string; weight: number; at: string }> = []
  const selected = new Set<string>()
  for (const entry of live) {
    if (pinned[entry.id] === true) continue
    if (cursor !== null && entry.at !== '' && atOrBefore(entry.at, cursor)) continue
    const weight = entry.weight ?? 1
    if (weight < ctx.params.candidateThreshold) {
      l3Deleted.push({ id: entry.id, reason: 'low_weight', weight, at: entry.at })
      selected.add(entry.id)
    }
  }
  const need = live.length - l3Deleted.length - ctx.params.l3Capacity
  if (need > 0) {
    const rest = live
      .filter((entry) => pinned[entry.id] !== true && !selected.has(entry.id))
      .sort((left, right) => {
        const lw = left.weight ?? 1
        const rw = right.weight ?? 1
        if (lw !== rw) return lw - rw
        if (left.at !== right.at) return left.at < right.at ? -1 : 1
        return left.id < right.id ? -1 : 1
      })
    for (let index = 0; index < need && index < rest.length; index++) {
      l3Deleted.push({ id: rest[index].id, reason: 'over_capacity', weight: rest[index].weight ?? 1, at: rest[index].at })
    }
  }
  const l3Changed = l3Deleted.length > 0

  if (!shortChanged && !l3Changed) {
    // 无写计划可落账：此时推进水位安全（没有待落账删除会被跳过）。
    // 调用方显式给 cursor 时不改本地水位，避免污染后续无 cursor 的调用。
    if (explicitCursor === null) writeWatermark(ctx.at)
    return externOnly({
      ok: true,
      kind: 'sweep',
      at: ctx.at,
      l1_deleted: [],
      l2_trimmed: [],
      l3_deleted: [],
      cursor_next: ctx.at,
      no_changes: true,
    })
  }

  // 有写计划：水位不在此处推进——计划未落账时，同输入重跑必须仍产出同一删除集。
  // 新水位随 `cursor_next` 返回，由调用方在计划落账后自行持久化。

  const ops: Json[] = []
  if (shortChanged) {
    ops.push(putOp({ ...ctx.shortMemory, sessions: nextSessions, workspaces: nextWorkspaces }))
    ops.push(addGenOp('short-memory', ops.length - 1))
  }
  if (l3Changed) {
    const deleted = { ...(isRecord(ctx.memoryStore['deleted']) ? (ctx.memoryStore['deleted'] as Rec) : {}) }
    for (const item of l3Deleted) deleted[item.id] = ctx.at
    appendL3Body(
      ops,
      memoryStoreBody({
        body: ctx.memoryStore,
        tailRef: tailHashOf(ctx.memoryStore),
        count: countOf(ctx.memoryStore),
        deleted,
      }),
    )
  }

  return planOf(ops, {
    ok: true,
    kind: 'sweep',
    at: ctx.at,
    l1_deleted: l1Deleted,
    l2_trimmed: l2Trimmed,
    l3_deleted: l3Deleted.map((item) => ({ id: item.id, reason: item.reason })),
    cursor_next: ctx.at,
  })
}

/** 只读：回「过期 / 低价值」候选列表，不删、不产写。 */
async function candidates(args: Json, env: CallEnv): Promise<Json> {
  const ctx = parseContext(args, env)
  const out: Rec[] = []
  const sessions = sessionsOf(ctx.shortMemory)
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const expiresAt = parseIso(record['expires_at'])
    const at = parseIso(record['at'])
    const deadline = expiresAt ?? (at === null ? null : at + ctx.params.l1TtlMs)
    if (deadline !== null && deadline <= ctx.now) {
      out.push({ layer: 'l1', id: conversationId, at: asString(record['at']), reason: 'l1_expired' })
    }
  }
  const workspaces = workspacesOf(ctx.shortMemory)
  for (const workspace of Object.keys(workspaces).sort()) {
    const record = workspaces[workspace]
    if (!isRecord(record)) continue
    const summary = isRecord(record['summary']) ? (record['summary'] as Rec) : {}
    const facts = stringArray(summary['facts'])
    if (facts.length > ctx.params.l2Capacity) {
      out.push({
        layer: 'l2',
        id: workspace,
        reason: 'l2_over_capacity',
        excess: facts.length - ctx.params.l2Capacity,
        items: facts.slice(0, facts.length - ctx.params.l2Capacity),
      })
    }
  }
  const pinned = isRecord(ctx.memoryStore['pinned']) ? (ctx.memoryStore['pinned'] as Rec) : {}
  for (const entry of liveEntries(ctx.memoryStore, ctx.refs)) {
    if (pinned[entry.id] === true) continue
    const weight = entry.weight ?? 1
    if (weight < ctx.params.candidateThreshold) {
      out.push({
        layer: 'l3',
        id: entry.id,
        text: entry.text,
        at: entry.at,
        weight,
        reason: 'low_weight',
      })
    }
  }
  return { ok: true, kind: 'candidates', at: ctx.at, candidates: out }
}

/** 只读：回 L1 / L2 / L3 三档（L3 字段与 #21 条目一致 + L1 剩余 TTL）。 */
async function view(args: Json, env: CallEnv): Promise<Json> {
  const ctx = parseContext(args, env)
  const l1: Rec[] = []
  const sessions = sessionsOf(ctx.shortMemory)
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const expiresAt = parseIso(record['expires_at'])
    const at = parseIso(record['at'])
    const deadline = expiresAt ?? (at === null ? null : at + ctx.params.l1TtlMs)
    l1.push({
      id: conversationId,
      at: asString(record['at']),
      expires_at: asString(record['expires_at']),
      ttl_remaining_ms: deadline === null ? null : Math.max(0, deadline - ctx.now),
      summary: isRecord(record['summary']) ? record['summary'] : {},
    })
  }
  const l2: Rec[] = []
  const workspaces = workspacesOf(ctx.shortMemory)
  for (const workspace of Object.keys(workspaces).sort()) {
    const record = workspaces[workspace]
    if (!isRecord(record)) continue
    l2.push({
      id: workspace,
      at: asString(record['at']),
      summary: isRecord(record['summary']) ? record['summary'] : {},
      sources: stringArray(record['sources']),
    })
  }
  const pinned = isRecord(ctx.memoryStore['pinned']) ? (ctx.memoryStore['pinned'] as Rec) : {}
  const l3 = liveEntries(ctx.memoryStore, ctx.refs).map((entry) => ({
    id: entry.id,
    text: entry.text,
    at: entry.at,
    tags: stringArray(entry.meta['tags']),
    source: asString(entry.meta['source']),
    workspace: asString(entry.meta['workspace']),
    weight: entry.weight ?? null,
    pinned: pinned[entry.id] === true,
  }))
  return { ok: true, kind: 'view', at: ctx.at, l1, l2, l3 }
}

function findEntry(entries: LiveEntry[], id: string): LiveEntry | null {
  return entries.find((entry) => entry.id === id) ?? null
}

/** L3 编辑：删除 = body.deleted；置顶 = body.pinned；文本编辑 = put 新条目 def + 新 body。 */
async function editL3(
  ctx: Context,
  action: string,
  id: string,
  patch: Rec,
  deps: MaintenanceDeps,
): Promise<Json> {
  const entries = liveEntries(ctx.memoryStore, ctx.refs)
  const existing = findEntry(entries, id)
  if (existing === null) {
    return externOnly({ ok: false, kind: 'edit', layer: 'l3', id, reason: 'not_found' })
  }
  const ops: Json[] = []
  if (action === 'delete') {
    const deleted = { ...(isRecord(ctx.memoryStore['deleted']) ? (ctx.memoryStore['deleted'] as Rec) : {}) }
    deleted[id] = ctx.at
    appendL3Body(
      ops,
      memoryStoreBody({
        body: ctx.memoryStore,
        tailRef: tailHashOf(ctx.memoryStore),
        count: countOf(ctx.memoryStore),
        deleted,
      }),
    )
    return planOf(ops, { ok: true, kind: 'edit', action, layer: 'l3', id, deleted_at: ctx.at })
  }
  if (action === 'pin') {
    const pinned = { ...(isRecord(ctx.memoryStore['pinned']) ? (ctx.memoryStore['pinned'] as Rec) : {}) }
    if (patch['pinned'] === false) delete pinned[id]
    else pinned[id] = true
    appendL3Body(
      ops,
      memoryStoreBody({
        body: ctx.memoryStore,
        tailRef: tailHashOf(ctx.memoryStore),
        count: countOf(ctx.memoryStore),
        pinned,
      }),
    )
    return planOf(ops, { ok: true, kind: 'edit', action, layer: 'l3', id, pinned: patch['pinned'] !== false })
  }
  const text = asString(patch['text'])
  if (text === null) throw new BadArgsError('patch.text is required for text edit')
  const chunks = await chunkText(text, deps.embedding)
  const meta: Rec = { ...existing.meta, at: ctx.at }
  const entry = buildEntry({ id, text, meta, weight: existing.weight, chunks, prev: null })
  ops.push(putOp({ ...entry, prev: tailHashOf(ctx.memoryStore) === null ? null : { def: tailHashOf(ctx.memoryStore) } }))
  const next = memoryStoreBody({
    body: ctx.memoryStore,
    tailRef: { $n: 0 },
    count: countOf(ctx.memoryStore) + 1,
  })
  ops.push(putOp(next))
  ops.push(addGenOp('memory-store', 1))
  return planOf(ops, { ok: true, kind: 'edit', action, layer: 'l3', id, text })
}

/** L1 / L2 编辑：删除整条；文本编辑合并 summary（置顶对 #3 不适用）。 */
function editShort(ctx: Context, action: string, layer: string, id: string, patch: Rec): Json {
  const isL1 = layer === 'l1'
  const container = isL1 ? sessionsOf(ctx.shortMemory) : workspacesOf(ctx.shortMemory)
  const existing = container[id]
  if (!isRecord(existing)) {
    return externOnly({ ok: false, kind: 'edit', layer, id, reason: 'not_found' })
  }
  if (action === 'pin') {
    return externOnly({ ok: false, kind: 'edit', layer, id, reason: 'unsupported_layer' })
  }
  if (action === 'delete') {
    const next: Rec = { ...container }
    delete next[id]
    const body: Rec = isL1
      ? { ...ctx.shortMemory, sessions: next }
      : { ...ctx.shortMemory, workspaces: next }
    return planOf([putOp(body), addGenOp('short-memory', 0)], {
      ok: true,
      kind: 'edit',
      action,
      layer,
      id,
      deleted_at: ctx.at,
    })
  }
  const summary = isRecord(existing['summary']) ? (existing['summary'] as Rec) : {}
  const incoming = isRecord(patch['summary']) ? (patch['summary'] as Rec) : {}
  const nextSummary: Rec = { ...summary, ...incoming }
  const text = asString(patch['text'])
  if (text !== null) nextSummary['goal'] = text
  const nextRecord: Rec = { ...existing, summary: nextSummary }
  const next: Rec = { ...container, [id]: nextRecord }
  const body: Rec = isL1
    ? { ...ctx.shortMemory, sessions: next }
    : { ...ctx.shortMemory, workspaces: next }
  return planOf([putOp(body), addGenOp('short-memory', 0)], {
    ok: true,
    kind: 'edit',
    action,
    layer,
    id,
  })
}

/** UI / agent 的改 / 删 / 置顶：收入口 term 传入的槽体与 #3 / #21 片段 → 出计划。 */
async function edit(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const ctx = parseContext(args, env)
  const slot = isRecord(args['slot']) ? (args['slot'] as Rec) : {}
  const action = asString(args['action']) ?? asString(slot['action'])
  const layer = asString(args['layer']) ?? asString(slot['layer'])
  const id = asString(args['id']) ?? asString(slot['id'])
  const patch = isRecord(args['patch']) ? (args['patch'] as Rec) : isRecord(slot['patch']) ? (slot['patch'] as Rec) : {}
  if (action === null || layer === null || id === null) {
    throw new BadArgsError('action, layer and id are required')
  }
  if (action !== 'delete' && action !== 'pin' && action !== 'text') {
    throw new BadArgsError('action must be delete / pin / text')
  }
  if (layer !== 'l1' && layer !== 'l2' && layer !== 'l3') {
    throw new BadArgsError('layer must be l1 / l2 / l3')
  }
  if (layer === 'l3') return editL3(ctx, action, id, patch, deps)
  return editShort(ctx, action, layer, id, patch)
}

/** 失败作数据：后端不可用 / 内部异常回结构化错误（BadArgsError 继续上抛为 bad_args）。 */
async function guard(run: () => Promise<Json>): Promise<Json> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof BadArgsError) throw err
    const failure = toFailure(err)
    return errorValue(failure.code, failure.message)
  }
}

/** 构造方法表（依赖注入：向量化 / 摘要后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: MaintenanceDeps): Record<string, Handler> {
  return {
    consolidate: (args: Json, env: CallEnv): Promise<Json> => guard(() => consolidate(args, env, deps)),
    sweep: (args: Json, env: CallEnv): Promise<Json> => guard(() => sweep(args, env)),
    candidates: (args: Json, env: CallEnv): Promise<Json> => guard(() => candidates(args, env)),
    view: (args: Json, env: CallEnv): Promise<Json> => guard(() => view(args, env)),
    edit: (args: Json, env: CallEnv): Promise<Json> => guard(() => edit(args, env, deps)),
  }
}
