// 能力类 `short-memory` 的方法表：read / read_session / read_workspace / apply / pending。
// L1 / L2 摘要已出世界：写即时落自有持久存储（④，边跑边追加），读从自有存储取。
// 服务不读投影、不产世界写计划、不自取时钟；跨身份的写方（compress / memory-consolidate）经能力调用问它。

import { asString, isRecord } from './plan.ts'
import { ShortMemoryStore } from './persist.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from './types.ts'

/** 服务依赖：自有存储（单测注入）。 */
export interface ShortMemoryDeps {
  store: ShortMemoryStore
}

function requireId(args: Rec, key: string): string {
  const id = asString(args[key])
  if (id === null) throw new BadArgsError(`${key} required`)
  return id
}

/** 读取某 id → record 的映射（对象形态）；非法即拒。 */
function recordsOf(value: Json | undefined, field: string): Rec {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  const out: Rec = {}
  for (const [id, record] of Object.entries(value)) {
    if (id.length === 0) continue
    if (record !== null && !isRecord(record)) throw new BadArgsError(`${field}.${id} must be an object or null`)
    out[id] = record
  }
  return out
}

function idsOf(value: Json | undefined, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadArgsError(`${field} must be an array`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) throw new BadArgsError(`${field} must contain non-empty strings`)
    out.push(item)
  }
  return out
}

/** 整份 L1 / L2 body（chat 装配 memories、记忆维护读取）。 */
function read(_args: Rec, _env: CallEnv, deps: ShortMemoryDeps): Json {
  return deps.store.body()
}

function readSession(args: Rec, _env: CallEnv, deps: ShortMemoryDeps): Json {
  const id = requireId(args, 'id')
  return { id, record: deps.store.sessionOf(id) }
}

function readWorkspace(args: Rec, _env: CallEnv, deps: ShortMemoryDeps): Json {
  const id = requireId(args, 'id')
  return { id, record: deps.store.workspaceOf(id) }
}

/**
 * 逐键置 / 删：`set_sessions` / `set_workspaces`（id → record，record=null 即删）、
 * `del_sessions` / `del_workspaces`（id 数组）。边跑边追加：先置回合 open、再落记录、再置 closed。
 */
function apply(args: Rec, env: CallEnv, deps: ShortMemoryDeps): Json {
  const setSessions = recordsOf(args['set_sessions'], 'set_sessions')
  const setWorkspaces = recordsOf(args['set_workspaces'], 'set_workspaces')
  const delSessions = idsOf(args['del_sessions'], 'del_sessions')
  const delWorkspaces = idsOf(args['del_workspaces'], 'del_workspaces')
  const store = deps.store
  store.turnOpen(env.run)
  let changed = 0
  for (const [id, record] of Object.entries(setSessions)) {
    if (record === null) {
      store.setL1(env.run, id, null)
      changed += 1
    } else {
      store.setL1(env.run, id, record)
      changed += 1
    }
  }
  for (const id of delSessions) {
    store.setL1(env.run, id, null)
    changed += 1
  }
  for (const [id, record] of Object.entries(setWorkspaces)) {
    if (record === null) {
      store.setL2(env.run, id, null)
      changed += 1
    } else {
      store.setL2(env.run, id, record)
      changed += 1
    }
  }
  for (const id of delWorkspaces) {
    store.setL2(env.run, id, null)
    changed += 1
  }
  store.turnClose(env.run)
  return { ok: true, changed }
}

/** 未闭合回合（中断残留）列表。 */
function pending(_args: Rec, _env: CallEnv, deps: ShortMemoryDeps): Json {
  return { turns: deps.store.pendingTurns() }
}

/** 构造方法表（依赖注入：存储由 main 提供，便于测试与确定性）。 */
export function createHandlers(deps: ShortMemoryDeps): Record<string, Handler> {
  const wrap = (fn: (args: Rec, env: CallEnv) => Json): Handler => {
    return async (args: Json, env: CallEnv): Promise<HandlerResult> => ({
      value: fn(isRecord(args) ? args : {}, env),
    })
  }
  return {
    read: wrap((args, env) => read(args, env, deps)),
    read_session: wrap((args, env) => readSession(args, env, deps)),
    read_workspace: wrap((args, env) => readWorkspace(args, env, deps)),
    apply: wrap((args, env) => apply(args, env, deps)),
    pending: wrap((args, env) => pending(args, env, deps)),
  }
}
