// A10 轮间驱动：done → 落账回调 → plan 通道（保留包装 `{"$directives":[...]}`）→ 分相 → 下一轮。
// 分相：eval 连续段（可并一轮，extern 随邻）与 write（每条一轮）不共轮，保序、不重排 plan 语义。
// 机械填字段：id / by / ref（紧邻 eval 段最后一条 eff 的审计键）/ expect_pos（该轮轮首链头）；
// 结构 op 的 pins 按「名 → 被依赖身份 active 世代 payload 哈希」解析（与 A0 同路）。
// eval 的 ctx（A14）：字段缺省 ⇒ 该轮轮首投影（含 eval 的轮构造一次、该轮共享）；显式给出（含 null）⇒ 原样透传。

import { randomUUID } from 'node:crypto'
import { runRound } from './run-loop.ts'
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

/** 宿主侧 eval 草稿：`ctx` 字段**可缺省**——缺省 ⇒ 轮首投影；显式给出（含 null）⇒ 原样透传。 */
export type EvalDraft = { kind: 'eval'; entry: Hash; args: Json; ctx?: Json }

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
  world: World
  head: Head
  directives: DirectiveDraft[]
  caps: Record<string, boolean>
  limits: { gas: number; depth: number }
  initiator: string
  /** 每轮取一次 `now`（每轮独立、非回退）。 */
  now: () => number
  router?: RoundRouter
  callTimeoutMs?: number
  /** 入站直提 directive 的属主解析（如命令入口哈希 → 身份）；解析不到 → 不路由。 */
  initialOwnerOf?: (directive: DirectiveDraft) => string | undefined
  /** eval ctx 缺省时的投影 provider：每轮分组物化时按该轮轮首 world / head 构造一次。 */
  ctxFor?: CtxProvider
  /** 审计 entry 落点（A7：挂起期间即时落链）。 */
  onAudit?: (entry: Entry) => void
  /** 每轮 done 的业务 journal 落点（A10：done 才落账）。 */
  onRound?: (entries: Entry[]) => void
}

export interface SubmissionOutcome {
  status: 'done' | 'refused' | 'idle'
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
      if (typeof raw['entry'] !== 'string' || raw['entry'].length === 0) {
        return { ok: false, reason: 'bad_directive' }
      }
      // ctx 判定用字段存在性：缺省留给宿主投影；显式给出（含 null）原样透传
      const directive: EvalDraft = {
        kind: 'eval',
        entry: raw['entry'],
        args: raw['args'] ?? null,
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

/** 取 eval 草稿的入口哈希；其余 kind 返回 undefined。 */
function entryOf(directive: DirectiveDraft): Hash | undefined {
  return directive.kind === 'eval' ? directive.entry : undefined
}

/**
 * plan 通道：只认顶层 eval 观测（entry ∈ 本轮 directive 集合）value 里的保留包装。
 * 多个 eval 各自产计划时按观测序拼接；其余 value 一律当普通数据。
 * plan 条目的发出者继承产出它的那条 eval 的属主。
 */
function pickPlan(
  observations: Json[],
  group: StagedDirective[],
): { ok: true; directives: StagedDirective[] } | { ok: false; reason: string } {
  const entries = new Set(
    group
      .map((item) => entryOf(item.directive))
      .filter((entry): entry is Hash => entry !== undefined),
  )
  const out: StagedDirective[] = []
  for (const observation of observations) {
    if (!isRecord(observation)) continue
    if (observation['kind'] !== 'eval' || observation['ok'] !== true) continue
    if (typeof observation['entry'] !== 'string' || !entries.has(observation['entry'])) continue
    const value = observation['value']
    if (!isRecord(value) || !Array.isArray(value['$directives'])) continue
    const producer = group.find((item) => entryOf(item.directive) === observation['entry'])
    for (const raw of value['$directives']) {
      const item = materializePlanItem(raw)
      if (!item.ok) return item
      out.push({ directive: item.directive, fromPlan: true, owner: producer?.owner })
    }
  }
  return { ok: true, directives: out }
}

/**
 * 结构 op 的 pins：值写身份名 → 解析成该身份 active 世代 payload 哈希（与 A0 同路）；
 * `batch` 递归子操作；非字符串值（如批内 `{"$n":k}` 占位）原样透传，交内核批处理。
 */
function resolvePins(
  op: string,
  args: Json,
  world: World,
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
      const subArgs = resolvePins(sub['op'], sub['args'] as Json, world)
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
  context: { head: Head; ref: Hash | null; initiator: string; world: World; ctxFor?: CtxProvider },
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
      // 字段存在性判定（JSON 值只能是 null / 其它，非 undefined）：缺省 ⇒ 投影；显式（含 null）⇒ 原样
      const explicit = item.directive.ctx
      const evalDirective: Extract<Directive, { kind: 'eval' }> =
        explicit !== undefined
          ? { kind: 'eval', entry: item.directive.entry, args: item.directive.args, ctx: explicit }
          : {
              kind: 'eval',
              entry: item.directive.entry,
              args: item.directive.args,
              ctx: ctxOf(),
            }
      directives.push(evalDirective)
      owners.push(item.owner)
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
      target: { expect_pos: context.head.hash },
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
 * 跑一次入站提交：初始 directives 分相执行；每轮 done 后取 plan 产出的 directives
 * 插在剩余轮之前（= 保序：该 eval 的判定立即生效），继续到穷尽 / refused / idle。
 */
export async function runSubmission(input: SubmissionInput): Promise<SubmissionOutcome> {
  const observations: Json[] = []
  let world = input.world
  let head = input.head
  if (input.directives.length === 0) {
    return { status: 'idle', world, head, observations }
  }
  const pending = splitPhases(
    input.directives.map((directive) => ({
      directive,
      fromPlan: false,
      owner: input.initialOwnerOf?.(directive),
    })),
  )
  let ref: Hash | null = null
  while (pending.length > 0) {
    const group = pending.shift() as StagedDirective[]
    const prepared = prepareGroup(group, {
      head,
      ref,
      initiator: input.initiator,
      world,
      ctxFor: input.ctxFor,
    })
    if (!prepared.ok) {
      observations.push({ kind: 'refused', reasons: [prepared.reason] })
      return { status: 'refused', world, head, observations }
    }
    const out = await runRound({
      world,
      head,
      directives: prepared.directives,
      owners: prepared.owners,
      caps: input.caps,
      limits: input.limits,
      initiator: input.initiator,
      now: input.now(),
      router: input.router,
      callTimeoutMs: input.callTimeoutMs,
      onAudit: input.onAudit,
    })
    observations.push(...out.observations)
    if (out.status !== 'done') {
      // refused / idle：本轮 waiting 期间的审计已直写推进 world / head，必须回灌（A7/A9）
      return { status: out.status, world: out.world, head: out.head, observations }
    }
    world = out.world
    head = out.head
    input.onRound?.(out.journal)
    if (group.some((item) => item.directive.kind === 'eval')) ref = out.lastAuditHash
    const plan = pickPlan(out.observations, group)
    if (!plan.ok) {
      observations.push({ kind: 'refused', reasons: [plan.reason] })
      return { status: 'refused', world, head, observations }
    }
    if (plan.directives.length > 0) {
      pending.unshift(...splitPhases(plan.directives))
    }
  }
  return { status: 'done', world, head, observations }
}
