// A10 轮间驱动：done → 落账回调 → plan 通道（保留包装 `{"$directives":[...]}`）→ 分相 → 下一轮。
// 分相：eval 连续段（可并一轮，extern 随邻）与 write（每条一轮）不共轮，保序、不重排 plan 语义。
// 机械填字段：id / by / ref（紧邻 eval 段最后一条 eff 的审计键）/ expect_pos（落账段内锚到当前链头）；
// 结构 op 的 pins 按「名 → 被依赖身份 active 世代 payload 哈希」解析（与 A0 同路）。
// eval 的 ctx（A14）：字段缺省 ⇒ 该轮轮首投影（含 eval 的轮构造一次、该轮共享）；显式给出（含 null）⇒ 原样透传。
// plan 条目 eval 可写命令名代替入口哈希：宿主按命令声明解析入口（与命令面同路），属主即命令声明方。

import { randomUUID } from 'node:crypto'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { resolveWriter, runRound } from './run-loop.ts'
import type { WorldWriter } from '../writer.ts'
import type { RoundRouter } from './route.ts'
import type {
  Directive,
  Entry,
  Hash,
  Head,
  Json,
  Op,
  World,
  WriteRequest,
} from '../../kernel/index.ts'

type Rec = { [k: string]: Json }

/**
 * 宿主侧 eval 草稿：`ctx` 字段**可缺省**——缺省 ⇒ 轮首投影；显式给出（含 null）⇒ 原样透传。
 * 入口二选一：`entry` 哈希，或 `command` 命令名（宿主按命令声明解析成入口，属主即声明方）；二者不可并存、不可都缺。
 */
export type EvalDraft =
  | { kind: 'eval'; entry: Hash; args: Json; ctx?: Json }
  | { kind: 'eval'; command: string; args: Json; ctx?: Json }

/** 宿主侧 directive 输入：入站提交与 plan 物化同形（write 的 request 由宿主在分组物化时机械重填）。 */
export type DirectiveDraft =
  EvalDraft | { kind: 'extern'; payload: Json } | { kind: 'write'; request: WriteRequest }

/** 投影 provider：按该轮轮首的 world / head 构造；effect 不 import projection，由宿主注入。 */
export type CtxProvider = (world: World, head: Head) => Json

const OPS: ReadonlySet<string> = new Set([
  'put',
  'add_identity',
  'add_gen',
  'set_active',
  'retire',
  'fork',
  'graft',
  'batch',
  'note',
  'snapshot',
])

/** 携带来源标记的 directive：plan 产出的写由宿主重填 id / by（发起者），入站提交的保留作者给的幂等键。
 *  owner = A1 发出者（宿主构造 directive 时已知：命令入口属主，plan 条目继承产出者属主）。 */
interface StagedDirective {
  directive: DirectiveDraft
  fromPlan: boolean
  owner?: string
}

export interface SubmissionInput {
  /** 起始世界 / 链头：与 `writer` 二者其一（都缺或同时给出 → 抛错）。 */
  world?: World
  head?: Head
  /** 落账互斥段：所有内核提交与审计落账都经它串行；与 `world` + `head` 二者其一。 */
  writer?: WorldWriter
  directives: DirectiveDraft[]
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  initiator: string
  /** 宿主对外 run id（`accepted{run}`）：审计 def 的 `run` 用它（F8 按回合查询）；缺省用内核轮 run id。 */
  runId?: string
  /** 发起者提交信封的 `thread`：只随调用帧 `env` 回带（原样、不校验）；detached / 周期 run 恒 null。 */
  thread?: string | null
  /** 每轮取一次 `now`（每轮独立、非回退）。 */
  now: () => number
  router?: RoundRouter
  callTimeoutMs?: number
  /** 该 run 的取消信号（G2 真取消）：取消即丢弃剩余轮（含 plan 产出的 directives）。 */
  signal?: AbortSignal
  /** 入站直提 directive 的属主解析（如命令入口哈希 → 身份）；解析不到 → 不路由。 */
  initialOwnerOf?: (directive: DirectiveDraft) => string | undefined
  /**
   * plan 条目 eval 的命令名解析（宿主注入；effect 不认识装配）：命令名 → 入口 def + 声明方身份。
   * 解析不到 → 该次提交 `refused`（reason `unknown_command`，与命令面同码）。
   */
  resolveCommand?: (world: World, name: string) => { entry: Hash; identity: string } | undefined
  /** eval ctx 缺省时的投影 provider：每轮分组物化时按该轮轮首 world / head 构造一次。 */
  ctxFor?: CtxProvider
  /** 审计 entry 落点（在落账互斥段内调用，保证账本追加序 = 链序）。 */
  onAudit?: (entry: Entry) => void
  /** 每轮 done 的业务 journal 落点（与内核提交同段调用，保证账本追加序 = 链序）。 */
  onRound?: (entries: Entry[]) => void
  /**
   * 本次提交允许的轮数上限（缺省 `MAX_SUBMISSION_ROUNDS`）：防 plan / 自能力回路无界挂死宿主；
   * 供宿主 / 测试按需收紧，生产缺省即常量。
   */
  maxRounds?: number
  /**
   * 链头推进后的宿主钩子（A6 换代跟随）：在进入下一轮之前 await 完成——
   * 这样 plan 的后续轮与下一次提交都按新世界路由；effect 不认识装配，回调由宿主注入。
   */
  onAdvanced?: (world: World, head: Head) => Promise<void> | void
}

export interface SubmissionOutcome {
  status: 'done' | 'refused' | 'idle' | 'cancelled'
  world: World
  head: Head
  observations: Json[]
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 分相：连续 eval / extern 并一轮；每条 write 单独一轮；extern 随邻并保序。 */
function splitPhases(staged: StagedDirective[]): StagedDirective[][] {
  const groups: StagedDirective[][] = []
  let current: StagedDirective[] = []
  for (const item of staged) {
    if (item.directive.kind === 'write') {
      if (current.length > 0) groups.push(current)
      current = []
      groups.push([item])
    } else {
      current.push(item)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** plan 里的单个 directive 形态；不合 → bad_directive（整次提交按 refused 收口）。 */
function materializePlanItem(
  raw: Json,
): { ok: true; directive: DirectiveDraft } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'bad_directive' }
  switch (raw['kind']) {
    case 'eval': {
      // 入口二选一：entry 与 command 不可同条并存、也不可都缺（否则 bad_directive）
      const hasEntry = 'entry' in raw
      const hasCommand = 'command' in raw
      if (hasEntry === hasCommand) return { ok: false, reason: 'bad_directive' }
      // ctx 判定用字段存在性：缺省留给宿主投影；显式给出（含 null）原样透传
      let directive: EvalDraft
      if (hasEntry) {
        if (typeof raw['entry'] !== 'string' || raw['entry'].length === 0) {
          return { ok: false, reason: 'bad_directive' }
        }
        directive = { kind: 'eval', entry: raw['entry'], args: raw['args'] ?? null }
      } else {
        if (typeof raw['command'] !== 'string' || raw['command'].length === 0) {
          return { ok: false, reason: 'bad_directive' }
        }
        directive = { kind: 'eval', command: raw['command'], args: raw['args'] ?? null }
      }
      if ('ctx' in raw) directive.ctx = raw['ctx'] as Json
      return { ok: true, directive }
    }
    case 'extern':
      return { ok: true, directive: { kind: 'extern', payload: raw['payload'] ?? null } }
    case 'write': {
      const request = raw['request']
      if (!isRecord(request) || typeof request['op'] !== 'string' || !OPS.has(request['op'])) {
        return { ok: false, reason: 'bad_directive' }
      }
      const directive: DirectiveDraft = {
        kind: 'write',
        request: {
          id: '',
          op: request['op'] as Op,
          target: { expect_pos: null },
          args: request['args'] ?? null,
          by: '',
        },
      }
      return { ok: true, directive }
    }
    default:
      return { ok: false, reason: 'bad_directive' }
  }
}

/**
 * 方法返回的顶层计划值（`{"$directives":[...]}`）→ 宿主 directive 草稿。
 * 与 plan 通道同形同校验（`materializePlanItem`）；非计划值返回 `not_a_plan`。
 * 供 H6 定时触发直接调能力方法后落账其计划值。
 */
export function parsePlanDirectives(
  value: Json,
): { ok: true; directives: DirectiveDraft[] } | { ok: false; reason: string } {
  if (!isRecord(value) || !Array.isArray(value['$directives'])) {
    return { ok: false, reason: 'not_a_plan' }
  }
  const directives: DirectiveDraft[] = []
  for (const raw of value['$directives']) {
    const item = materializePlanItem(raw)
    if (!item.ok) return item
    directives.push(item.directive)
  }
  return { ok: true, directives }
}

/**
 * 从 run 收口的 observations 取最后一条 `refused` 观测的 `reasons`；无则空数组。
 * 供宿主 `run.finished` 事件面载荷使用（`status=refused` 时说明收口原因）。
 */
export function refusedReasons(observations: Json[]): string[] {
  for (let i = observations.length - 1; i >= 0; i--) {
    const observation = observations[i]
    if (!isRecord(observation) || observation['kind'] !== 'refused') continue
    const reasons = observation['reasons']
    if (!Array.isArray(reasons)) return []
    return reasons.filter((reason): reason is string => typeof reason === 'string')
  }
  return []
}

/**
 * plan 通道：只认顶层 eval 观测（entry ∈ 本轮已解析 eval 集合）value 里的保留包装。
 * 多个 eval 各自产计划时按观测序拼接；其余 value 一律当普通数据。
 * plan 条目的发出者继承产出它的那条 eval 的属主。
 *
 * 匹配基准是**已解析的 eval 入口**（`prepareGroup` 产出的 directive）：命令形式的 eval 入口在
 * 该阶段才由命令声明解析出来，若仍按原始 staged 草稿的 `entry` 匹配，命令形式 eval 产出的计划会被丢弃。
 */
function pickPlan(
  observations: Json[],
  directives: Directive[],
  owners: Array<string | undefined>,
): { ok: true; directives: StagedDirective[] } | { ok: false; reason: string } {
  const evals: Array<{ entry: Hash; owner: string | undefined }> = []
  directives.forEach((directive, index) => {
    if (directive.kind === 'eval') evals.push({ entry: directive.entry, owner: owners[index] })
  })
  const out: StagedDirective[] = []
  for (const observation of observations) {
    if (!isRecord(observation)) continue
    if (observation['kind'] !== 'eval' || observation['ok'] !== true) continue
    if (typeof observation['entry'] !== 'string') continue
    const producer = evals.find((item) => item.entry === observation['entry'])
    if (producer === undefined) continue
    const value = observation['value']
    if (!isRecord(value) || !Array.isArray(value['$directives'])) continue
    for (const raw of value['$directives']) {
      const item = materializePlanItem(raw)
      if (!item.ok) return item
      out.push({ directive: item.directive, fromPlan: true, owner: producer.owner })
    }
  }
  return { ok: true, directives: out }
}

/**
 * 结构 op 的 pins：值写身份名 → 解析成该身份 active 世代 payload 哈希（与 A0 同路）；
 * `batch` 递归子操作；非字符串值（如批内 `{"$n":k}` 占位）原样透传，交内核批处理。
 */
export function resolvePins(
  op: string,
  args: Json,
  world: World,
  nested = false,
): { ok: true; value: Json } | { ok: false; reason: string } {
  if (!isRecord(args)) return { ok: true, value: args }
  if (op === 'batch') {
    const ops = args['ops']
    if (!Array.isArray(ops)) return { ok: true, value: args }
    const resolvedOps: Json[] = []
    for (const sub of ops) {
      if (!isRecord(sub) || typeof sub['op'] !== 'string' || !('args' in sub)) {
        return { ok: false, reason: 'bad_directive' }
      }
      const subArgs = resolvePins(sub['op'], sub['args'] as Json, world, true)
      if (!subArgs.ok) return subArgs
      const next: Rec = { ...sub, args: subArgs.value }
      resolvedOps.push(next)
    }
    return { ok: true, value: { ...args, ops: resolvedOps } }
  }
  if (op !== 'add_gen' && op !== 'graft' && op !== 'put') return { ok: true, value: args }
  const pins = args['pins']
  if (!isRecord(pins)) return { ok: true, value: args }
  const resolved: Rec = {}
  for (const [name, value] of Object.entries(pins)) {
    if (typeof value !== 'string') {
      resolved[name] = value // 批内占位符 / 已达 def 键的非名字值：不解释，原样给内核
      continue
    }
    // 保留能力类 `host`：内核只在 batch 子操作里不递归校验，顶层结构 op 带它会被判 bad_form；
    // 顶层提前拒（bad_directive），batch 子操作保留字面量交内核批处理。
    if (value === HOST_CAPABILITY) {
      if (!nested) return { ok: false, reason: 'bad_directive' }
      resolved[name] = HOST_CAPABILITY
      continue
    }
    const dependency = world.ids[value]
    if (dependency === undefined || dependency.active === null) {
      return { ok: false, reason: 'unresolved_pin' }
    }
    resolved[name] = dependency.active
  }
  return { ok: true, value: { ...args, pins: resolved } }
}

/** 机械填字段；plan 写覆盖 id / by，入站写缺省补齐；eval 的 ctx 缺省填该轮投影（构造一次、该轮共享）。 */
function prepareGroup(
  group: StagedDirective[],
  context: {
    head: Head
    ref: Hash | null
    initiator: string
    world: World
    ctxFor?: CtxProvider
    resolveCommand?: (world: World, name: string) => { entry: Hash; identity: string } | undefined
  },
):
  | { ok: true; directives: Directive[]; owners: Array<string | undefined> }
  | { ok: false; reason: string } {
  const directives: Directive[] = []
  const owners: Array<string | undefined> = []
  let roundCtx: Json | undefined
  // 按需构造：仅当该组确有缺省 ctx 的 eval 时才算（write 组不构造）；该组（= 该轮）共享同一份。
  // provider 缺席时 eval 缺省 ctx 无值可填：宿主接线缺陷，立即抛错（不得静默退化成 null）。
  const ctxOf = (): Json => {
    if (roundCtx === undefined) {
      if (context.ctxFor === undefined) {
        throw new Error('ctxFor required when eval ctx is absent')
      }
      const built = context.ctxFor(context.world, context.head)
      if (built === undefined) throw new Error('ctxFor returned undefined')
      roundCtx = built
    }
    return roundCtx
  }
  for (const item of group) {
    if (item.directive.kind === 'eval') {
      // 命令形式：按命令声明解析入口，属主 = 命令声明方（该 eval 发出的 eff 按声明方 pins 路由）
      let entry: Hash
      let owner = item.owner
      if ('command' in item.directive) {
        const resolved = context.resolveCommand?.(context.world, item.directive.command)
        if (resolved === undefined) return { ok: false, reason: 'unknown_command' }
        entry = resolved.entry
        owner = resolved.identity
      } else {
        entry = item.directive.entry
      }
      // 字段存在性判定（JSON 值只能是 null / 其它，非 undefined）：缺省 ⇒ 投影；显式（含 null）⇒ 原样
      const explicit = item.directive.ctx
      const evalDirective: Extract<Directive, { kind: 'eval' }> =
        explicit !== undefined
          ? { kind: 'eval', entry, args: item.directive.args, ctx: explicit }
          : { kind: 'eval', entry, args: item.directive.args, ctx: ctxOf() }
      directives.push(evalDirective)
      owners.push(owner)
      continue
    }
    if (item.directive.kind === 'extern') {
      directives.push(item.directive)
      owners.push(item.owner)
      continue
    }
    const source = item.directive.request
    // 入站畸形 request（缺 op / 非对象）：按 bad_directive 拒，不让 TypeError 冒泡成 internal
    if (
      !isRecord(source as unknown as Json) ||
      typeof source.op !== 'string' ||
      !OPS.has(source.op)
    ) {
      return { ok: false, reason: 'bad_directive' }
    }
    const args = resolvePins(source.op, source.args, context.world)
    if (!args.ok) return args
    const generated = item.fromPlan || typeof source.id !== 'string' || source.id.length === 0
    const by =
      item.fromPlan || typeof source.by !== 'string' || source.by.length === 0
        ? context.initiator
        : source.by
    const request: WriteRequest = {
      id: generated ? `w-${randomUUID()}` : source.id,
      op: source.op,
      // 占位：并发提交下轮首头会前进，expect_pos 由 run-loop 在落账段内锚到当前链头
      target: { expect_pos: null },
      args: args.value,
      by,
    }
    if (context.ref !== null) request.ref = context.ref
    directives.push({ kind: 'write', request })
    owners.push(undefined)
  }
  return { ok: true, directives, owners }
}

/**
 * 单次提交允许的轮数上限：plan 可逐层递归产 directive，自能力 eff 又能让服务回计划再次 eff 自己——
 * 无界即成环挂死宿主。正常远低于此；超限以 `refused` 收口（reason `too_many_rounds`）。
 */
export const MAX_SUBMISSION_ROUNDS = 10_000

/**
 * 跑一次入站提交：初始 directives 分相执行；每轮 done 后取 plan 产出的 directives
 * 插在剩余轮之前（= 保序：该 eval 的判定立即生效），继续到穷尽 / refused / idle。
 */
export async function runSubmission(input: SubmissionInput): Promise<SubmissionOutcome> {
  const writer = resolveWriter(input)
  const observations: Json[] = []
  if (input.directives.length === 0) {
    const snap = writer.snapshot()
    return { status: 'idle', world: snap.world, head: snap.head, observations }
  }
  const pending = splitPhases(
    input.directives.map((directive) => ({
      directive,
      fromPlan: false,
      owner: input.initialOwnerOf?.(directive),
    })),
  )
  let ref: Hash | null = null
  let rounds = 0
  const maxRounds = input.maxRounds ?? MAX_SUBMISSION_ROUNDS
  while (pending.length > 0) {
    if (input.signal?.aborted === true) {
      // 取消即丢弃剩余轮（含 plan 产出的 directives）；已落账内容不回溯
      const snap = writer.snapshot()
      return { status: 'cancelled', world: snap.world, head: snap.head, observations }
    }
    if (rounds >= maxRounds) {
      // plan 自产指令成环（含自能力 eff 回计划）：有界收口，不挂死宿主
      observations.push({ kind: 'refused', reasons: ['too_many_rounds'] })
      const snap = writer.snapshot()
      return { status: 'refused', world: snap.world, head: snap.head, observations }
    }
    rounds += 1
    const group = pending.shift() as StagedDirective[]
    const roundStart = writer.snapshot()
    const prepared = prepareGroup(group, {
      head: roundStart.head,
      ref,
      initiator: input.initiator,
      world: roundStart.world,
      ctxFor: input.ctxFor,
      resolveCommand: input.resolveCommand,
    })
    if (!prepared.ok) {
      observations.push({ kind: 'refused', reasons: [prepared.reason] })
      const snap = writer.snapshot()
      return { status: 'refused', world: snap.world, head: snap.head, observations }
    }
    const out = await runRound({
      writer,
      directives: prepared.directives,
      owners: prepared.owners,
      caps: input.caps,
      limits: input.limits,
      initiator: input.initiator,
      runId: input.runId,
      thread: input.thread,
      now: input.now(),
      router: input.router,
      callTimeoutMs: input.callTimeoutMs,
      signal: input.signal,
      onAudit: input.onAudit,
      onRound: input.onRound,
    })
    observations.push(...out.observations)
    if (out.status !== 'done') {
      // refused / idle / cancelled：本轮 waiting 期间的审计已直写推进 world / head，必须回灌（A7/A9）
      return { status: out.status, world: out.world, head: out.head, observations }
    }
    // 业务 journal 已由 runRound 在落账段内追加并推进 writer；此处只做换代跟随
    if (input.onAdvanced !== undefined) await input.onAdvanced(out.world, out.head)
    if (group.some((item) => item.directive.kind === 'eval')) ref = out.lastAuditHash
    const plan = pickPlan(out.observations, prepared.directives, prepared.owners)
    if (!plan.ok) {
      observations.push({ kind: 'refused', reasons: [plan.reason] })
      const snap = writer.snapshot()
      return { status: 'refused', world: snap.world, head: snap.head, observations }
    }
    if (plan.directives.length > 0) {
      pending.unshift(...splitPhases(plan.directives))
    }
  }
  const snap = writer.snapshot()
  return { status: 'done', world: snap.world, head: snap.head, observations }
}
