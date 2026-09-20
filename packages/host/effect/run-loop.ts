// 通用 run loop：一次提交的 directives 跑到 done / refused / idle。
// 挂起 → A1 路由 → 端点调用（A7 审计）→ 回灌 results → 以同一 run_id / 同一份 directives / 同一 now 续跑。
// 轮间驱动（A10 分相 / plan 通道）在 rounds.ts；本文件只做单轮。

import { randomUUID } from 'node:crypto'
import { H, run } from '../../kernel/index.ts'
import { ServiceChannelError } from '../service-link.ts'
import { callEffect, commitAudit } from './execute.ts'
import type { EndpointCaller } from './execute.ts'
import { WorldWriter } from '../writer.ts'
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
  /** 起始世界 / 链头：与 `writer` 二者其一（都缺或同时给出 → 抛错）。 */
  world?: World
  head?: Head
  /** 落账互斥段：内核 run 与审计提交都在它内部执行；与 `world` + `head` 二者其一。 */
  writer?: WorldWriter
  directives: Directive[]
  /** 逐 directive 的发出者身份（与 directives 同序）：宿主构造 directive 时已知（A1）。 */
  owners?: ReadonlyArray<string | undefined>
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  /** 发起者：写进审计 entry 的 `by`。 */
  initiator: string
  /** 宿主对外 run id（`accepted{run}`）：审计 def 的 `run` 用它（F8 按回合查询）；缺省用内核轮 run id。 */
  runId?: string
  now: number
  /** A1 路由钩子；缺省时不解析端点（S1 语义：`not_loaded`）。 */
  router?: RoundRouter
  callTimeoutMs?: number
  /** 该 run 的取消信号（G2 真取消）：abort 后不再执行挂起效果，在途调用尽力中止。 */
  signal?: AbortSignal
  /** 审计 entry 的落点回调：在落账互斥段内调用（调用方负责追加进账本）。 */
  onAudit?: (entry: Entry) => void
  /** done 轮业务 journal 的落点回调：与内核提交同段调用，保证账本追加序 = 链序。 */
  onRound?: (entries: Entry[]) => void
}

export interface RoundOutcome {
  status: 'done' | 'refused' | 'idle' | 'cancelled'
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
 * 落账段来源：`writer`（多 run 并发时宿主传入）或 `world` + `head` 二者其一。
 * 同时给出或都缺都是接线缺陷：立即抛错，不静默取一（否则并发下可能悄悄用了错误的世界视图）。
 */
export function resolveWriter(input: {
  world?: World
  head?: Head
  writer?: WorldWriter
}): WorldWriter {
  if (input.writer !== undefined) {
    if (input.world !== undefined || input.head !== undefined) {
      throw new Error('provide either writer or world+head, not both')
    }
    return input.writer
  }
  if (input.world === undefined || input.head === undefined) {
    throw new Error('provide either writer or both world and head')
  }
  return new WorldWriter({ world: input.world, head: input.head })
}

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
  const signal = input.signal
  return async (eff: EffRequest): Promise<EffResult> => {
    const routed = router.resolve(world, emitter, eff.port, eff.method)
    if (!routed.ok) return { ok: false, error: routed.error }
    try {
      const response = await routed.row.link.call(eff.port, eff.method, eff.args, timeoutMs, signal)
      if (response.ok) return { ok: true, value: response.value }
      return { ok: true, value: { error: response.code, message: response.message } }
    } catch (err) {
      // 取消（不再等待）与传输失败分列：前者 outcome 记 cancelled，后者 transport_failed
      if (err instanceof ServiceChannelError && err.code === 'cancelled') {
        return { ok: false, error: 'cancelled' }
      }
      return { ok: false, error: 'transport_failed' }
    }
  }
}

/** 把每条 write directive 的 `expect_pos` 机械锚到当前链头：并发提交下轮首头会前进。 */
function anchorWrites(directives: Directive[], headHash: Hash | null): Directive[] {
  return directives.map((directive) => {
    if (directive.kind !== 'write') return directive
    return {
      kind: 'write',
      request: { ...directive.request, target: { expect_pos: headHash } },
    }
  })
}

/** 跑一轮：同一 run_id / now，results 只增不改；审计在挂起期间即时落链。 */
export async function runRound(input: RoundInput): Promise<RoundOutcome> {
  const runId = randomUUID()
  const writer = resolveWriter(input)
  const results: Record<Hash, EffResult> = {}
  let lastAuditHash: Hash | null = null
  let suspensions = 0
  let located = -1
  let emissionsInDirective = 0
  // 取消判定包一层：signal 是外部可变对象，裸比较会被 TS 按前一次判定收窄（假阴性）
  const aborted = (): boolean => input.signal?.aborted === true
  for (let step = 0; step < MAX_SUSPENSIONS; step++) {
    if (aborted()) {
      // 挂起前已取消（含排到该 run 才轮到的取消）：不跑内核、不落审计 —— 该 run 整体丢弃
      const snap = writer.snapshot()
      return {
        status: 'cancelled',
        world: snap.world,
        head: snap.head,
        journal: [],
        observations: [],
        lastAuditHash,
      }
    }
    // 内核 run 与 done 落账同段：段内无 await，expect_pos 不会与并发提交交错。
    // 段内当前 world 即本 run 锚定的世界视图：路由用它，而不是段后可能已被并发推进的快照。
    const stepped = await writer.run((state) => {
      const anchored = state.world
      const result = run({
        world: state.world,
        head: state.head,
        run: runId,
        directives: anchorWrites(input.directives, state.head.hash),
        results,
        limits: input.limits,
        caps: input.caps,
        now: input.now,
      })
      if (result.status === 'done') {
        state.world = result.world
        state.head = result.head
        input.onRound?.(result.journal)
      }
      return { result, anchored }
    })
    const out = stepped.result
    if (out.status !== 'waiting') {
      const snap = writer.snapshot()
      return {
        status: out.status,
        world: snap.world,
        head: snap.head,
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
    const caller = makeCaller(input, stepped.anchored, found === null ? -1 : found.index)
    // 服务调用在互斥段之外：多个 run 的效果等待可并发
    const { result, cancelled } = await callEffect(eff, caller, input.signal)
    // 审计落账进互斥段：与内核提交共享同一链头 CAS，账本追加序 = 链序
    const executed = await writer.run((state) => {
      const outcome = commitAudit(
        eff,
        state.world,
        state.head,
        {
          by: input.initiator,
          now: input.now,
          run: input.runId ?? runId,
          emitter: found === null ? undefined : input.owners?.[found.index],
        },
        result,
        cancelled,
      )
      state.world = outcome.world
      state.head = outcome.head
      if (outcome.auditEntry !== null && input.onAudit !== undefined) {
        input.onAudit(outcome.auditEntry)
      }
      return outcome
    })
    results[eff.id] = executed.result
    if (executed.auditHash !== null) lastAuditHash = executed.auditHash
    if (aborted() && executed.result.error === 'cancelled') {
      // 在途取消：审计已按 cancelled 落账；不续跑 —— 丢弃该 run 的剩余计划
      const snap = writer.snapshot()
      return {
        status: 'cancelled',
        world: snap.world,
        head: snap.head,
        journal: [],
        observations: out.observations,
        lastAuditHash,
      }
    }
    suspensions += 1
  }
  const snap = writer.snapshot()
  return {
    status: 'refused',
    world: snap.world,
    head: snap.head,
    journal: [],
    observations: [{ kind: 'refused', reasons: ['too_many_suspensions'] }],
    lastAuditHash,
  }
}
