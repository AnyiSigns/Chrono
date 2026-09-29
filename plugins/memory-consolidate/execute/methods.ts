// 能力类 `memory-maintenance` 的方法表：consolidate / sweep / candidates / view / edit。
// 本插件退化为**时序编排门面**：保留原公开方法面与返回形状，按 layer 把算法委派给三个提供方
// （`l1-maintenance` / `l2-maintenance` / `l3-maintenance`）；自身不直接读写 owner 服务、
// 不读投影、不产世界写计划、不自取时钟（时间由调用帧 env 传入）。
// `sweep` 水位住宿主侧 ③（可重算），由本门面读写；是否推进水位取决于三层汇总是否有变更。

import { asString, isRecord, nowOf, errorValue } from 'plugin-sdk'
import { resolveParams } from './config.ts'
import { isoAt } from './plan.ts'
import { readWatermark, writeWatermark } from './watermark.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type { L1Backend, L2Backend, L3Backend } from './port-link.ts'

/** 后端注入：生产环境反向调用三个提供方，单测注入假后端。 */
export interface MaintenanceDeps {
  l1: L1Backend
  l2: L2Backend
  l3: L3Backend
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  return {
    code: 'internal',
    message: err instanceof Error ? err.message : 'memory-maintenance failed',
  }
}

/** 提供方结构化失败值（`{ok:false,error:{code,message}}`）→ 失败码与描述。 */
function failureOf(value: Rec): { code: string; message: string } {
  const error = isRecord(value['error']) ? (value['error'] as Rec) : {}
  return {
    code: typeof error['code'] === 'string' ? (error['code'] as string) : 'internal',
    message: typeof error['message'] === 'string' ? (error['message'] as string) : '',
  }
}

function arrayOf(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : []
}

/** 读 args / env 的公共上下文：now（不自取时钟）与 ISO at。 */
function contextOf(args: Json, env: CallEnv): { args: Rec; now: number; at: string } {
  const record = isRecord(args) ? args : {}
  const now = nowOf(env, record)
  return { args: record, now, at: isoAt(now) }
}

/** 时序编排：L2 合并（L1→L2）→ L3 固化（L2→L3）；返回原 consolidate 形状。 */
async function consolidate(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const { args: record, now, at } = contextOf(args, env)
  const params = resolveParams(record)
  // 不注入硬编码默认模型：调用方未指定 embedding_model 时，由下游 / 向量化门面按提供方元数据定缺省。
  const base: Rec = {
    ...record,
    now,
    dedup_threshold: params.dedupThreshold,
  }

  const merged = await deps.l2.merge(base)
  if (merged['ok'] === false) {
    const failure = failureOf(merged)
    return errorValue(failure.code, failure.message)
  }
  if (merged['no_input'] === true) {
    return { ok: true, kind: 'consolidate', at, no_input: true, merged: [], solidified: [] }
  }

  const solidifyArgs: Rec = {
    ...base,
    workspaces: arrayOf(merged['workspaces']),
    weight_threshold: params.weightThreshold,
    solidify_full_sources: params.solidifyFullSources,
  }
  const solidified = await deps.l3.solidify(solidifyArgs)
  if (solidified['ok'] === false) {
    const failure = failureOf(solidified)
    return errorValue(failure.code, failure.message)
  }

  const mergedList = arrayOf(merged['merged'])
  const solidifiedList = arrayOf(solidified['solidified'])
  if (mergedList.length === 0 && solidifiedList.length === 0) {
    return { ok: true, kind: 'consolidate', at, merged: [], solidified: [], no_change: true }
  }
  return {
    ok: true,
    kind: 'consolidate',
    at,
    dedup: 'vector',
    summary_used: merged['summary_used'] === true,
    merged: mergedList,
    solidified: solidifiedList,
  }
}

/** 时序编排：L1 清理 → L2 裁剪 → L3 遗忘；水位仅在三层汇总无变更时推进。 */
async function sweep(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const { args: record, now, at } = contextOf(args, env)
  const params = resolveParams(record)
  const explicitCursor = asString(record['cursor'])
  const cursor = explicitCursor ?? readWatermark()
  const base: Rec = { ...record, now }

  const l1 = await deps.l1.sweep({ ...base, l1_ttl_ms: params.l1TtlMs })
  if (l1['ok'] === false) {
    const failure = failureOf(l1)
    return errorValue(failure.code, failure.message)
  }
  const l2 = await deps.l2.trim({ ...base, l2_capacity: params.l2Capacity })
  if (l2['ok'] === false) {
    const failure = failureOf(l2)
    return errorValue(failure.code, failure.message)
  }
  const l3 = await deps.l3.forget({
    ...base,
    cursor,
    l3_capacity: params.l3Capacity,
    candidate_threshold: params.candidateThreshold,
  })
  if (l3['ok'] === false) {
    const failure = failureOf(l3)
    return errorValue(failure.code, failure.message)
  }

  const l1Deleted = arrayOf(l1['l1_deleted'])
  const l2Trimmed = arrayOf(l2['l2_trimmed'])
  const l3Deleted = arrayOf(l3['l3_deleted'])
  if (l1Deleted.length === 0 && l2Trimmed.length === 0 && l3Deleted.length === 0) {
    // 无变更：此时没有会被跳过的删除候选，推进水位安全。
    // 调用方显式给 cursor 时不改本地水位，避免污染后续无 cursor 的调用。
    if (explicitCursor === null) writeWatermark(at)
    return {
      ok: true,
      kind: 'sweep',
      at,
      l1_deleted: [],
      l2_trimmed: [],
      l3_deleted: [],
      cursor_next: at,
      no_changes: true,
    }
  }
  return {
    ok: true,
    kind: 'sweep',
    at,
    l1_deleted: l1Deleted,
    l2_trimmed: l2Trimmed,
    l3_deleted: l3Deleted,
    cursor_next: at,
  }
}

/** 只读：按 layer 扇出候选（L1 过期 / L2 超容量 / L3 低权重），拼成原形状，不删、不写。 */
async function candidates(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const { args: record, now, at } = contextOf(args, env)
  const params = resolveParams(record)
  const base: Rec = { ...record, now }

  const l1 = await deps.l1.candidates({ ...base, l1_ttl_ms: params.l1TtlMs })
  if (l1['ok'] === false) {
    const failure = failureOf(l1)
    return errorValue(failure.code, failure.message)
  }
  const l2 = await deps.l2.trim({ ...base, l2_capacity: params.l2Capacity, dry_run: true })
  if (l2['ok'] === false) {
    const failure = failureOf(l2)
    return errorValue(failure.code, failure.message)
  }
  const l3 = await deps.l3.forget({
    ...base,
    candidate_threshold: params.candidateThreshold,
    dry_run: true,
  })
  if (l3['ok'] === false) {
    const failure = failureOf(l3)
    return errorValue(failure.code, failure.message)
  }

  return {
    ok: true,
    kind: 'candidates',
    at,
    candidates: [
      ...arrayOf(l1['candidates']),
      ...arrayOf(l2['candidates']),
      ...arrayOf(l3['candidates']),
    ],
  }
}

/** 只读：按 layer 扇出视图（L1 / L2 / L3），拼成原形状。 */
async function view(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const { args: record, now, at } = contextOf(args, env)
  const params = resolveParams(record)
  const base: Rec = { ...record, now }

  const l1 = await deps.l1.view({ ...base, l1_ttl_ms: params.l1TtlMs })
  if (l1['ok'] === false) {
    const failure = failureOf(l1)
    return errorValue(failure.code, failure.message)
  }
  const l2 = await deps.l2.view(base)
  if (l2['ok'] === false) {
    const failure = failureOf(l2)
    return errorValue(failure.code, failure.message)
  }
  const l3 = await deps.l3.view(base)
  if (l3['ok'] === false) {
    const failure = failureOf(l3)
    return errorValue(failure.code, failure.message)
  }
  return {
    ok: true,
    kind: 'view',
    at,
    l1: arrayOf(l1['l1']),
    l2: arrayOf(l2['l2']),
    l3: arrayOf(l3['l3']),
  }
}

/** 按 layer 路由编辑：L3 → l3 提供方；L1 / L2 → l2 提供方。 */
async function edit(args: Json, env: CallEnv, deps: MaintenanceDeps): Promise<Json> {
  const { args: record, now } = contextOf(args, env)
  const slot = isRecord(record['slot']) ? (record['slot'] as Rec) : {}
  const action = asString(record['action']) ?? asString(slot['action'])
  const layer = asString(record['layer']) ?? asString(slot['layer'])
  const id = asString(record['id']) ?? asString(slot['id'])
  if (action === null || layer === null || id === null) {
    throw new BadArgsError('action, layer and id are required')
  }
  if (action !== 'delete' && action !== 'pin' && action !== 'text') {
    throw new BadArgsError('action must be delete / pin / text')
  }
  if (layer !== 'l1' && layer !== 'l2' && layer !== 'l3') {
    throw new BadArgsError('layer must be l1 / l2 / l3')
  }
  const payload: Rec = { ...record, now }
  if (layer === 'l3') return deps.l3.edit(payload)
  return deps.l2.edit(payload)
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

/** 构造方法表（依赖注入：三个提供方后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: MaintenanceDeps): Record<string, Handler> {
  return {
    consolidate: (args: Json, env: CallEnv): Promise<Json> =>
      guard(() => consolidate(args, env, deps)),
    sweep: (args: Json, env: CallEnv): Promise<Json> => guard(() => sweep(args, env, deps)),
    candidates: (args: Json, env: CallEnv): Promise<Json> =>
      guard(() => candidates(args, env, deps)),
    view: (args: Json, env: CallEnv): Promise<Json> => guard(() => view(args, env, deps)),
    edit: (args: Json, env: CallEnv): Promise<Json> => guard(() => edit(args, env, deps)),
  }
}
