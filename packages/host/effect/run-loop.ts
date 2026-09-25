// 通用 run loop：一次提交的 directives 跑到 done / refused / idle。
// 挂起 → A1 路由 → 端点调用（A7 审计）→ 回灌 results → 以同一 run_id / 同一份 directives / 同一 now 续跑。
// 轮间驱动（A10 分相 / plan 通道）在 rounds.ts；本文件只做单轮。

import { randomUUID } from 'node:crypto'
import { H, run } from '../../kernel/index.ts'
import { ServiceChannelError } from '../service-link.ts'
import type { CallEnv } from '../wire.ts'
import { buildAudit, callEffect } from './execute.ts'
import type { EndpointCaller } from './execute.ts'
import type { AuditDraft } from '../audit.ts'
import { resolveMethodTimeoutMs } from '../method-timeouts.ts'
import { WorldWriter } from '../writer.ts'
import type { WorldState } from '../writer.ts'
import { assertNotFatal, markFatal } from './fatal.ts'
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

/** 轮内物化结果：在落账段内用该段世界解析 pins / 构造 ctx / 解析命令。 */
export type RoundMaterialize = (
  state: WorldState,
) =>
  | { ok: true; directives: Directive[]; owners: Array<string | undefined> }
  | { ok: false; reason: string }

export interface RoundInput {
  /** 起始世界 / 链头：与 `writer` 二者其一（都缺或同时给出 → 抛错）。 */
  world?: World
  head?: Head
  /** 落账互斥段：内核 run 与审计提交都在它内部执行；与 `world` + `head` 二者其一。 */
  writer?: WorldWriter
  /** 已物化 directives（与 `materialize` 二选一，且不可都缺）。 */
  directives?: Directive[]
  /** 逐 directive 的发出者身份（与 directives 同序）：宿主构造 directive 时已知（A1）。 */
  owners?: ReadonlyArray<string | undefined>
  /**
   * 落账段内物化：用段内 `state.world/state.head` 解析 pins / 构造 eval ctx / 解析命令，
   * 令判定世界 = 路由世界 = 提交世界；物化失败按该轮 `refused` 收口（不冒泡成 internal）。
   * 与 `directives` 二选一。
   */
  materialize?: RoundMaterialize
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  /** 发起者：写进审计 entry 的 `by`。 */
  initiator: string
  /** 宿主对外 run id（`accepted{run}`）：审计 def 的 `run` 用它（F8 按回合查询）；缺省用内核轮 run id。 */
  runId?: string
  /** 发起者提交信封的 `thread`：只随调用帧 `env` 回带（原样、不校验）；detached / 周期 run 恒 null。 */
  thread?: string | null
  now: number
  /** A1 路由钩子；缺省时不解析端点（S1 语义：`not_loaded`）。 */
  router?: RoundRouter
  callTimeoutMs?: number
  /** 该 run 的取消信号（G2 真取消）：abort 后不再执行挂起效果，在途调用尽力中止。 */
  signal?: AbortSignal
  /**
   * 是否落审计：缺省 true。false（只读提交）时效果照常路由调用，但不构造审计草稿、
   * 不追加侧存；内核产出的业务写也不应用。
   */
  audit?: boolean
  /** 审计草稿的落点回调：同步调用（调用方负责追加进旁路侧存；抛错即致命）。 */
  onAudit?: (draft: AuditDraft) => void
  /** done 轮业务 journal 的落点回调：与内核提交同段、内存推进之前调用。 */
  onRound?: (entries: Entry[]) => void
}

export interface RoundOutcome {
  status: 'done' | 'refused' | 'idle' | 'cancelled'
  world: World
  head: Head
  journal: Entry[]
  observations: Json[]
  /** 本轮实际物化执行的 directives / owners（供轮间驱动 pickPlan）；物化失败时为空。 */
  directives: Directive[]
  owners: Array<string | undefined>
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
function makeCaller(
  input: RoundInput,
  world: World,
  index: number,
  directives: Directive[],
  owners: ReadonlyArray<string | undefined> | undefined,
): EndpointCaller | undefined {
  if (input.router === undefined || owners === undefined) return undefined
  if (index < 0) return undefined
  const directive = directives[index]
  if (directive === undefined || directive.kind !== 'eval') return undefined
  const emitter = owners[index]
  if (emitter === undefined) return undefined
  const router = input.router
  const baseTimeoutMs = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const signal = input.signal
  // 调用帧 env：本回合 run id / 发起者 thread / 宿主固定时钟（按轮固定，取轮首值）/ 发出者身份。
  // `emitter` 与审计 `emitter` 同源（都是该 directive 的属主），不另算一份。
  const env: CallEnv = {
    run: input.runId ?? null,
    thread: input.thread ?? null,
    now: input.now,
    emitter,
  }
  return async (eff: EffRequest): Promise<EffResult> => {
    const routed = router.resolve(world, emitter, eff.port, eff.method)
    if (!routed.ok) return { ok: false, error: routed.error }
    // 等待上限按**目标身份**的 schema 方法级声明覆盖；无声明回落到进程级 / 常量。
    // 解析世界与路由同代：路由注入 liveWorld 时按活世界解析，超时声明也取同一 getter 的结果。
    const resolutionWorld = router.resolutionWorld?.(world) ?? world
    const timeoutMs =
      resolveMethodTimeoutMs(resolutionWorld, routed.row.impl, eff.port, eff.method) ??
      baseTimeoutMs
    try {
      const response = await routed.row.link.call(
        eff.port,
        eff.method,
        eff.args,
        timeoutMs,
        signal,
        env,
      )
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
  assertNotFatal()
  const runId = randomUUID()
  const writer = resolveWriter(input)
  if ((input.directives === undefined) === (input.materialize === undefined)) {
    throw new Error('runRound: provide exactly one of directives or materialize')
  }
  const results: Record<Hash, EffResult> = {}
  let suspensions = 0
  let located = -1
  let emissionsInDirective = 0
  // 物化结果：materialize 模式在首个落账段内解析一次，后续挂起步骤复用（ctx 该轮只构造一次）
  let prepared: { directives: Directive[]; owners: Array<string | undefined> } | null = null
  // 取消判定包一层：signal 是外部可变对象，裸比较会被 TS 按前一次判定收窄（假阴性）
  const aborted = (): boolean => input.signal?.aborted === true
  const resolvedDirectives = (): Directive[] => prepared?.directives ?? input.directives ?? []
  const resolvedOwners = (): Array<string | undefined> =>
    prepared?.owners ?? (input.owners === undefined ? [] : [...input.owners])
  /**
   * 落账：先追加账本，失败即标记致命并抛出——不允许「落盘失败后内存照推进」导致分叉。
   * 抛出的异常会穿透 writer.run，run 整体失败；致命态由 `fatal.ts` 拒绝后续提交。
   */
  const persist = (write: () => void): void => {
    try {
      write()
    } catch (err) {
      markFatal(err)
      throw err
    }
  }
  const finish = (
    status: RoundOutcome['status'],
    journal: Entry[],
    observations: Json[],
  ): RoundOutcome => {
    const snap = writer.snapshot()
    return {
      status,
      world: snap.world,
      head: snap.head,
      journal,
      observations,
      directives: resolvedDirectives(),
      owners: resolvedOwners(),
    }
  }
  for (let step = 0; step < MAX_SUSPENSIONS; step++) {
    if (aborted()) {
      // 挂起前已取消（含排到该 run 才轮到的取消）：不跑内核、不落审计 —— 该 run 整体丢弃
      return finish('cancelled', [], [])
    }
    // 内核 run 与 done 落账同段：段内无 await，expect_pos 不会与并发提交交错。
    // 段内当前 world 即本 run 锚定的世界视图：路由用它，而不是段后可能已被并发推进的快照。
    const stepped = await writer.run((state) => {
      const anchored = state.world
      // 段内复核取消：signal 是外部可变对象，排到本段才被 abort 的 run 不得落该轮业务写
      if (aborted()) return { kind: 'cancelled' as const, anchored }
      if (input.materialize !== undefined && prepared === null) {
        const made = input.materialize({ world: state.world, head: state.head })
        if (!made.ok) {
          return { kind: 'refused' as const, reason: made.reason, anchored }
        }
        prepared = { directives: made.directives, owners: made.owners }
      }
      const directives = prepared?.directives ?? input.directives
      if (directives === undefined) {
        throw new Error('runRound: provide directives or materialize')
      }
      // 同轮至多一条 write：`anchorWrites` 给同轮所有 write 锚同一 expect_pos，第二条必 pos_conflict。
      // 分相（rounds.splitPhases）保证每条 write 独占一轮；此处对直接调用 fail-closed。
      if (directives.filter((directive) => directive.kind === 'write').length > 1) {
        return { kind: 'refused' as const, reason: 'bad_directive', anchored }
      }
      const result = run({
        world: state.world,
        head: state.head,
        run: runId,
        directives: anchorWrites(directives, state.head.hash),
        results,
        limits: input.limits,
        caps: input.caps,
        now: input.now,
      })
      // 只读（audit:false）不应用任何写：内核产出的 journal 照常上浮，由轮间驱动判定只读违例；
      // 此处不写世界、不推进 head、不回调落账。
      if (result.status === 'done' && input.audit !== false) {
        // 先回调落盘，成功后推进内存世界 / 链头；落盘失败即致命（见 persist）
        persist(() => input.onRound?.(result.journal))
        state.world = result.world
        state.head = result.head
      }
      return { kind: 'ran' as const, result, anchored }
    })
    if (stepped.kind === 'cancelled') {
      return finish('cancelled', [], [])
    }
    if (stepped.kind === 'refused') {
      return finish('refused', [], [{ kind: 'refused', reasons: [stepped.reason] }])
    }
    const out = stepped.result
    if (out.status !== 'waiting') {
      return finish(out.status, out.journal, out.observations)
    }
    const eff = out.pending as EffRequest
    const completed = out.observations.length
    const hintN = located === completed ? emissionsInDirective : 0
    const found = locateDirective(
      runId,
      eff.id,
      resolvedDirectives(),
      suspensions,
      completed,
      hintN,
    )
    if (found === null) {
      located = -1
      emissionsInDirective = 0
    } else {
      located = found.index
      emissionsInDirective = found.n + 1
    }
    const caller = makeCaller(
      input,
      stepped.anchored,
      found === null ? -1 : found.index,
      resolvedDirectives(),
      resolvedOwners(),
    )
    // 服务调用在互斥段之外：多个 run 的效果等待可并发
    const { result, cancelled } = await callEffect(eff, caller, input.signal)
    if (input.audit === false) {
      // 只读：效果照常回灌，但不落审计；取消语义保持（aborted 时按 cancelled 收口）
      results[eff.id] = result
      if (aborted() && result.error === 'cancelled') {
        return finish('cancelled', [], out.observations)
      }
      suspensions += 1
      continue
    }
    // 审计走旁路侧存：不碰世界 / 链头，故不进落账互斥段；追加是同步单写者，不会与并发交错。
    // 追加失败即致命（persist）：不允许「侧存写失败后仍继续」导致审计缺档。
    const draft = buildAudit(
      eff,
      {
        by: input.initiator,
        now: input.now,
        run: input.runId ?? runId,
        emitter: found === null ? undefined : resolvedOwners()[found.index],
      },
      result,
      cancelled,
    )
    if (input.onAudit !== undefined) persist(() => input.onAudit?.(draft))
    results[eff.id] = result
    if (aborted() && result.error === 'cancelled') {
      // 在途取消：审计已按 cancelled 落侧存；不续跑 —— 丢弃该 run 的剩余计划
      return finish('cancelled', [], out.observations)
    }
    suspensions += 1
  }
  return finish('refused', [], [{ kind: 'refused', reasons: ['too_many_suspensions'] }])
}
