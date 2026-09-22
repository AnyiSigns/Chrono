// 能力类 `ui-settings` 的方法表：ping 占位 + 三个模型命令的服务侧装配/桥接 + 编排健康判定。
// 判定与装配住服务（内核 term 语言无对象构造 / 无算术，见 docs/kernel.md §十三），入口 term 只读投影随 args 传入。
// 服务不读投影、不发 eff；跨插件经宿主反向调用（`port.call`，docs/protocol.md §2.4）——宿主按发出者 pins 路由。
// 只返回值 / 计划（`$directives`），不落账、不自取时钟。

import { addGenOp, externOnly, isRecord, planOf, putOp } from './plan.ts'
import type { PortCaller, PortOutcome } from './port-link.ts'
import type { Json, Rec } from './types.ts'

export interface CallEnv {
  run: string | null
  thread: string | null
  now: number
}

export type Handler = (args: Json, env: CallEnv) => Promise<Json> | Json

export interface HandlerDeps {
  identity: string
  model: PortCaller
  /** 记忆检索端口（pins `retrieval` → memory-retrieval）；缺省回落 `model`（单测便利）。 */
  retrieval?: PortCaller
  /** 记忆维护端口（pins `memory-maintenance` → memory-consolidate）；缺省回落 `model`。 */
  maintenance?: PortCaller
}

// ── 模型命令的服务侧装配（纯函数，单测直调）──

/** 收集厂商模板 body（`#4–10`）：`ids` 里 `vendor-*` 键的 `.body`。 */
export function collectVendorBodies(ids: Json): Json[] {
  if (!isRecord(ids)) return []
  const list: Json[] = []
  for (const identity of Object.keys(ids).sort()) {
    if (!identity.startsWith('vendor-')) continue
    const entry = ids[identity]
    const body = isRecord(entry) && isRecord(entry['body']) ? entry['body'] : null
    if (body !== null) list.push({ identity, body })
  }
  return list
}

/** `model.vendors` 入参：`{vendors:[{identity, body}]}`（model-protocol 的 `collectVendorBodies` 口径）。 */
export function assembleVendorArgs(ids: Json): Rec {
  return { vendors: collectVendorBodies(ids) }
}

/** 从 `ids.config.body` 取 config；缺失回 null。 */
export function configOf(ids: Json): Rec | null {
  if (!isRecord(ids)) return null
  const config = ids['config']
  if (!isRecord(config) || !isRecord(config['body'])) return null
  return config['body']
}

/**
 * `model.profile` 入参：`{vendor, ids, config, vendors}`。
 * vendor / ids 从 `#2 config` 的当前选择与已勾选模型读出；厂商模板 body 从 `#4–10` 读出。
 */
export function assembleProfileArgs(ids: Json): { ok: true; args: Rec } | { ok: false; code: string } {
  const config = configOf(ids)
  if (config === null) return { ok: false, code: 'profile_no_config' }
  const vendor = config['vendor']
  if (typeof vendor !== 'string' || vendor.length === 0) return { ok: false, code: 'profile_no_vendor' }
  const providers = isRecord(config['providers']) ? (config['providers'] as Rec) : {}
  const provider = isRecord(providers[vendor]) ? (providers[vendor] as Rec) : null
  const models = provider !== null && isRecord(provider['models']) ? (provider['models'] as Rec) : {}
  const selected = Object.keys(models)
  return {
    ok: true,
    args: { vendor, ids: selected, config, vendors: collectVendorBodies(ids) },
  }
}

/** 从输入槽 body 取 `model.probe` 载荷（`ctx.ids.input.body.slots._main`）；非探测槽回 null。 */
export function probeOf(inputBody: Json): Rec | null {
  if (!isRecord(inputBody) || !isRecord(inputBody['slots'])) return null
  const slot = (inputBody['slots'] as Rec)['_main']
  if (!isRecord(slot) || slot['kind'] !== 'model.probe') return null
  return slot
}

/** `model.discover` 入参：`{url, auth_ref, protocol?}`；缺 url / auth_ref 回 null。 */
export function assembleDiscoverArgs(inputBody: Json): Rec | null {
  const probe = probeOf(inputBody)
  if (probe === null) return null
  const url = probe['url']
  const authRef = probe['auth_ref']
  if (typeof url !== 'string' || url.length === 0) return null
  if (!isRecord(authRef)) return null
  const args: Rec = { url, auth_ref: authRef }
  if (typeof probe['protocol'] === 'string' && probe['protocol'].length > 0) args['protocol'] = probe['protocol']
  return args
}

/**
 * 清 `model.probe` 槽的整份输入 body：只把 `_main` 置 `{kind:'idle'}`，其余线程键原样。
 * 与读取契约「写回者 = 消费该槽的写类命令的终局计划」一致。
 */
export function clearSlotBody(inputBody: Json): Rec {
  const base: Rec = isRecord(inputBody) ? { ...inputBody } : {}
  const slots: Rec = isRecord(base['slots']) ? { ...(base['slots'] as Rec) } : {}
  slots['_main'] = { kind: 'idle' }
  base['slots'] = slots
  return base
}

// ── 记忆 tab 的服务侧装配（纯函数，单测直调）──
// 三条记忆命令的入口 term 只传投影切片（`["g",["ids"]]`；搜索传命令 args，内含 UI 侧取回的 `ids`），
// 服务把切片机械装配成 #23 `view` / `edit` 与 #22 `search` 的真实 args（含 `bag.memory = {body,refs}`）。

/** 从传入 args 取投影 ids：搜索命令在 `args.ids`，只读 / 写类命令 args 即 ids。 */
export function idsMapOf(args: Json): Rec {
  if (isRecord(args) && isRecord(args['ids'])) return args['ids'] as Rec
  return isRecord(args) ? args : {}
}

/** 投影里某身份的 `body`（无数据 / 代码世代回 null）。 */
export function projectionBody(ids: Json, identity: string): Rec | null {
  if (!isRecord(ids)) return null
  const entry = ids[identity]
  if (!isRecord(entry) || !isRecord(entry['body'])) return null
  return entry['body'] as Rec
}

/** 投影里某身份的 `refs`（缺失回 `{}`）。 */
export function projectionRefs(ids: Json, identity: string): Rec {
  if (!isRecord(ids)) return {}
  const entry = ids[identity]
  if (!isRecord(entry) || !isRecord(entry['refs'])) return {}
  return entry['refs'] as Rec
}

/** `memory.view` 入参：`#3` body + `#21` body / refs（#23 `view` 真实 args）。 */
export function assembleViewArgs(ids: Json): Rec {
  return {
    short_memory: projectionBody(ids, 'short-memory') ?? {},
    memory_store: projectionBody(ids, 'memory-store') ?? {},
    memory_store_refs: projectionRefs(ids, 'memory-store'),
  }
}

/** 本会话 L1 goal：`#11 current` → `#3 sessions[current].summary.goal`；缺失回 null。 */
export function currentSessionGoal(ids: Json): string | null {
  const session = projectionBody(ids, 'session')
  const current =
    session !== null && typeof session['current'] === 'string' ? (session['current'] as string) : null
  if (current === null || current.length === 0) return null
  const shortMemory = projectionBody(ids, 'short-memory')
  if (shortMemory === null || !isRecord(shortMemory['sessions'])) return null
  const record = (shortMemory['sessions'] as Rec)[current]
  if (!isRecord(record) || !isRecord(record['summary'])) return null
  const goal = (record['summary'] as Rec)['goal']
  return typeof goal === 'string' && goal.length > 0 ? goal : null
}

/**
 * `memory.search` 入参：#22 `retrieval.search` 真实 bag。
 * `query` 必填；`workspace` / `tags` 走 `retrieval` 段；`limit` → `retrieval.top_k`；
 * `goal` = 本会话 L1 goal；`memory` = `#21 {body,refs}`（`bag::memory_parts` 首选形状）。
 */
export function assembleSearchBag(args: Json): { ok: true; bag: Rec } | { ok: false; code: string; message: string } {
  const record = isRecord(args) ? args : {}
  const query = typeof record['query'] === 'string' ? (record['query'] as string) : ''
  if (query.trim().length === 0) {
    return { ok: false, code: 'memory_query_required', message: 'query is required' }
  }
  const ids = idsMapOf(args)
  const bag: Rec = {
    query,
    memory: {
      body: projectionBody(ids, 'memory-store') ?? {},
      refs: projectionRefs(ids, 'memory-store'),
    },
  }
  const workspace = typeof record['workspace'] === 'string' ? (record['workspace'] as string) : ''
  if (workspace.length > 0) bag['workspace'] = workspace
  const goal = currentSessionGoal(ids)
  if (goal !== null) bag['goal'] = goal
  const retrieval: Rec = {}
  const tags = Array.isArray(record['tags'])
    ? (record['tags'] as Json[]).filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
    : []
  if (tags.length > 0) retrieval['tags'] = tags
  const limit =
    typeof record['limit'] === 'number' && Number.isInteger(record['limit']) && (record['limit'] as number) > 0
      ? (record['limit'] as number)
      : null
  if (limit !== null) retrieval['top_k'] = limit
  if (Object.keys(retrieval).length > 0) bag['retrieval'] = retrieval
  return { ok: true, bag }
}

/** `memory.edit` 槽：扫 `#1 slots` 找 `kind=memory.edit` 的槽体（多线程键取排序首个）。 */
export function findMemoryEditSlot(inputBody: Json): Rec | null {
  if (!isRecord(inputBody) || !isRecord(inputBody['slots'])) return null
  const slots = inputBody['slots'] as Rec
  for (const key of Object.keys(slots).sort()) {
    const value = slots[key]
    if (isRecord(value) && value['kind'] === 'memory.edit') return value
  }
  return null
}

/** 清 `memory.edit` 槽：把 `kind=memory.edit` 的线程键置 `idle`，其余线程键原样。 */
export function clearMemoryEditSlots(inputBody: Json): Rec {
  const base: Rec = isRecord(inputBody) ? { ...inputBody } : {}
  const slots: Rec = isRecord(base['slots']) ? { ...(base['slots'] as Rec) } : {}
  let found = false
  for (const key of Object.keys(slots)) {
    const value = slots[key]
    if (isRecord(value) && value['kind'] === 'memory.edit') {
      slots[key] = { kind: 'idle' }
      found = true
    }
  }
  if (!found) slots['_main'] = { kind: 'idle' }
  base['slots'] = slots
  return base
}

/** 槽 action 对齐 #23：`update` → `text`（#23 只认 `delete` / `pin` / `text`）。 */
export function maintenanceAction(action: Json): string | null {
  if (action === 'update') return 'text'
  if (action === 'delete' || action === 'pin' || action === 'text') return action
  return null
}

/**
 * `memory.edit` 入参：`#1` 槽 + `#3` / `#21` 投影（#23 `edit` 真实 args）。
 * 槽缺失 / action 非法回结构化失败码（调用方仍会清槽，避免残留非法槽）。
 */
export function assembleEditArgs(
  ids: Json,
  inputBody: Json,
): { ok: true; args: Rec } | { ok: false; code: string } {
  const slot = findMemoryEditSlot(inputBody)
  if (slot === null) return { ok: false, code: 'memory_edit_slot_missing' }
  const action = maintenanceAction(slot['action'])
  if (action === null) return { ok: false, code: 'memory_edit_bad_action' }
  return {
    ok: true,
    args: {
      slot,
      action,
      short_memory: projectionBody(ids, 'short-memory') ?? {},
      memory_store: projectionBody(ids, 'memory-store') ?? {},
      memory_store_refs: projectionRefs(ids, 'memory-store'),
    },
  }
}

/** 从 #23 返回的计划里抽出 batch 写子操作（无 → `[]`）。 */
export function planWriteOps(value: Json): Json[] {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return []
  for (const item of value['$directives']) {
    if (!isRecord(item) || item['kind'] !== 'write' || !isRecord(item['request'])) continue
    const request = item['request'] as Rec
    if (request['op'] !== 'batch' || !isRecord(request['args'])) continue
    const ops = (request['args'] as Rec)['ops']
    if (Array.isArray(ops)) return ops as Json[]
  }
  return []
}

/** 从计划值取最后一条 `extern` 载荷；非计划值原样返回。 */
export function planPayload(value: Json): Json {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) return value
  const directives = value['$directives'] as Json[]
  for (let index = directives.length - 1; index >= 0; index--) {
    const item = directives[index]
    if (isRecord(item) && item['kind'] === 'extern' && item['payload'] !== undefined) {
      return item['payload'] as Json
    }
  }
  return value
}

// ── 编排健康判定（纯函数，单测直调）──

/** 连续失败阈值默认（`#33 loop-policy` 未就位 / 未声明时的降级值）。 */
export const DEFAULT_REFUSAL_THRESHOLD = 3

/** `#33 thresholds` 里连续 `refused` 阈值的约定键名（#33 未建，先按此读、缺失回默认）。 */
export const THRESHOLD_KEY = 'consecutive_refused'

/** 台账列表一次最多遍历的条目数。 */
export const LEDGER_LIMIT = 200

export const HEALTH_OK = 'ok'
export const HEALTH_WARNING = 'warning'
export const HEALTH_UNHEALTHY = 'unhealthy'

/** 取一条 `{"def":hash}` 标记指向的条目体；无标记 / 缺失 → null。 */
function refEntry(projection: Json, marker: Json): Rec | null {
  if (!isRecord(projection) || !isRecord(projection['refs'])) return null
  if (!isRecord(marker) || typeof marker['def'] !== 'string') return null
  const entry = (projection['refs'] as Rec)[marker['def'] as string]
  return isRecord(entry) ? entry : null
}

/** 从尾链头沿 `prev` 逆序收集条目（含尾），最多 limit 条；防环（visited 去重）。 */
export function walkTail(projection: Json, listKey: string, limit = LEDGER_LIMIT): Rec[] {
  if (!isRecord(projection) || !isRecord(projection['body'])) return []
  const list = (projection['body'] as Rec)[listKey]
  if (!isRecord(list) || !isRecord(list['tail'])) return []
  const entries: Rec[] = []
  const visited = new Set<string>()
  let marker: Json = list['tail']
  while (isRecord(marker) && typeof marker['def'] === 'string' && entries.length < limit) {
    if (visited.has(marker['def'])) break
    visited.add(marker['def'])
    const entry = refEntry(projection, marker)
    if (entry === null) break
    entries.push(entry)
    marker = isRecord(entry['prev']) ? entry['prev'] : null
  }
  return entries
}

/** 最近连续以 `refused` 收口的回合数（从 trace 尾往前数）。 */
export function consecutiveRefused(evolution: Json, limit = LEDGER_LIMIT): number {
  let count = 0
  for (const entry of walkTail(evolution, 'trace', limit)) {
    if (entry['outcome'] === 'refused') count += 1
    else break
  }
  return count
}

/** 健康状态：达阈 unhealthy；有连续失败但未达阈 warning；否则 ok。 */
export function healthStatus(count: number, threshold: number): string {
  const bound = Number.isInteger(threshold) && threshold > 0 ? threshold : DEFAULT_REFUSAL_THRESHOLD
  if (count >= bound) return HEALTH_UNHEALTHY
  if (count > 0) return HEALTH_WARNING
  return HEALTH_OK
}

/** 最近拒绝码分布（按出现次数降序；无 `refused_at.code` 记 `refused`）。 */
export function refusalCodes(evolution: Json, limit = LEDGER_LIMIT): Rec[] {  const counts = new Map<string, number>()
  for (const entry of walkTail(evolution, 'trace', limit)) {
    if (entry['outcome'] !== 'refused') continue
    const refusedAt = isRecord(entry['refused_at']) ? (entry['refused_at'] as Rec) : null
    const code = refusedAt !== null && typeof refusedAt['code'] === 'string' ? (refusedAt['code'] as string) : 'refused'
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => (right['count'] as number) - (left['count'] as number) || (left['code'] as string < right['code'] as string ? -1 : 1))
}

/**
 * 回滚目标：编排图身份（`#33`）投影的上一数据世代 payload。
 * `gens` 为 `[{seq, payload}]`；当前 active 的前一条即上一世代；无上一世代 → null。
 */
export function rollbackTarget(projection: Json): Rec | null {
  if (!isRecord(projection) || !Array.isArray(projection['gens'])) return null
  const gens = projection['gens'] as Json[]
  const active = projection['active']
  const index = gens.findIndex((gen) => isRecord(gen) && gen['payload'] === active)
  if (index <= 0) return null
  const previous = gens[index - 1]
  if (!isRecord(previous) || typeof previous['payload'] !== 'string') return null
  return { payload: previous['payload'], seq: typeof previous['seq'] === 'number' ? previous['seq'] : index - 1 }
}

/**
 * 读 `#33 thresholds` 的连续失败阈值：`loop-policy.body.thresholds` 为整数，或为对象 / 链条目里的
 * `consecutive_refused`。缺失 / 非法回默认（#33 未建时优雅降级）。
 */
export function resolveThreshold(loopPolicy: Json): { value: number; source: 'loop-policy' | 'default' } {
  const fallback = { value: DEFAULT_REFUSAL_THRESHOLD, source: 'default' as const }
  if (!isRecord(loopPolicy) || !isRecord(loopPolicy['body'])) return fallback
  const thresholds = (loopPolicy['body'] as Rec)['thresholds']
  if (typeof thresholds === 'number' && Number.isInteger(thresholds) && thresholds > 0) {
    return { value: thresholds, source: 'loop-policy' }
  }
  if (!isRecord(thresholds)) return fallback
  const direct = thresholds[THRESHOLD_KEY]
  if (typeof direct === 'number' && Number.isInteger(direct) && direct > 0) {
    return { value: direct, source: 'loop-policy' }
  }
  // thresholds 为链索引 {tail,count}：条目体里读同一键
  const entry = refEntry(loopPolicy, thresholds['tail'] as Json)
  const fromEntry = entry === null ? undefined : entry[THRESHOLD_KEY]
  if (typeof fromEntry === 'number' && Number.isInteger(fromEntry) && fromEntry > 0) {
    return { value: fromEntry, source: 'loop-policy' }
  }
  return fallback
}

/**
 * 三条台账 tail 倒序列表（`verdicts` / `proposals` / `evidence`；采纳与拒绝都显示）。
 * 供 S13 台账渲染：入口 term 读 `ctx.ids.evolution` 投影随 args 传入，服务侧走 tail 后随健康结果回浏览器。
 */
export function ledgerLists(evolution: Json, limit = LEDGER_LIMIT): Rec {
  return {
    verdicts: walkTail(evolution, 'verdicts', limit),
    proposals: walkTail(evolution, 'proposals', limit),
    evidence: walkTail(evolution, 'evidence', limit),
  }
}

/** 结构化健康状态：连续 refused 计数 + 阈值 + 拒绝码分布 + 健康态 + 回滚目标 + 进化台账三条 tail。 */
export function judgeHealth(ids: Json): Rec {
  const evolution = isRecord(ids) ? ids['evolution'] : null
  const loopPolicy = isRecord(ids) ? ids['loop-policy'] : null
  const count = consecutiveRefused(evolution)
  const threshold = resolveThreshold(loopPolicy)
  return {
    ok: true,
    status: healthStatus(count, threshold.value),
    consecutive_refused: count,
    threshold: threshold.value,
    threshold_source: threshold.source,
    refusal_codes: refusalCodes(evolution),
    rollback: rollbackTarget(loopPolicy),
    ledger: ledgerLists(evolution),
  }
}

// ── 方法处理器 ──

function failure(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 构造方法表；`deps.model` 是反向调用通道（单测注入假端口）。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  const retrieval = deps.retrieval ?? deps.model
  const maintenance = deps.maintenance ?? deps.model
  return {
    ping: (): Json => ({ pong: true, identity: deps.identity }),

    /** 厂商模板清单：入口 term 传 `ctx.ids`，服务装配后反向调 `model.vendors`，命令结果 = 其结果。 */
    vendors: async (args): Promise<Json> => {
      const outcome = await deps.model.call('model', 'vendors', assembleVendorArgs(args))
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      return externOnly(outcome.value)
    },

    /** 模型档案：入口 term 传 `ctx.ids`，服务从 `#2 config` + `#4–10` body 装配，反向调 `model.profile`。 */
    profile: async (args): Promise<Json> => {
      const assembled = assembleProfileArgs(args)
      if (!assembled.ok) return failure(assembled.code, assembled.code)
      const outcome = await deps.model.call('model', 'profile', assembled.args)
      if (!outcome.ok) return failure(outcome.code, outcome.message)
      return outcome.value
    },

    /**
     * 模型发现：入口 term 传 `ctx.ids.input.body`，服务读 `model.probe` 槽反向调 `model.discover`，
     * 返回计划 = 清 `model.probe` 槽（无论成败）+ extern discover 结果（命令结果 = discover 结果）。
     */
    discover: async (args): Promise<Json> => {
      const inputBody = args
      const probeArgs = assembleDiscoverArgs(inputBody)
      let result: Json
      if (probeArgs === null) {
        result = failure('model_probe_missing', 'no model.probe slot payload')
      } else {
        const outcome: PortOutcome = await deps.model.call('model', 'discover', probeArgs)
        result = outcome.ok ? outcome.value : failure(outcome.code, outcome.message)
      }
      if (!isRecord(inputBody)) return externOnly(result)
      return planOf([putOp(clearSlotBody(inputBody)), addGenOp('input', 0)], result)
    },

    /** 编排健康只读视图：入口 term 传 `ctx.ids`，服务判定（不住 #33）；浏览器只渲染。 */
    health: (args): Json => judgeHealth(args),

    /**
     * 记忆浏览（只读）：入口 term 传 `ctx.ids`，服务从 `#3` body + `#21` body / refs 装配，
     * 反向调 `memory-maintenance.view`；命令结果 = #23 `view` 值（L1 / L2 / L3 三档）。
     */
    view: async (args): Promise<Json> => {
      const outcome = await maintenance.call('memory-maintenance', 'view', assembleViewArgs(idsMapOf(args)))
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      return externOnly(outcome.value)
    },

    /**
     * 记忆搜索（只读）：命令 args `{query, workspace?, tags?, limit?, ids}`（`ids` = UI 侧 `settings.identities`
     * 取回的投影），服务装配 #22 `retrieval.search` 真实 bag（`query` / `goal` / `workspace` / `retrieval` /
     * `memory={body,refs}`），反向调 `retrieval.search`；命令结果 = #22 `search` 值（`recall`）。
     */
    search: async (args): Promise<Json> => {
      const assembled = assembleSearchBag(args)
      if (!assembled.ok) return externOnly(failure(assembled.code, assembled.message))
      const outcome = await retrieval.call('retrieval', 'search', assembled.bag)
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      return externOnly(outcome.value)
    },

    /**
     * 记忆编辑（写类无参）：入口 term 传 `ctx.ids`，服务读 `memory.edit` 槽 + `#3` / `#21` 投影，
     * 反向调 `memory-maintenance.edit`；返回计划 = #23 写子操作 + 清 `memory.edit` 槽（无论成败）+
     * extern #23 结果。槽 action `update` 对齐为 #23 的 `text`。
     */
    edit: async (args): Promise<Json> => {
      const ids = idsMapOf(args)
      const inputBody = projectionBody(ids, 'input')
      const assembled = assembleEditArgs(ids, inputBody)
      let ops: Json[] = []
      let payload: Json
      if (!assembled.ok) {
        payload = failure(assembled.code, assembled.code)
      } else {
        const outcome = await maintenance.call('memory-maintenance', 'edit', assembled.args)
        if (outcome.ok) {
          ops = planWriteOps(outcome.value)
          payload = planPayload(outcome.value)
        } else {
          payload = failure(outcome.code, outcome.message)
        }
      }
      if (!isRecord(inputBody)) return externOnly(payload)
      const combined = [...ops, putOp(clearMemoryEditSlots(inputBody))]
      combined.push(addGenOp('input', combined.length - 1))
      return planOf(combined, payload)
    },
  }
}
