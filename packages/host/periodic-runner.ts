// 周期条目的 run 构造：命令条目按声明入口 term 起 run；方法条目直接调该服务方法，
// 其返回的计划值（`$directives`）由宿主按该身份落账。宿主不认识业务，只按声明机械触发。

import { randomUUID } from 'node:crypto'
import { assemblyGen, commandArgsIssue, readPluginDecl } from './assembly/index.ts'
import { HOST_CAPABILITY } from './host-methods.ts'
import { resolveMethodTimeoutMs } from './method-timeouts.ts'
import { readProjectionPath } from './projection/index.ts'
import {
  DEFAULT_CALL_TIMEOUT_MS,
  parsePlanDirectives,
  refusedReasons,
  runSubmission,
} from './effect/index.ts'
import type { CtxProvider, DirectiveDraft, RoundRouter } from './effect/index.ts'
import { beginRun, DEFAULT_LIMITS } from './run-registry.ts'
import type { BroadcastFn, RunRegistry } from './run-registry.ts'
import type { CommandIndexFor } from './inbound/handlers.ts'
import type { PeriodicEntry, PeriodicRead } from './periodic.ts'
import type { PluginDecl } from './assembly/index.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import type { AuditDraft } from './audit.ts'
import type { LifecycleRecord } from './lifecycle.ts'
import type { HostPaths } from './paths.ts'
import type { WorldWriter } from './writer.ts'
import type { Entry, Head, Json, World } from '../kernel/index.ts'

export interface PeriodicRunnerDeps {
  writer: WorldWriter
  registry: RunRegistry
  paths: HostPaths
  getRouter: () => RoundRouter | undefined
  getRuntime: () => AssemblyRuntimeHandle | undefined
  /** 已应用世界 getter：方法级超时解析与路由同代。 */
  liveWorld: () => World
  commandIndexFor: CommandIndexFor
  cachedProjection: CtxProvider
  persistAudit: (draft: AuditDraft) => void
  persistRound: (entries: Entry[]) => void
  applyWorldSerial: (world: World, head: Head) => Promise<void>
  broadcast: BroadcastFn
  safeAppendLifecycle: (record: LifecycleRecord) => void
  escalateFatal: () => void
  isStopping: () => boolean
  callTimeoutMs?: number
}

export interface PeriodicRunner {
  /** 到点触发一次：起 run 并按 `run.started` / `run.finished` 成对收口。 */
  fire: (entry: PeriodicEntry) => void
}

/** 周期方法 bag：按 `schema.periodic.reads` 机械取投影片段；无 reads → null。 */
export function buildPeriodicBag(projection: Json, reads: PeriodicRead[]): Json {
  if (reads.length === 0) return null
  const bag: { [k: string]: Json } = {}
  for (const read of reads) bag[read.key] = readProjectionPath(projection, read.path)
  return bag
}

/** 声明里含该方法的能力类（方法名 → cap）；多类同名取字典序第一个。 */
export function capOfMethod(decl: PluginDecl, method: string): string | null {
  for (const cap of Object.keys(decl.methods).sort()) {
    if (decl.methods[cap].includes(method)) return cap
  }
  return null
}

export function createPeriodicRunner(deps: PeriodicRunnerDeps): PeriodicRunner {
  const { writer, registry } = deps

  const runPeriodicEntry = async (
    entry: PeriodicEntry,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ status: string; reasons: string[] }> => {
    const runtime = deps.getRuntime()
    if (runtime === undefined) return { status: 'refused', reasons: [] }
    const snapshot = writer.snapshot()
    const world = snapshot.world
    const declRead = readPluginDecl(world, entry.identity, deps.paths.blobsDir)
    if (declRead === null) return { status: 'refused', reasons: [] }
    const bag = buildPeriodicBag(deps.cachedProjection(world, snapshot.head), entry.reads)
    let directives: DirectiveDraft[]
    if (entry.command !== undefined) {
      const command = deps.commandIndexFor(world, snapshot.head).byName.get(entry.command)
      if (command === undefined || command.identity !== entry.identity) {
        return { status: 'refused', reasons: [] }
      }
      // 宿主注入的 bag 与入站 args 同规过 argsSchema（不得成为旁路）
      if (commandArgsIssue(world, command, bag) !== 'ok') return { status: 'refused', reasons: [] }
      directives = [{ kind: 'eval', entry: command.entry, args: bag }]
    } else if (entry.method !== undefined) {
      const cap = capOfMethod(declRead.decl, entry.method)
      const gen = assemblyGen(world, entry.identity)
      if (cap === null || gen === null) return { status: 'refused', reasons: [] }
      const row = runtime.endpoints.get(entry.identity, gen.payload, cap, entry.method)
      if (row === null) return { status: 'refused', reasons: [] }
      const called = await row.link.call(
        cap,
        entry.method,
        bag,
        resolveMethodTimeoutMs(deps.liveWorld(), entry.identity, cap, entry.method) ??
          deps.callTimeoutMs ??
          DEFAULT_CALL_TIMEOUT_MS,
        signal,
        // 宿主自身发起的方法调用：无 directive 属主，发出者身份记宿主保留身份 `host`
        { run: runId, thread: null, now: registry.nextNow(), emitter: HOST_CAPABILITY },
      )
      if (!called.ok) return { status: 'refused', reasons: [] }
      const plan = parsePlanDirectives(called.value)
      // 方法有响应但没给计划值 = 本拍无写，按完成收口；给了非法计划则 fail-closed 拒（同 plan 通道）
      if (!plan.ok) return { status: 'refused', reasons: [plan.reason] }
      if (plan.directives.length === 0) return { status: 'done', reasons: [] }
      directives = plan.directives
    } else {
      return { status: 'refused', reasons: [] }
    }
    const outcome = await runSubmission({
      writer,
      directives,
      caps: {},
      limits: DEFAULT_LIMITS,
      initiator: entry.identity,
      runId,
      // 周期 run 非发起者提交：调用帧 env.thread 恒 null
      thread: null,
      now: () => registry.nextNow(),
      router: deps.getRouter(),
      callTimeoutMs: deps.callTimeoutMs,
      signal,
      initialOwnerOf: () => entry.identity,
      resolveCommand: (roundWorld, name) => {
        const command = deps.commandIndexFor(roundWorld, writer.snapshot().head).byName.get(name)
        return command === undefined
          ? undefined
          : { entry: command.entry, identity: command.identity }
      },
      ctxFor: deps.cachedProjection,
      onAudit: deps.persistAudit,
      onRound: deps.persistRound,
      onAdvanced: deps.applyWorldSerial,
    })
    return { status: outcome.status, reasons: refusedReasons(outcome.observations) }
  }

  const fire = (entry: PeriodicEntry): void => {
    if (deps.isStopping() || deps.getRuntime() === undefined) return
    const runId = randomUUID()
    const controller = new AbortController()
    registry.register(runId, controller)
    const lifecycle = beginRun(deps.broadcast, { run: runId, thread: null, origin: 'periodic' })
    lifecycle.started()
    let status = 'refused'
    let reasons: string[] = []
    const task: Promise<void> = runPeriodicEntry(entry, runId, controller.signal)
      .then((outcome) => {
        status = outcome.status
        reasons = outcome.reasons
      })
      .catch((err: unknown) => {
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
        registry.unregister(runId)
        registry.untrack(task)
        lifecycle.finished(status, reasons)
      })
    registry.track(task)
  }

  return { fire }
}
