// 能力类 `l2-maintenance` 的方法表：merge / trim / view / edit。
// L1/L2（short-memory）都是运行记录、已出世界：本服务经反向调用读写 owner 服务，
// 不读投影、不产世界写计划、不自取时钟（时间由调用帧 env 传入）。
// 去重经反向调用 `embedding`；需要摘要时经反向调用 `compress`（persist:false）。

import { asString, isRecord, nowOf } from 'plugin-sdk'
import { resolveParams } from './config.ts'
import { isoAt, uniqueStrings } from './plan.ts'
import { parseIso, recordAt, sessionsOf, stringArray, workspacesOf } from './memory.ts'
import { dedupByCosine } from './vectors.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type {
  CompressBackend,
  EmbeddingBackend,
  SessionBackend,
  ShortMemoryBackend,
} from './port-link.ts'

const LIST_FIELDS = ['facts', 'decisions', 'open_questions', 'files']

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface L2Deps {
  shortMemory: ShortMemoryBackend
  session: SessionBackend
  embedding: EmbeddingBackend
  compress: CompressBackend
}

interface Context {
  args: Rec
  shortMemory: Rec
  at: string
  now: number
  model: string | null
  dedupThreshold: number
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  return {
    code: 'internal',
    message: err instanceof Error ? err.message : 'l2-maintenance failed',
  }
}

function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 读 L1/L2（short-memory）；会话归属（session）由 merge 单独读取。 */
async function loadState(args: Json, env: CallEnv, deps: L2Deps): Promise<Context> {
  const record = isRecord(args) ? args : {}
  const shortMemory = await deps.shortMemory.read()
  const now = nowOf(env, record)
  const params = resolveParams(record)
  return {
    args: record,
    shortMemory,
    at: isoAt(now),
    now,
    model: asString(record['embedding_model']),
    dedupThreshold: params.dedupThreshold,
  }
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

/** 分组 L1：按工作区归属；无归属（会话未映射且无显式 workspace）的会话跳过，不盲合并。 */
function groupL1(ctx: Context, session: Rec): Map<string, L1Record[]> {
  const sessions = sessionsOf(ctx.shortMemory)
  const wsMap = conversationWorkspaceMap(session)
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

/** 需要摘要时 eff：把合并后的列表交给 compress.summarize（persist:false，只算不写）。 */
async function summarizeWorkspace(
  ctx: Context,
  deps: L2Deps,
  workspace: string,
  l1s: L1Record[],
  merged: Rec,
): Promise<{ goal: string; facts: string[] } | { error: { code: string; message: string } }> {
  try {
    const payload = await deps.compress.summarize({
      conversation: l1s[0]?.id ?? '',
      workspace,
      mode: 'algorithmic',
      persist: false,
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

/** L1 合并进 L2：按工作区去重合并 → 写 owner 服务（short-memory）。 */
async function merge(args: Json, env: CallEnv, deps: L2Deps): Promise<Json> {
  const ctx = await loadState(args, env, deps)
  const session = await deps.session.read()
  const summarize = ctx.args['summarize'] === true
  const groups = groupL1(ctx, session)
  const workspaces = [...groups.keys()].sort()
  if (groups.size === 0) {
    return {
      ok: true,
      kind: 'merge',
      at: ctx.at,
      no_input: true,
      summary_used: summarize,
      merged: [],
      workspaces: [],
    }
  }

  const existingWorkspaces = workspacesOf(ctx.shortMemory)
  const changedWorkspaces: Rec = {}
  const mergedPayload: Rec[] = []

  for (const workspace of workspaces) {
    const l1s = (groups.get(workspace) ?? []).sort((left, right) =>
      left.atMs !== right.atMs ? right.atMs - left.atMs : left.id < right.id ? -1 : 1,
    )
    const existingL2 = recordAt(existingWorkspaces, workspace)
    const existingSummary = isRecord(existingL2['summary']) ? (existingL2['summary'] as Rec) : {}
    const nextSummary: Rec = {}
    // L2 列表按最旧在前（与 compress 追加写一致）：trim 超容量时从最旧一端裁。
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
      const result = await dedupByCosine(items, ctx.dedupThreshold, deps.embedding, ctx.model)
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
      const result = await dedupByCosine(items, ctx.dedupThreshold, deps.embedding, ctx.model)
      nextSummary['facts'] = result.accepted.map((item) => item.text).reverse()
    }
    const existingSources = stringArray(existingL2['sources'])
    const added = l1s.map((l1) => l1.id).filter((id) => !existingSources.includes(id))
    const sources = uniqueStrings([...added, ...existingSources])
    const nextL2: Rec = { ...existingL2, summary: nextSummary, sources, at: ctx.at }
    if (l2Changed(existingL2, nextL2)) {
      changedWorkspaces[workspace] = nextL2
      mergedPayload.push({
        workspace,
        facts: stringArray(nextSummary['facts']).length,
        sources: added,
      })
    }
  }

  if (mergedPayload.length > 0) await deps.shortMemory.apply({ set_workspaces: changedWorkspaces })

  return {
    ok: true,
    kind: 'merge',
    at: ctx.at,
    summary_used: summarize,
    changed: mergedPayload.length > 0,
    merged: mergedPayload,
    workspaces,
  }
}

/** L2 超容量裁剪（从最旧一端裁）；`dry_run` 时只算不写，回候选。 */
async function trim(args: Json, env: CallEnv, deps: L2Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const now = nowOf(env, record)
  const at = isoAt(now)
  const capacity = resolveParams(record).l2Capacity
  const dryRun = record['dry_run'] === true
  const shortMemory = await deps.shortMemory.read()
  const workspaces = workspacesOf(shortMemory)
  const trimmed: Array<{ workspace: string; removed: number; items: string[] }> = []
  const trimmedWorkspaces: Rec = {}
  for (const workspace of Object.keys(workspaces).sort()) {
    const value = workspaces[workspace]
    if (!isRecord(value)) continue
    const summary = isRecord(value['summary']) ? (value['summary'] as Rec) : {}
    const facts = stringArray(summary['facts'])
    if (facts.length > capacity) {
      const keep = facts.slice(facts.length - capacity)
      trimmed.push({
        workspace,
        removed: facts.length - keep.length,
        items: facts.slice(0, facts.length - keep.length),
      })
      trimmedWorkspaces[workspace] = { ...value, summary: { ...summary, facts: keep } }
    }
  }
  if (dryRun) {
    return {
      ok: true,
      kind: 'trim',
      at,
      candidates: trimmed.map((item) => ({
        layer: 'l2',
        id: item.workspace,
        reason: 'l2_over_capacity',
        excess: item.removed,
        items: item.items,
      })),
    }
  }
  if (trimmed.length > 0) await deps.shortMemory.apply({ set_workspaces: trimmedWorkspaces })
  return {
    ok: true,
    kind: 'trim',
    at,
    l2_trimmed: trimmed.map((item) => ({ workspace: item.workspace, removed: item.removed })),
  }
}

/** 只读：回 L2 一档。 */
async function view(args: Json, env: CallEnv, deps: L2Deps): Promise<Json> {
  const record = isRecord(args) ? args : {}
  const at = isoAt(nowOf(env, record))
  const shortMemory = await deps.shortMemory.read()
  const workspaces = workspacesOf(shortMemory)
  const l2: Rec[] = []
  for (const workspace of Object.keys(workspaces).sort()) {
    const value = workspaces[workspace]
    if (!isRecord(value)) continue
    l2.push({
      id: workspace,
      at: asString(value['at']),
      summary: isRecord(value['summary']) ? value['summary'] : {},
      sources: stringArray(value['sources']),
    })
  }
  return { ok: true, kind: 'view', at, l2 }
}

/** L1 / L2 编辑：删除整条；文本编辑合并 summary（置顶对 short-memory 不适用）。 */
async function edit(args: Json, env: CallEnv, deps: L2Deps): Promise<Json> {
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
  if (layer !== 'l1' && layer !== 'l2') {
    throw new BadArgsError('layer must be l1 / l2')
  }
  const at = isoAt(nowOf(env, record))
  const shortMemory = await deps.shortMemory.read()
  const isL1 = layer === 'l1'
  const container = isL1 ? sessionsOf(shortMemory) : workspacesOf(shortMemory)
  const existing = container[id]
  if (!isRecord(existing)) {
    return { ok: false, kind: 'edit', layer, id, reason: 'not_found' }
  }
  if (action === 'pin') {
    return { ok: false, kind: 'edit', layer, id, reason: 'unsupported_layer' }
  }
  if (action === 'delete') {
    await deps.shortMemory.apply(isL1 ? { del_sessions: [id] } : { del_workspaces: [id] })
    return { ok: true, kind: 'edit', action, layer, id, deleted_at: at }
  }
  const summary = isRecord(existing['summary']) ? (existing['summary'] as Rec) : {}
  const incoming = isRecord(patch['summary']) ? (patch['summary'] as Rec) : {}
  const nextSummary: Rec = { ...summary, ...incoming }
  const text = asString(patch['text'])
  if (text !== null) nextSummary['goal'] = text
  const nextRecord: Rec = { ...existing, summary: nextSummary }
  await deps.shortMemory.apply(
    isL1 ? { set_sessions: { [id]: nextRecord } } : { set_workspaces: { [id]: nextRecord } },
  )
  return { ok: true, kind: 'edit', action, layer, id }
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

/** 构造方法表（依赖注入：owner 服务 / 摘要后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: L2Deps): Record<string, Handler> {
  return {
    merge: (args: Json, env: CallEnv): Promise<Json> => guard(() => merge(args, env, deps)),
    trim: (args: Json, env: CallEnv): Promise<Json> => guard(() => trim(args, env, deps)),
    view: (args: Json, env: CallEnv): Promise<Json> => guard(() => view(args, env, deps)),
    edit: (args: Json, env: CallEnv): Promise<Json> => guard(() => edit(args, env, deps)),
  }
}
