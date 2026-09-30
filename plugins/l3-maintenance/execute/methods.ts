// 能力类 `l3-maintenance` 的方法表：solidify / forget / view / edit。
// L3（memory-store）是运行记录、已出世界：本服务经反向调用读写 owner 服务，
// 不读投影、不产世界写计划、不自取时钟（时间由调用帧 env 传入）。
// L2 摘要经反向调用 `short-memory.read`；去重经反向调用 `embedding`。

import { asString, isRecord, nowOf } from 'plugin-sdk'
import { resolveParams } from './config.ts'
import { asStringList, atOrBefore, isoAt } from './plan.ts'
import { deriveEntryId, parseEntries, recordAt, stringArray, workspacesOf } from './memory.ts'
import type { LiveEntry } from './memory.ts'
import { dedupByCosine } from './vectors.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type { EmbeddingBackend, MemoryBackend, ShortMemoryBackend } from './port-link.ts'

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface L3Deps {
  memory: MemoryBackend
  shortMemory: ShortMemoryBackend
  embedding: EmbeddingBackend
}

interface EntryCandidate {
  workspace: string
  text: string
  weight: number
}

interface PendingDelete {
  id: string
  reason: string
  weight: number
  at: string
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  return {
    code: 'internal',
    message: err instanceof Error ? err.message : 'l3-maintenance failed',
  }
}

function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

function pinnedOf(listed: Rec): Rec {
  return isRecord(listed['pinned']) ? (listed['pinned'] as Rec) : {}
}

/** L2 高价值项固化进 L3：weight ≥ 阈值（或 high_value 强制）→ 与现有 L3 / 彼此余弦去重 → 写 owner 服务。 */
async function solidify(args: Json, env: CallEnv, deps: L3Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const workspaces = asStringList(record['workspaces'], 'workspaces')
  const now = nowOf(env, record)
  const at = isoAt(now)
  const params = resolveParams(record)
  const model = asString(record['embedding_model'])
  const shortMemory = await deps.shortMemory.read()
  const listed = await deps.memory.list()
  const entries = parseEntries(listed)
  const weights = isRecord(record['item_weights']) ? (record['item_weights'] as Rec) : {}
  const highValue = asStringList(record['high_value'], 'high_value')

  const candidates: EntryCandidate[] = []
  const workspaceRecords = workspacesOf(shortMemory)
  for (const workspace of [...workspaces].sort()) {
    const workspaceRecord = recordAt(workspaceRecords, workspace)
    const summary = isRecord(workspaceRecord['summary']) ? (workspaceRecord['summary'] as Rec) : {}
    const sources = stringArray(workspaceRecord['sources'])
    const derived =
      params.solidifyFullSources > 0 ? Math.min(1, sources.length / params.solidifyFullSources) : 1
    for (const field of ['facts', 'decisions']) {
      for (const text of stringArray(summary[field])) {
        const explicit =
          typeof weights[text] === 'number' && Number.isFinite(weights[text])
            ? (weights[text] as number)
            : null
        const weight = explicit ?? derived
        if (weight >= params.weightThreshold || highValue.includes(text)) {
          candidates.push({ workspace, text, weight })
        }
      }
    }
  }
  if (candidates.length === 0) return { ok: true, kind: 'solidify', at, solidified: [] }

  const items = [
    ...entries.map((entry) => ({
      key: `l3:${entry.id}`,
      text: entry.text,
      at: entry.at,
      priority: 0,
    })),
    ...candidates.map((candidate) => ({
      key: `new:${candidate.workspace}:${candidate.text}`,
      text: candidate.text,
      at: '',
      priority: 1,
    })),
  ]
  const result = await dedupByCosine(items, params.dedupThreshold, deps.embedding, model)
  const accepted = new Set(result.accepted.map((item) => item.key))
  const toAdd = candidates.filter((candidate) =>
    accepted.has(`new:${candidate.workspace}:${candidate.text}`),
  )

  const payload: Rec[] = []
  const solidified: Rec[] = []
  for (const candidate of toAdd) {
    const id = deriveEntryId(candidate.workspace, candidate.text, at)
    const sources = stringArray(recordAt(workspaceRecords, candidate.workspace)['sources'])
    const meta: Rec = { source: 'consolidate', workspace: candidate.workspace, at, tags: [] }
    if (sources.length > 0) meta['session'] = sources[0]
    payload.push({ id, text: candidate.text, meta, weight: candidate.weight })
    solidified.push({
      id,
      workspace: candidate.workspace,
      weight: candidate.weight,
      text: candidate.text,
    })
  }
  if (payload.length > 0) await deps.memory.append({ entries: payload })
  return { ok: true, kind: 'solidify', at, solidified }
}

/** L3 低权重 / 超容量遗忘（跳过 pinned）；`dry_run` 时只算不写、回 low_weight 候选。 */
async function forget(args: Json, env: CallEnv, deps: L3Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const now = nowOf(env, record)
  const at = isoAt(now)
  const params = resolveParams(record)
  const dryRun = record['dry_run'] === true
  const listed = await deps.memory.list()
  const entries = parseEntries(listed)
  const pinned = pinnedOf(listed)

  if (dryRun) {
    const candidates: Rec[] = []
    for (const entry of entries) {
      if (pinned[entry.id] === true) continue
      const weight = entry.weight ?? 1
      if (weight < params.candidateThreshold) {
        candidates.push({
          layer: 'l3',
          id: entry.id,
          text: entry.text,
          at: entry.at,
          weight,
          reason: 'low_weight',
        })
      }
    }
    return { ok: true, kind: 'forget', at, candidates }
  }

  const cursor = asString(record['cursor'])
  const deleted: PendingDelete[] = []
  const selected = new Set<string>()
  for (const entry of entries) {
    if (pinned[entry.id] === true) continue
    if (cursor !== null && entry.at !== '' && atOrBefore(entry.at, cursor)) continue
    const weight = entry.weight ?? 1
    if (weight < params.candidateThreshold) {
      deleted.push({ id: entry.id, reason: 'low_weight', weight, at: entry.at })
      selected.add(entry.id)
    }
  }
  const need = entries.length - deleted.length - params.l3Capacity
  if (need > 0) {
    const rest = entries
      .filter((entry) => pinned[entry.id] !== true && !selected.has(entry.id))
      .sort((left, right) => {
        const lw = left.weight ?? 1
        const rw = right.weight ?? 1
        if (lw !== rw) return lw - rw
        if (left.at !== right.at) return left.at < right.at ? -1 : 1
        return left.id < right.id ? -1 : 1
      })
    for (let index = 0; index < need && index < rest.length; index++) {
      deleted.push({
        id: rest[index].id,
        reason: 'over_capacity',
        weight: rest[index].weight ?? 1,
        at: rest[index].at,
      })
    }
  }
  if (deleted.length > 0) {
    await deps.memory.remove({ ids: deleted.map((item) => item.id), at })
  }
  return {
    ok: true,
    kind: 'forget',
    at,
    l3_deleted: deleted.map((item) => ({ id: item.id, reason: item.reason })),
    cursor_next: at,
  }
}

/** 只读：回 L3 一档（字段与条目一致 + pinned）。 */
async function view(args: Json, env: CallEnv, deps: L3Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const at = isoAt(nowOf(env, record))
  const listed = await deps.memory.list()
  const entries = parseEntries(listed)
  const pinned = pinnedOf(listed)
  const l3 = entries.map((entry) => ({
    id: entry.id,
    text: entry.text,
    at: entry.at,
    tags: stringArray(entry.meta['tags']),
    source: asString(entry.meta['source']),
    workspace: asString(entry.meta['workspace']),
    weight: entry.weight ?? null,
    pinned: pinned[entry.id] === true,
  }))
  return { ok: true, kind: 'view', at, l3 }
}

function findEntry(entries: LiveEntry[], id: string): LiveEntry | null {
  return entries.find((entry) => entry.id === id) ?? null
}

/** L3 编辑：删除 / 置顶 / 文本编辑经反向调用 memory-store 写自有存储。 */
async function edit(args: Json, env: CallEnv, deps: L3Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const slot = isRecord(record['slot']) ? (record['slot'] as Rec) : {}
  const action = asString(record['action']) ?? asString(slot['action'])
  const layer = asString(record['layer']) ?? asString(slot['layer'])
  const id = asString(record['id']) ?? asString(slot['id'])
  const patch = isRecord(record['patch'])
    ? (record['patch'] as Rec)
    : isRecord(slot['patch'])
      ? (slot['patch'] as Rec)
      : {}
  if (action === null || layer === null || id === null) {
    throw new BadArgsError('action, layer and id are required')
  }
  if (action !== 'delete' && action !== 'pin' && action !== 'text') {
    throw new BadArgsError('action must be delete / pin / text')
  }
  if (layer !== 'l3') throw new BadArgsError('layer must be l3')
  const at = isoAt(nowOf(env, record))
  const listed = await deps.memory.list()
  const existing = findEntry(parseEntries(listed), id)
  if (existing === null) {
    return { ok: false, kind: 'edit', layer: 'l3', id, reason: 'not_found' }
  }
  if (action === 'delete') {
    await deps.memory.remove({ ids: [id], at })
    return { ok: true, kind: 'edit', action, layer: 'l3', id, deleted_at: at }
  }
  if (action === 'pin') {
    const pinned = patch['pinned'] !== false
    await deps.memory.pin({ id, pinned })
    return { ok: true, kind: 'edit', action, layer: 'l3', id, pinned }
  }
  const text = asString(patch['text'])
  if (text === null) throw new BadArgsError('patch.text is required for text edit')
  const result = await deps.memory.edit({
    id,
    text,
    meta: { ...existing.meta, at },
    weight: existing.weight,
  })
  if (result['ok'] === false) {
    return { ok: false, kind: 'edit', layer: 'l3', id, reason: 'not_found' }
  }
  return { ok: true, kind: 'edit', action, layer: 'l3', id, text }
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

/** 构造方法表（依赖注入：owner 服务 / 向量化后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: L3Deps): Record<string, Handler> {
  return {
    solidify: (args: Json, env: CallEnv): Promise<Json> => guard(() => solidify(args, env, deps)),
    forget: (args: Json, env: CallEnv): Promise<Json> => guard(() => forget(args, env, deps)),
    view: (args: Json, env: CallEnv): Promise<Json> => guard(() => view(args, env, deps)),
    edit: (args: Json, env: CallEnv): Promise<Json> => guard(() => edit(args, env, deps)),
  }
}
