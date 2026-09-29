// 能力类 `l1-maintenance` 的方法表：sweep / candidates / view。
// L1（short-memory 的 sessions）是运行记录、已出世界：本服务经反向调用读写 owner 服务，
// 不读投影、不产世界写计划、不自取时钟（时间由调用帧 env 传入，同输入同输出）。

import { asString, isRecord, nowOf } from 'plugin-sdk'
import { resolveParams } from './config.ts'
import type { L1Params } from './config.ts'
import { isoAt } from './plan.ts'
import { parseIso, sessionsOf } from './memory.ts'
import { BadArgsError, BackendError } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'
import type { SessionBackend, ShortMemoryBackend } from './port-link.ts'

/** 后端注入：生产环境是反向调用，单测注入假后端。 */
export interface L1Deps {
  shortMemory: ShortMemoryBackend
  session: SessionBackend
}

interface Context {
  args: Rec
  shortMemory: Rec
  params: L1Params
  at: string
  now: number
}

function toFailure(err: unknown): { code: string; message: string } {
  if (err instanceof BackendError) return { code: err.code, message: err.message }
  return {
    code: 'internal',
    message: err instanceof Error ? err.message : 'l1-maintenance failed',
  }
}

function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 读 L1（short-memory）与会话（session）：对齐原维护服务的 owner 读取面。 */
async function loadState(args: Json, env: CallEnv, deps: L1Deps): Promise<Context> {
  const record = isRecord(args) ? args : {}
  const shortMemory = await deps.shortMemory.read()
  await deps.session.read()
  const now = nowOf(env, record)
  return { args: record, shortMemory, params: resolveParams(record), at: isoAt(now), now }
}

/** L1 到期判据：`expires_at` 优先，否则 `at + TTL`；无时间依据则不判到期。 */
function l1Deadline(record: Rec, ttlMs: number): number | null {
  const expiresAt = parseIso(record['expires_at'])
  if (expiresAt !== null) return expiresAt
  const at = parseIso(record['at'])
  return at === null ? null : at + ttlMs
}

/** L1 TTL 清理：删到期会话，经反向调用写 short-memory。 */
async function sweep(args: Json, env: CallEnv, deps: L1Deps): Promise<Json> {
  const ctx = await loadState(args, env, deps)
  const sessions = sessionsOf(ctx.shortMemory)
  const deleted: string[] = []
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const deadline = l1Deadline(record, ctx.params.l1TtlMs)
    if (deadline !== null && deadline <= ctx.now) deleted.push(conversationId)
  }
  if (deleted.length > 0) await deps.shortMemory.apply({ del_sessions: deleted })
  return { ok: true, kind: 'sweep', at: ctx.at, l1_deleted: deleted }
}

/** 只读：回过期 L1 候选，不删、不写。 */
async function candidates(args: Json, env: CallEnv, deps: L1Deps): Promise<Json> {
  const ctx = await loadState(args, env, deps)
  const sessions = sessionsOf(ctx.shortMemory)
  const out: Rec[] = []
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const deadline = l1Deadline(record, ctx.params.l1TtlMs)
    if (deadline !== null && deadline <= ctx.now) {
      out.push({
        layer: 'l1',
        id: conversationId,
        at: asString(record['at']),
        reason: 'l1_expired',
      })
    }
  }
  return { ok: true, kind: 'candidates', at: ctx.at, candidates: out }
}

/** 只读：回 L1 一档（含剩余 TTL）。 */
async function view(args: Json, env: CallEnv, deps: L1Deps): Promise<Json> {
  const ctx = await loadState(args, env, deps)
  const sessions = sessionsOf(ctx.shortMemory)
  const l1: Rec[] = []
  for (const conversationId of Object.keys(sessions).sort()) {
    const record = sessions[conversationId]
    if (!isRecord(record)) continue
    const deadline = l1Deadline(record, ctx.params.l1TtlMs)
    l1.push({
      id: conversationId,
      at: asString(record['at']),
      expires_at: asString(record['expires_at']),
      ttl_remaining_ms: deadline === null ? null : Math.max(0, deadline - ctx.now),
      summary: isRecord(record['summary']) ? record['summary'] : {},
    })
  }
  return { ok: true, kind: 'view', at: ctx.at, l1 }
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

/** 构造方法表（依赖注入：owner 服务后端由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: L1Deps): Record<string, Handler> {
  return {
    sweep: (args: Json, env: CallEnv): Promise<Json> => guard(() => sweep(args, env, deps)),
    candidates: (args: Json, env: CallEnv): Promise<Json> =>
      guard(() => candidates(args, env, deps)),
    view: (args: Json, env: CallEnv): Promise<Json> => guard(() => view(args, env, deps)),
  }
}
