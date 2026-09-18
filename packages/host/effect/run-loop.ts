// 通用 run loop：一次提交的 directives 跑到 done / refused / idle。
// 挂起 → A1 路由 → 端点调用（A7 审计）→ 回灌 results → 以同一 run_id / 同一份 directives / 同一 now 续跑。
// 轮间驱动（A10 分相 / plan 通道）在 rounds.ts；本文件只做单轮。

import { randomUUID } from 'node:crypto'
import { H, run } from '../../kernel/index.ts'
import { executeEffect } from './execute.ts'
import type { EndpointCaller } from './execute.ts'
import type { RoundRouter } from './route.ts'
import type {
  Directive,
  EffRequest,
  EffResult,
  Entry,
  Hash,
  Head,
  Json,
  World,
} from '../../kernel/index.ts'

/** 效果调用缺省超时；`plugin.json` 无此字段，宿主常量（调用未完成 → 传输层失败）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

export interface RoundInput {
  world: World
  head: Head
  directives: Directive[]
  /** 逐 directive 的发出者身份（与 directives 同序）：宿主构造 directive 时已知（A1）。 */
  owners?: ReadonlyArray<string | undefined>
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  /** 发起者：写进审计 entry 的 `by`。 */
  initiator: string
  now: number
  /** A1 路由钩子；缺省时不解析端点（S1 语义：`not_loaded`）。 */
  router?: RoundRouter
  callTimeoutMs?: number
  /** 审计 entry 的落点回调：调用方负责把它立即追加进账本。 */
  onAudit?: (entry: Entry) => void
}

export interface RoundOutcome {
  status: 'done' | 'refused' | 'idle'
  world: World
  head: Head
  journal: Entry[]
  observations: Json[]
  /** 本轮最后一条 eff 的审计 def 键；无 eff 时为 null（供 A10 填 `ref`）。 */
  lastAuditHash: Hash | null
}

/** 单次提交内允许的挂起次数上限：防实现缺陷导致死循环，正常远低于此。 */
const MAX_SUSPENSIONS = 100_000

/**
 * 反查 pending eff 属于哪条 directive：`eff.id = H({run, i, n})`。
 * 正常路径 O(1)：观测数即已完成 directive 数 = 挂起所在的 i；同一 directive 内 pending 的
 * n 恰为已回灌的效果数（hintN），直接重算候选比对。仅在候选不符（实现缺陷）时线性扫描兜底。
 * @returns {index, n}；无法定位返回 null（fail-closed：该效果不路由）。
 */
function locateDirective(
  runId: string,
  pendingId: Hash,
  directives: Directive[],
  suspensions: number,
  completed: number,
  hintN: number,
): { index: number; n: number } | null {
  if (
    completed >= 0 &&
    completed < directives.length &&
    H({ run: runId, i: completed, n: hintN }) === pendingId
  ) {
    return { index: completed, n: hintN }
  }
  for (let i = 0; i < directives.length; i++) {
    for (let n = 0; n <= suspensions; n++) {
      if (H({ run: runId, i, n }) === pendingId) return { index: i, n }
    }
  }
  return null
}

/** 按 A1 把 pending eff 解析到端点并调用；解析失败 / 传输失败都是数据（EffResult）。 */
function makeCaller(input: RoundInput, world: World, index: number): EndpointCaller | undefined {
  if (input.router === undefined || input.owners === undefined) return undefined
  if (index < 0) return undefined
  const directive = input.directives[index]
  if (directive.kind !== 'eval') return undefined
  const emitter = input.owners[index]
  if (emitter === undefined) return undefined
  const router = input.router
  const timeoutMs = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  return async (eff: EffRequest): Promise<EffResult> => {
    const routed = router.resolve(world, emitter, eff.port, eff.method)
    if (!routed.ok) return { ok: false, error: routed.error }
    try {
      const response = await routed.row.link.call(eff.port, eff.method, eff.args, timeoutMs)
      if (response.ok) return { ok: true, value: response.value }
      return { ok: true, value: { error: response.code, message: response.message } }
    } catch {
      return { ok: false, error: 'transport_failed' }
    }
  }
}

/** 跑一轮：同一 run_id / now，results 只增不改；审计在挂起期间即时落链。 */
export async function runRound(input: RoundInput): Promise<RoundOutcome> {
  const runId = randomUUID()
  const results: Record<Hash, EffResult> = {}
  let world = input.world
  let head = input.head
  let lastAuditHash: Hash | null = null
  let suspensions = 0
  let located = -1
  let emissionsInDirective = 0
  for (let step = 0; step < MAX_SUSPENSIONS; step++) {
    const out = run({
      world,
      head,
      run: runId,
      directives: input.directives,
      results,
      limits: input.limits,
      caps: input.caps,
      now: input.now,
    })
    if (out.status !== 'waiting') {
      return {
        status: out.status,
        world: out.world,
        head: out.head,
        journal: out.journal,
        observations: out.observations,
        lastAuditHash,
      }
    }
    const eff = out.pending as EffRequest
    const completed = out.observations.length
    const hintN = located === completed ? emissionsInDirective : 0
    const found = locateDirective(runId, eff.id, input.directives, suspensions, completed, hintN)
    if (found === null) {
      located = -1
      emissionsInDirective = 0
    } else {
      located = found.index
      emissionsInDirective = found.n + 1
    }
    const caller = makeCaller(input, world, found === null ? -1 : found.index)
    const executed = await executeEffect(eff, world, head, input.initiator, input.now, caller)
    results[eff.id] = executed.result
    world = executed.world
    head = executed.head
    if (executed.auditHash !== null) lastAuditHash = executed.auditHash
    if (executed.auditEntry !== null && input.onAudit !== undefined) {
      input.onAudit(executed.auditEntry)
    }
    suspensions += 1
  }
  return {
    status: 'refused',
    world,
    head,
    journal: [],
    observations: [{ kind: 'refused', reasons: ['too_many_suspensions'] }],
    lastAuditHash,
  }
}
