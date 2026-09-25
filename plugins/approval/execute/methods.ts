// 能力类 `approval` 的五个方法：队列与裁决回执写自有持久存储（④），返回的 `$directives` 只含 `extern`。
// 服务不读投影、不构造世界写计划、不自取时钟：队列与 resume 游标由本身份持久化，调用方不再传切片。
// 周期 `sweep` 的所需数据也来自自有存储（不再由宿主注入投影片段）。

import { approvalPolicy } from './config.ts'
import { approvalId, MAIN_THREAD, type ApprovalStore, type Rec } from './store.ts'
import {
  asString,
  buildResume,
  externOnly,
  isRecord,
  isoAt,
  normalizeArgsRef,
  normalizeKind,
  normalizeShadow,
  nowOf,
  resolvePort,
  statusOf,
  threadKeyOf,
  verdictToStatus,
} from './plan.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, ServiceEvent } from './types.ts'

export interface ApprovalDeps {
  store: ApprovalStore
}

function requireRecord(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  return value
}

/** 幂等键：同回合同一审批节点的重复入队收敛到同一条。取游标里的稳定小字段，不落整份游标。 */
function opKeyOf(run: string, cursor: Json | undefined): string {
  if (!isRecord(cursor)) return `${run}:approval`
  const nodeIndex = cursor['node_index']
  return typeof nodeIndex === 'number' ? `${run}:approval:${nodeIndex}` : `${run}:approval`
}

// ── enqueue ────────────────────────────────────────────────────────────────

function enqueue(args: Rec, env: CallEnv, store: ApprovalStore): HandlerResult {
  const kind = normalizeKind(args['kind'])
  if (kind === null) {
    throw new BadArgsError('kind must be tool_call / orchestration_change / plugin_write')
  }
  const policy = approvalPolicy(args)
  const items = store.itemsInOrder()
  const counted = items.filter((item) => {
    const status = statusOf(item)
    if (policy.capacityScope === 'live') return status === 'pending' || status === 'expired'
    return status === 'pending'
  }).length
  if (counted >= policy.capacity) {
    return {
      value: externOnly({ ok: false, reason: 'queue_full', capacity: policy.capacity, counted }),
      events: [],
    }
  }

  const run = asString(args['run']) ?? env.run ?? 'run'
  const thread = asString(args['thread']) ?? env.thread ?? MAIN_THREAD
  const at = asString(args['at']) ?? isoAt(nowOf(env))
  const opKey = opKeyOf(run, args['cursor'])

  const existing = store.findByOpKey(opKey)
  if (existing !== null) {
    return {
      value: externOnly({ ok: true, id: existing['id'], count: store.count(), pending: counted }),
      events: [],
    }
  }

  const id = approvalId(run, store.count())
  const item: Rec = {
    id,
    op_key: opKey,
    kind,
    port: resolvePort(kind, args['port']),
    method: asString(args['method']) ?? 'invoke',
    args_ref: normalizeArgsRef(args['args_ref']),
    tier: asString(args['tier']),
    workspace_id: asString(args['workspace_id']),
    run,
    thread,
    at,
    status: 'pending',
    decided_at: null,
    by: null,
    resume: buildResume(args, thread),
    shadow: kind === 'orchestration_change' ? normalizeShadow(args['shadow']) : null,
  }
  store.turnOpen(run)
  store.appendItem(run, item)
  store.turnClose(run)

  const events: ServiceEvent[] = [
    {
      topic: 'approval.pending',
      payload: {
        run: env.run,
        thread,
        id,
        kind,
        port: item['port'],
        tier: item['tier'],
        at,
        count: store.count(),
      },
    },
  ]
  const value = externOnly({ ok: true, id, count: store.count(), pending: counted + 1 })
  return { value, events }
}

// ── list（只读） ───────────────────────────────────────────────────────────

function list(args: Rec, store: ApprovalStore): HandlerResult {
  void args
  const items = store.itemsInOrder()
  const pending = items.filter((item) => statusOf(item) === 'pending').length
  const expired = items.filter((item) => statusOf(item) === 'expired').length
  const decided = items.filter((item) => {
    const status = statusOf(item)
    return status === 'approved' || status === 'denied'
  }).length
  return {
    value: externOnly({
      ok: true,
      version: 1,
      count: store.count(),
      pending,
      expired,
      decided,
      items,
    }),
    events: [],
  }
}

// ── decide / decide_all ────────────────────────────────────────────────────

function decide(args: Rec, env: CallEnv, store: ApprovalStore): HandlerResult {
  const id = asString(args['id'])
  const verdict = asString(args['verdict'])
  const status = verdictToStatus(verdict)
  if (id === null) return { value: externOnly({ ok: false, reason: 'missing_id' }), events: [] }
  if (status === null) return { value: externOnly({ ok: false, reason: 'bad_verdict' }), events: [] }
  const target = store.get(id)
  if (target === null) return { value: externOnly({ ok: false, reason: 'not_found' }), events: [] }

  const run = env.run
  const at = asString(args['at']) ?? isoAt(nowOf(env))
  const updated: Rec = { ...target, status, decided_at: at, by: 'user' }
  store.turnOpen(run)
  store.updateItem(run, updated)
  store.turnClose(run)
  const events: ServiceEvent[] = [
    {
      topic: 'approval.decided',
      payload: {
        run: env.run,
        thread: asString(target['thread']),
        id,
        kind: asString(target['kind']),
        status,
        verdict,
      },
    },
  ]
  return {
    value: externOnly({
      ok: true,
      id,
      status,
      verdict,
      thread: asString(target['thread']),
      resume: target['resume'] ?? null,
    }),
    events,
  }
}

function decideAll(args: Rec, env: CallEnv, store: ApprovalStore): HandlerResult {
  const verdict = asString(args['verdict'])
  const status = verdictToStatus(verdict)
  if (status === null) return { value: externOnly({ ok: false, reason: 'bad_verdict' }), events: [] }
  const targets = store.itemsInOrder().filter((item) => statusOf(item) === 'pending')
  if (targets.length === 0) return { value: externOnly({ ok: false, reason: 'no_pending' }), events: [] }

  const run = env.run
  const at = asString(args['at']) ?? isoAt(nowOf(env))
  const events: ServiceEvent[] = []
  const updated = targets.map((target) => {
    events.push({
      topic: 'approval.decided',
      payload: {
        run: env.run,
        thread: asString(target['thread']),
        id: asString(target['id']),
        kind: asString(target['kind']),
        status,
        verdict,
      },
    })
    return { ...target, status, decided_at: at, by: 'user' }
  })
  store.turnOpen(run)
  store.updateItems(run, updated)
  store.turnClose(run)
  return {
    value: externOnly({
      ok: true,
      ids: targets.map((target) => target['id']),
      status,
      verdict,
      resumes: targets.map((target) => ({
        id: target['id'],
        thread: asString(target['thread']),
        resume: target['resume'] ?? null,
      })),
    }),
    events,
  }
}

// ── sweep（宿主周期方法） ───────────────────────────────────────────────────

function sweep(args: Rec, env: CallEnv, store: ApprovalStore): HandlerResult {
  const policy = approvalPolicy(args)
  const now = nowOf(env)
  const items = store.itemsInOrder()

  const expiredUpdates: Rec[] = []
  for (const item of items) {
    if (statusOf(item) !== 'pending' || policy.timeoutMs === null) continue
    const atMs = Date.parse(asString(item['at']) ?? '')
    if (!Number.isFinite(atMs) || now - atMs < policy.timeoutMs) continue
    expiredUpdates.push({ ...item, status: 'expired' })
  }

  const nonPending = items.filter((item) => statusOf(item) !== 'pending')
  const dropCount = Math.max(0, nonPending.length - policy.archiveKeep)
  const dropped = nonPending.slice(0, dropCount).map((item) => asString(item['id']) as string)

  if (expiredUpdates.length === 0 && dropped.length === 0) {
    return {
      value: externOnly({ ok: true, changed: false, expired: 0, archived: 0, retained: items.length }),
      events: [],
    }
  }

  const run = env.run
  store.turnOpen(run)
  store.updateItems(run, expiredUpdates)
  store.dropItems(run, dropped)
  store.turnClose(run)
  return {
    value: externOnly({
      ok: true,
      changed: true,
      expired: expiredUpdates.length,
      archived: dropped.length,
      retained: items.length - dropped.length,
    }),
    events: [],
  }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

export function createHandlers(deps: ApprovalDeps): Record<string, Handler> {
  return {
    enqueue: (args, env) => enqueue(requireRecord(args, 'args'), env, deps.store),
    // list 只读且不依赖参数：缺省 / null args 视为空对象（健康探针等无参调用）。
    list: (args) => list(isRecord(args) ? args : {}, deps.store),
    decide: (args, env) => decide(requireRecord(args, 'args'), env, deps.store),
    decide_all: (args, env) => decideAll(requireRecord(args, 'args'), env, deps.store),
    sweep: (args, env) => sweep(requireRecord(args, 'args'), env, deps.store),
  }
}
