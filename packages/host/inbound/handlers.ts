// 入站 run 驱动：submit / command / forward 三路统一走 `runDirectiveSet`（解析命令 → 校验 args →
// 跑 run → 回 result），并承载宿主通用原语 `thread.resume` 起的 detached run。
// 宿主不认识命令语义，只按声明解析、机械校验、按 run 生命周期成对收口。

import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { commandArgsIssue } from '../assembly/index.ts'
import type { CommandDecl, CommandIndex } from '../assembly/index.ts'
import { refusedReasons, runSubmission } from '../effect/index.ts'
import type {
  CtxProvider,
  DirectiveDraft,
  RoundRouter,
  SubmissionOutcome,
} from '../effect/index.ts'
import { beginRun, MAX_DETACHED_RUNS, DEFAULT_LIMITS } from '../run-registry.ts'
import type { BroadcastFn, RunRegistry } from '../run-registry.ts'
import { PROTOCOL_VERSION } from '../wire.ts'
import type { InboundMessage, Limits, OutboundMessage } from '../wire.ts'
import type { AuditDraft } from '../audit.ts'
import type { LifecycleRecord } from '../lifecycle.ts'
import type { WorldWriter } from '../writer.ts'
import type { Entry, Hash, Head, Json, World } from '../../kernel/index.ts'

/** 入站面单帧发送；错误与结果帧都经它回发起者。 */
export type SendFn = (socket: Socket, message: OutboundMessage) => void

/** 命令索引解析（宿主按链头缓存）：`world + head → 命令列表与名字映射`。 */
export type CommandIndexFor = (world: World, head: Head) => CommandIndex

export interface RunDriverDeps {
  writer: WorldWriter
  registry: RunRegistry
  callTimeoutMs?: number
  send: SendFn
  /** 活路由器 getter：装配完成前为 undefined。 */
  getRouter: () => RoundRouter | undefined
  commandIndexFor: CommandIndexFor
  cachedProjection: CtxProvider
  persistAudit: (draft: AuditDraft) => void
  persistRound: (entries: Entry[]) => void
  applyWorldSerial: (world: World, head: Head) => Promise<void>
  broadcast: BroadcastFn
  safeAppendLifecycle: (record: LifecycleRecord) => void
  escalateFatal: () => void
}

export interface InboundHandlers {
  submit: (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'submit' }>,
    directives: DirectiveDraft[],
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ) => Promise<void>
  command: (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'command' }>,
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ) => Promise<void>
  forward: (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'forward' }>,
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ) => Promise<void>
  /** `thread.resume`：起一次 detached run（无 socket、结果不回流、事件照广播）。 */
  startDetachedRun: (
    emitter: string,
    entry: Hash,
    args: Json,
    thread: string | null,
  ) => { ok: true; run: string } | { ok: false; code: 'too_many_runs' }
}

interface ExecuteRunInput {
  origin: 'submit' | 'command' | 'forward'
  runId: string
  thread: string | null
  signal: AbortSignal
  directives: DirectiveDraft[]
  caps: Record<string, boolean>
  limits: Limits
  readonly: boolean
  /** 命令 / 转发目标名（事件载荷用）；submit 无。 */
  name?: string
  initialOwnerOf: (directive: DirectiveDraft) => string | undefined
  reply: (outcome: SubmissionOutcome) => void
}

export function createInboundHandlers(deps: RunDriverDeps): InboundHandlers {
  const { writer, registry } = deps

  /** plan 条目按命令名解析（注入 effect）：与命令面同路，返回入口 def + 声明方身份。 */
  const resolvePlanCommand = (
    _world: World,
    name: string,
  ): { entry: Hash; identity: string } | undefined => {
    const snapshot = writer.snapshot()
    const command = deps.commandIndexFor(snapshot.world, snapshot.head).byName.get(name)
    return command === undefined ? undefined : { entry: command.entry, identity: command.identity }
  }

  /** 三路统一核心：解析后跑一次 run，回 result，并严格成对收口 run 生命周期事件。 */
  const runDirectiveSet = async (input: ExecuteRunInput): Promise<void> => {
    const lifecycle = input.readonly
      ? undefined
      : beginRun(deps.broadcast, {
          run: input.runId,
          thread: input.thread,
          origin: input.origin,
          ...(input.name === undefined ? {} : { name: input.name }),
        })
    lifecycle?.started()
    let status = 'refused'
    let reasons: string[] = []
    try {
      const outcome = await runSubmission({
        writer,
        directives: input.directives,
        caps: input.caps,
        limits: input.limits,
        initiator: input.origin === 'submit' ? 'client' : input.origin,
        runId: input.runId,
        thread: input.thread,
        now: () => registry.nextNow(),
        router: deps.getRouter(),
        callTimeoutMs: deps.callTimeoutMs,
        signal: input.signal,
        readonly: input.readonly,
        initialOwnerOf: input.initialOwnerOf,
        resolveCommand: resolvePlanCommand,
        ctxFor: deps.cachedProjection,
        onAudit: deps.persistAudit,
        onRound: deps.persistRound,
        onAdvanced: deps.applyWorldSerial,
      })
      status = outcome.status
      reasons = refusedReasons(outcome.observations)
      // 先摘 run 再发 result：结果已定，之后 cancel 不再命中（避免 accepted 后无实际效果）
      registry.unregister(input.runId)
      input.reply(outcome)
    } catch (err) {
      deps.safeAppendLifecycle({
        at: Date.now(),
        kind: 'host',
        event: 'run_failed',
        run: input.runId,
        reason: err instanceof Error ? err.message : String(err),
      })
      deps.escalateFatal()
      throw err
    } finally {
      // run.started / run.finished 严格成对、恰好一次：异常路径也以 refused 收口
      lifecycle?.finished(status, reasons)
    }
  }

  /** 命令 args 的机械校验：坏 schema / 坏参直接回错并返回 false。 */
  const checkCommandArgs = (
    socket: Socket,
    id: string,
    command: CommandDecl,
    args: Json,
    world: World,
  ): boolean => {
    const issue = commandArgsIssue(world, command, args)
    if (issue === 'ok') return true
    deps.send(socket, {
      v: PROTOCOL_VERSION,
      id,
      kind: 'error',
      code: issue,
      message: command.name,
    })
    return false
  }

  const submit: InboundHandlers['submit'] = async (
    socket,
    message,
    directives,
    runId,
    thread,
    signal,
  ) => {
    // 入站直提 eval 的属主：命令入口哈希 → 声明身份；解析不到则不路由（不猜）
    const snapshot = writer.snapshot()
    const entryOwners = new Map<string, string>()
    for (const command of deps.commandIndexFor(snapshot.world, snapshot.head).commands) {
      if (!entryOwners.has(command.entry)) entryOwners.set(command.entry, command.identity)
    }
    await runDirectiveSet({
      origin: 'submit',
      runId,
      thread,
      signal,
      directives,
      caps: message.caps ?? {},
      limits: message.limits ?? DEFAULT_LIMITS,
      readonly: false,
      initialOwnerOf: (directive) =>
        directive.kind === 'eval' && 'entry' in directive
          ? entryOwners.get(directive.entry)
          : undefined,
      reply: (outcome) =>
        deps.send(socket, {
          v: PROTOCOL_VERSION,
          kind: 'result',
          run: runId,
          status: outcome.status,
          observations: outcome.observations,
        }),
    })
  }

  const command: InboundHandlers['command'] = async (socket, message, runId, thread, signal) => {
    if (typeof message.name !== 'string') {
      deps.send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'bad_directive',
        message: 'command name must be a string',
      })
      return
    }
    const snapshot = writer.snapshot()
    const resolved = deps.commandIndexFor(snapshot.world, snapshot.head).byName.get(message.name)
    if (resolved === undefined) {
      deps.send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'unknown_command',
        message: message.name,
      })
      return
    }
    const args = message.args ?? null
    if (!checkCommandArgs(socket, message.id, resolved, args, snapshot.world)) return
    // 只读命令：不广播 run 生命周期事件（读不得成为回合信号），也不落审计 / 账本。
    await runDirectiveSet({
      origin: 'command',
      runId,
      thread,
      signal,
      directives: [{ kind: 'eval', entry: resolved.entry, args }],
      caps: message.caps ?? {},
      limits: message.limits ?? DEFAULT_LIMITS,
      readonly: resolved.readonly === true,
      name: message.name,
      initialOwnerOf: (directive) => (directive.kind === 'eval' ? resolved.identity : undefined),
      reply: (outcome) =>
        deps.send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'result',
          status: outcome.status,
          observations: outcome.observations,
        }),
    })
  }

  /**
   * 插件入站转发：壳把 `/p/<id>/*` 转成宿主入站帧，宿主按 `identity` 只转发到该身份
   * **自己声明**的入口 term（构造一次 run）；命令不属于该身份即拒——宿主不认识业务，只做机械路由。
   */
  const forward: InboundHandlers['forward'] = async (socket, message, runId, thread, signal) => {
    if (
      typeof message.identity !== 'string' ||
      message.identity.length === 0 ||
      typeof message.command !== 'string' ||
      message.command.length === 0
    ) {
      deps.send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'bad_directive',
        message: 'forward expects { identity, command }',
      })
      return
    }
    const snapshot = writer.snapshot()
    const resolved = deps.commandIndexFor(snapshot.world, snapshot.head).byName.get(message.command)
    if (resolved === undefined || resolved.identity !== message.identity) {
      deps.send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'unknown_command',
        message: message.command,
      })
      return
    }
    const args = message.args ?? null
    if (!checkCommandArgs(socket, message.id, resolved, args, snapshot.world)) return
    await runDirectiveSet({
      origin: 'forward',
      runId,
      thread,
      signal,
      directives: [{ kind: 'eval', entry: resolved.entry, args }],
      caps: message.caps ?? {},
      limits: message.limits ?? DEFAULT_LIMITS,
      readonly: resolved.readonly === true,
      name: message.command,
      initialOwnerOf: () => resolved.identity,
      reply: (outcome) =>
        deps.send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'result',
          status: outcome.status,
          observations: outcome.observations,
        }),
    })
  }

  /**
   * 宿主通用原语：启动一次 detached run——无 socket、结果不回流，事件照广播。
   * initiator = 调用方 emitter，directives = 单条 eval；宿主不认识游标语义（游标由调用方放进 args）。
   * 并发超 `MAX_DETACHED_RUNS` 即拒（不起新 run）；`thread` 仅随事件原样回带。
   */
  const startDetachedRun: InboundHandlers['startDetachedRun'] = (emitter, entry, args, thread) => {
    if (registry.detachedCount() >= MAX_DETACHED_RUNS) {
      return { ok: false, code: 'too_many_runs' }
    }
    const runId = randomUUID()
    registry.addDetached(runId)
    const controller = new AbortController()
    registry.register(runId, controller)
    const lifecycle = beginRun(deps.broadcast, { run: runId, thread, origin: 'detached' })
    lifecycle.started()
    let status = 'refused'
    let reasons: string[] = []
    const task = runSubmission({
      writer,
      directives: [{ kind: 'eval', entry, args }],
      // detached run 不继承调用方 caps：以空 caps 起，权限最小化
      caps: {},
      limits: DEFAULT_LIMITS,
      initiator: emitter,
      runId,
      // detached run 不是发起者提交：调用帧 env.thread 恒 null（事件里的 thread 只作展示标签）
      thread: null,
      now: () => registry.nextNow(),
      router: deps.getRouter(),
      callTimeoutMs: deps.callTimeoutMs,
      signal: controller.signal,
      initialOwnerOf: () => emitter,
      resolveCommand: resolvePlanCommand,
      ctxFor: deps.cachedProjection,
      onAudit: deps.persistAudit,
      onRound: deps.persistRound,
      onAdvanced: deps.applyWorldSerial,
    })
      .then((outcome) => {
        status = outcome.status
        reasons = refusedReasons(outcome.observations)
      })
      .catch((err: unknown) => {
        // detached run 无调用方等待：错误只进运维日志，收口仍按 refused
        deps.safeAppendLifecycle({
          at: Date.now(),
          kind: 'host',
          event: 'run_failed',
          run: runId,
          reason: err instanceof Error ? err.message : String(err),
        })
        deps.escalateFatal()
      })
      .finally(() => {
        registry.removeDetached(runId)
        registry.unregister(runId)
        registry.untrack(task)
        lifecycle.finished(status, reasons)
      })
    registry.track(task)
    return { ok: true, run: runId }
  }

  return { submit, command, forward, startDetachedRun }
}
