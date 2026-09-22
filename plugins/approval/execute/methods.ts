// 能力类 `approval` 的五个方法：只构造写计划 + 事件，不读投影、不落账、不自取时钟。
// 调用方入口 term 读出的世界数据（队列 body / item 引用闭包 / 输入槽整份 slots）经 args 传入；
// 周期 `sweep` 的所需投影片段由宿主按 schema.periodic.reads 机械注入 bag。服务不读投影。

import { approvalPolicy } from './config.ts'
import {
  addGenOp,
  asCount,
  asString,
  buildResume,
  clearSlotsBody,
  countOf,
  defHashOf,
  externOnly,
  isoAt,
  isRecord,
  itemById,
  itemsFromChain,
  MAIN_THREAD,
  normalizeArgsRef,
  normalizeKind,
  normalizeShadow,
  nowOf,
  planOf,
  putOp,
  queueOf,
  refOf,
  refsOf,
  resolvePort,
  slotOf,
  statusOf,
  threadKeyOf,
  verdictToStatus,
} from './plan.ts'
import { BadArgsError } from './types.ts'
import type { CallEnv, Handler, HandlerResult, Json, ServiceEvent } from './types.ts'
import type { Rec } from './plan.ts'

function requireRecord(value: Json | undefined, field: string): Rec {
  if (!isRecord(value)) throw new BadArgsError(`${field} must be an object`)
  return value
}

/** 目标 item 的链上位置：`{def: <tail 哈希>}` 或 null。 */
function prevOf(queue: Rec): Json {
  const hash = defHashOf(queue['tail'])
  return hash === null ? null : refOf(hash)
}

/** 可选清槽两条 op；无 slots（不该发生）时不构造写。 */
function clearOps(slotsBody: Rec | null, threadKey: string, putIndex: number): Json[] {
  if (slotsBody === null) return []
  return [putOp(clearSlotsBody(slotsBody, threadKey)), addGenOp('input', putIndex)]
}

/** 失败收口：清本线程槽（若给了 slots）+ 结构化 extern，不产业务写。 */
function rejectWithClear(
  slotsBody: Rec | null,
  threadKey: string,
  reason: string,
): HandlerResult {
  if (slotsBody === null) {
    return { value: externOnly({ ok: false, reason }), events: [] }
  }
  const ops = clearOps(slotsBody, threadKey, 0)
  return { value: planOf(ops, { ok: false, reason }), events: [] }
}

// ── enqueue ────────────────────────────────────────────────────────────────

function enqueue(args: Rec, env: CallEnv): HandlerResult {
  const kind = normalizeKind(args['kind'])
  if (kind === null) {
    throw new BadArgsError('kind must be tool_call / orchestration_change / plugin_write')
  }
  const queue = queueOf(args)
  const refs = refsOf(args)
  const items = itemsFromChain(queue, refs)
  const policy = approvalPolicy(args)

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
  const seq = countOf(queue)
  const id = `ap-${run}-${seq}`
  const item: Rec = {
    id,
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
    prev: prevOf(queue),
  }
  const ops = [
    putOp(item),
    putOp({ ...queue, version: 1, tail: { def: { $n: 0 } }, count: seq + 1 }),
    addGenOp('approval', 1),
  ]
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
        count: seq + 1,
      },
    },
  ]
  const value = planOf(ops, { ok: true, id, count: seq + 1, pending: counted + 1 })
  return { value, events }
}

// ── list（只读） ───────────────────────────────────────────────────────────

function list(args: Rec): HandlerResult {
  const queue = queueOf(args)
  const refs = refsOf(args)
  const items = itemsFromChain(queue, refs)
  const pending = items.filter((item) => statusOf(item) === 'pending').length
  const expired = items.filter((item) => statusOf(item) === 'expired').length
  const decided = items.filter((item) => {
    const status = statusOf(item)
    return status === 'approved' || status === 'denied'
  }).length
  return {
    value: externOnly({
      ok: true,
      version: asCount(queue['version']) ?? 1,
      count: countOf(queue),
      pending,
      expired,
      decided,
      items: [...items].reverse(),
    }),
    events: [],
  }
}

// ── decide / decide_all ────────────────────────────────────────────────────

/** 从 args 或本线程 `approval.decide` 槽取裁决字段。 */
function decisionFields(
  args: Rec,
  threadKey: string,
): { id: string | null; verdict: string | null } {
  const slot = slotOf(args, threadKey)
  const slotRec = isRecord(slot) && slot['kind'] === 'approval.decide' ? slot : null
  const id = asString(args['id']) ?? (slotRec === null ? null : asString(slotRec['id']))
  const verdict = asString(args['verdict']) ?? (slotRec === null ? null : asString(slotRec['verdict']))
  return { id, verdict }
}

function decide(args: Rec, env: CallEnv): HandlerResult {
  const queue = queueOf(args)
  const refs = refsOf(args)
  const items = itemsFromChain(queue, refs)
  const threadKey = threadKeyOf(args)
  const { id, verdict } = decisionFields(args, threadKey)
  const status = verdictToStatus(verdict)
  const slotsBody = isRecord(args['slots']) ? (args['slots'] as Rec) : null
  const target = id === null ? null : itemById(items, id)
  const clearKey = asString(args['thread_id']) ?? (target === null ? null : asString(target['thread'])) ?? MAIN_THREAD

  if (id === null) return rejectWithClear(slotsBody, clearKey, 'missing_id')
  if (status === null) return rejectWithClear(slotsBody, clearKey, 'bad_verdict')
  if (target === null) return rejectWithClear(slotsBody, clearKey, 'not_found')

  const at = asString(args['at']) ?? isoAt(nowOf(env))
  const updated: Rec = { ...target, status, decided_at: at, by: 'user', prev: prevOf(queue) }
  const ops = [
    putOp(updated),
    putOp({ ...queue, version: 1, tail: { def: { $n: 0 } } }),
    addGenOp('approval', 1),
    ...clearOps(slotsBody, clearKey, 3),
  ]
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
  return { value: planOf(ops, { ok: true, id, status, verdict }), events }
}

function decideAll(args: Rec, env: CallEnv): HandlerResult {
  const queue = queueOf(args)
  const refs = refsOf(args)
  const items = itemsFromChain(queue, refs)
  const threadKey = threadKeyOf(args)
  const { verdict } = decisionFields(args, threadKey)
  const status = verdictToStatus(verdict)
  const slotsBody = isRecord(args['slots']) ? (args['slots'] as Rec) : null

  if (status === null) return rejectWithClear(slotsBody, threadKey, 'bad_verdict')
  const targets = items.filter((item) => statusOf(item) === 'pending').reverse()
  if (targets.length === 0) return rejectWithClear(slotsBody, threadKey, 'no_pending')

  const at = asString(args['at']) ?? isoAt(nowOf(env))
  const ops: Json[] = []
  const events: ServiceEvent[] = []
  let prev: Json = prevOf(queue)
  targets.forEach((target, index) => {
    ops.push(putOp({ ...target, status, decided_at: at, by: 'user', prev }))
    prev = { def: { $n: index } }
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
  })
  const bodyIndex = ops.length
  ops.push(putOp({ ...queue, version: 1, tail: { def: { $n: bodyIndex - 1 } }, count: countOf(queue) }))
  ops.push(addGenOp('approval', bodyIndex))
  ops.push(...clearOps(slotsBody, threadKey, bodyIndex + 2))
  const value = planOf(ops, { ok: true, ids: targets.map((item) => item['id']), status, verdict })
  return { value, events }
}

// ── sweep（宿主周期方法） ───────────────────────────────────────────────────

function sweep(args: Rec, env: CallEnv): HandlerResult {
  const queue = queueOf(args)
  const refs = refsOf(args)
  const items = itemsFromChain(queue, refs)
  const policy = approvalPolicy(args)
  const now = nowOf(env)
  const ordered = [...items].reverse()

  let expiredCount = 0
  const updated = ordered.map((item) => {
    if (statusOf(item) !== 'pending' || policy.timeoutMs === null) return item
    const atMs = Date.parse(asString(item['at']) ?? '')
    if (!Number.isFinite(atMs) || now - atMs < policy.timeoutMs) return item
    expiredCount += 1
    return { ...item, status: 'expired' }
  })

  const nonPending = updated.filter((item) => statusOf(item) !== 'pending')
  const dropCount = Math.max(0, nonPending.length - policy.archiveKeep)
  const dropped = new Set(nonPending.slice(0, dropCount).map((item) => asString(item['id'])))
  const kept = updated.filter(
    (item) => statusOf(item) === 'pending' || !dropped.has(asString(item['id'])),
  )

  if (expiredCount === 0 && dropCount === 0) {
    return {
      value: externOnly({ ok: true, changed: false, expired: 0, archived: 0, retained: kept.length }),
      events: [],
    }
  }

  const ops: Json[] = []
  kept.forEach((item, index) => {
    const prev = index === 0 ? null : { def: { $n: index - 1 } }
    ops.push(putOp({ ...item, prev }))
  })
  const bodyIndex = ops.length
  const tail = kept.length === 0 ? null : { def: { $n: bodyIndex - 1 } }
  ops.push(putOp({ version: 1, tail, count: countOf(queue) }))
  ops.push(addGenOp('approval', bodyIndex))
  const value = planOf(ops, {
    ok: true,
    changed: true,
    expired: expiredCount,
    archived: dropCount,
    retained: kept.length,
  })
  return { value, events: [] }
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

export const HANDLERS: Record<string, Handler> = {
  enqueue: (args, env) => enqueue(requireRecord(args, 'args'), env),
  list: (args) => list(requireRecord(args, 'args')),
  decide: (args, env) => decide(requireRecord(args, 'args'), env),
  decide_all: (args, env) => decideAll(requireRecord(args, 'args'), env),
  sweep: (args, env) => sweep(requireRecord(args, 'args'), env),
}
