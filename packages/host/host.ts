// 宿主进程：唯一写者。抢锁 → 全量重放 → 开入站 socket → 串行处理提交。
// 装配与效果边界由此汇合：本文件只做接线与派发，不解释命令语义。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import {
  listCommands,
  resolveCommand,
  startAssembly,
  validateArgs,
  validateArgsSchema,
} from './assembly/index.ts'
import type { AssemblyRuntimeHandle } from './assembly/index.ts'
import { createRoundRouter, runSubmission } from './effect/index.ts'
import type { DirectiveDraft, RoundRouter } from './effect/index.ts'
import { appendJournal, acquireLock, loadAnchor, readJournal, releaseLock } from './ledger/index.ts'
import { DEFAULT_COMPACT_TAIL_ENTRIES, compactWorld } from './compact.ts'
import { AuditIndex, auditRecordOf, parseAuditFilter } from './audit.ts'
import { getAsset, putAsset } from './assets.ts'
import { createHostCapability } from './host-capability.ts'
import { deleteSecret, isValidSecretName, putSecret } from './secrets.ts'
import { gcPluginState } from './plugin-state.ts'
import { appendLifecycle } from './lifecycle.ts'
import { hostPaths, socketPath } from './paths.ts'
import { resolveStartWrapper } from './options.ts'
import { projectBaseOnly } from './projection/index.ts'
import { WorldWriter } from './writer.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './wire.ts'
import type { InboundMessage, Limits, OutboundMessage } from './wire.ts'
import { worldRev } from '../kernel/index.ts'
import type { Entry, Hash, Json, World, Head } from '../kernel/index.ts'

export interface HostOptions {
  root: string
  /** 效果调用超时；缺省走 `DEFAULT_CALL_TIMEOUT_MS`（测试可注入更短值）。 */
  callTimeoutMs?: number
  /** G6 启动压缩阈值（尾段 entry 数）；缺省 `DEFAULT_COMPACT_TAIL_ENTRIES`（测试可注入小值）。 */
  compactTailEntries?: number
  /** 服务启动包装器（宿主侧最小沙箱形态）：只前置到 spawn 命令行；缺省无（零行为变化）。 */
  startWrapper?: string
}

export interface HostHandle {
  root: string
  socket: string
  /** 停机序列：等在途提交 → 断开客户端 → 关闭服务 → 释放锁。 */
  stop: () => Promise<void>
  /** 插件事件透传入口：只广播给已连接客户端，不落账、不推进。 */
  emitEvent: (impl: string, topic: string, payload: Json) => void
}

/** 发起者未给 limits 时的宿主默认预算。 */
const DEFAULT_LIMITS: Limits = { gas: 1_000_000, depth: 64 }

/** detached run 并发上限：无调用方等待，超限即拒，防单个插件无限起后台 run 拖垮宿主。 */
export const MAX_DETACHED_RUNS = 32

function asRecord(value: Json): { [k: string]: Json } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function readMessage(raw: Json): InboundMessage | null {
  const record = asRecord(raw)
  if (!record) return null
  if (typeof record['v'] !== 'string' || typeof record['id'] !== 'string') return null
  if (typeof record['kind'] !== 'string') return null
  return record as unknown as InboundMessage
}

/** 合法 op 名单（与内核 `Op` 同口径）：入站 write 形态校验用。 */
const OP_NAMES: ReadonlySet<string> = new Set([
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

/** 机械校验 directives 形态；非法返回 null（不得让畸形提交打崩写者）。
 *  eval 的 `ctx` 字段保原样：缺省留给宿主投影，显式给出（含 null）透传（A14）。 */
function asDirectives(value: unknown): DirectiveDraft[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const record = item as { [k: string]: unknown }
    const kind = record['kind']
    if (kind === 'eval') {
      if (typeof record['entry'] !== 'string' || record['entry'].length === 0) return null
      continue
    }
    if (kind === 'extern') continue
    if (kind === 'write') {
      const request = record['request']
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return null
      const op = (request as { [k: string]: unknown })['op']
      if (typeof op !== 'string' || !OP_NAMES.has(op)) return null
      continue
    }
    return null
  }
  return value as DirectiveDraft[]
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(address, () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
}

/** 起宿主：全程阻塞在入站 socket 上，直到 stop 被调用。 */
export async function startHost(options: HostOptions): Promise<HostHandle> {
  // 包装器防御：库调用方可能绕过入口解析，非法值同样 fail-closed（不静默降级为无包装器）
  if (options.startWrapper !== undefined) resolveStartWrapper(options.startWrapper)
  const root = options.root
  const paths = hostPaths(root)
  const startedAt = Date.now()
  const lock = acquireLock(paths.lockFile, startedAt)
  if (!lock.ok) throw new Error('writer_busy')

  const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
  /** F8 只读审计面：启动时由基础世界索引 + journal 尾段重建，运行期随审计落链增量补齐（只读）。 */
  const audits = new AuditIndex()
  for (const ref of anchor.baseAudits) {
    const def = anchor.world.defs[ref.hash]
    if (def !== undefined) {
      audits.add({ seq: ref.seq, at: ref.at, by: ref.by, hash: ref.hash, body: def.body })
    }
  }
  const collectAudits = (entries: Entry[]): void => {
    for (const entry of entries) {
      const record = auditRecordOf(entry)
      if (record !== null) audits.add(record)
    }
  }
  collectAudits(anchor.entries)
  // G6 启动压缩：尾段达到阈值即追加快照 entry + 归档前缀 + 写基础世界（世界不变，链头推进到快照）。
  // 归档前缀只取**当前 journal**（未归档部分）：回落全链时 `anchor.entries` 可能是全链，不能整段再归档。
  const compactTailEntries = options.compactTailEntries ?? DEFAULT_COMPACT_TAIL_ENTRIES
  let initialHead: Head = anchor.head
  if (compactTailEntries > 0 && anchor.entries.length >= compactTailEntries) {
    const compacted = compactWorld(
      paths,
      anchor.world,
      anchor.head,
      readJournal(paths.journalFile),
      audits.refs(),
      Date.now(),
    )
    initialHead = { seq: compacted.snapshot.seq, hash: compacted.snapshot.hash }
  }
  // 落账互斥段：多个 run 可并发推进，只有「追加 journal + 推进世界 / 链头」经它串行。
  const writer = new WorldWriter({ world: anchor.world, head: initialHead })
  // 投影按链头缓存：同一世界的多轮 / 多 run 复用一份闭包视图（投影只读，内核不改 ctx）。
  let ctxCache: { head: Hash | null; view: Json } | undefined
  const cachedProjection = (world: World, head: Head): Json => {
    if (ctxCache !== undefined && ctxCache.head === head.hash) return ctxCache.view
    const view = projectBaseOnly(world, head)
    ctxCache = { head: head.hash, view }
    return view
  }
  // `world_rev` 是全量摘要（O(#defs)）：按链头缓存，避免每次 `status` 轮询都阻塞事件循环重算。
  let revCache: { head: Hash | null; rev: Hash } | undefined
  const cachedWorldRev = (world: World, head: Head): Hash => {
    if (revCache !== undefined && revCache.head === head.hash) return revCache.rev
    const rev = worldRev(world)
    revCache = { head: head.hash, rev }
    return rev
  }
  // 插件 ③ 目录统一 GC：抢锁后、装配前，清掉不在当前世界身份集里的缓存目录（宿主不认识内容）。
  // 缓存可重算，GC 失败不致命：记一条运维日志后继续启动，不因此中断也不影响锁的释放。
  try {
    gcPluginState(paths.pluginsDir, writer.snapshot().world)
  } catch (err) {
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'host',
      event: 'gc_failed',
      reason: err instanceof Error ? err.message : String(err),
    })
  }
  const clients = new Set<Socket>()
  let stopping = false
  let router: RoundRouter | undefined

  const address = socketPath(root)
  mkdirSync(paths.sockDir, { recursive: true })
  if (process.platform !== 'win32' && existsSync(address)) {
    try {
      unlinkSync(address)
    } catch {
      // 陈旧 socket 文件清理失败不致命，listen 会给出真实错误
    }
  }

  const send = (socket: Socket, message: OutboundMessage): void => {
    socket.write(encodeFrame(message as unknown as Json))
  }
  const broadcast = (impl: string, topic: string, payload: Json): void => {
    for (const client of clients) {
      send(client, { v: PROTOCOL_VERSION, impl, kind: 'event', topic, payload })
    }
  }

  const persistAudit = (entry: Entry): void => {
    appendJournal(paths.journalFile, [entry])
    collectAudits([entry])
  }
  const persistRound = (entries: Entry[]): void => {
    appendJournal(paths.journalFile, entries)
  }

  let runtime: AssemblyRuntimeHandle | undefined
  /** 在途 run（并发推进中）：停机时先等它们落定；`cancel{run}` 按 `runs` 表中止。 */
  const inflight = new Set<Promise<void>>()
  /** 在册 run（含并发推进中）：`cancel{run}` 按此表中止；run 结束即摘除。 */
  const runs = new Map<string, AbortController>()
  /** 在途 detached run（无调用方等待）：按此表计数执行并发上限。 */
  const detachedRuns = new Set<string>()
  /** 逐轮时间戳非回退（A10）：时钟回拨时仍单调 +1。 */
  let lastNow = startedAt
  const nextNow = (): number => {
    const now = Date.now()
    lastNow = now > lastNow ? now : lastNow + 1
    return lastNow
  }

  // 换代跟随串行且单调：并发 run 的 done 可能乱序到达，只应用不比当前更旧的链头，
  // 且不并发进 applyWorld（它会改运行态端点表 / 进程）。用独立链而非落账段，避免长任务堵住提交。
  let appliedSeq = initialHead.seq
  let runtimeChain: Promise<void> = Promise.resolve()
  const applyWorldSerial = (advancedWorld: World, advancedHead: Head): Promise<void> => {
    const next = runtimeChain.then(async () => {
      if (runtime === undefined || advancedHead.seq <= appliedSeq) return
      appliedSeq = advancedHead.seq
      await runtime.applyWorld(advancedWorld)
    })
    runtimeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * H9 宿主通用原语：启动一次 detached run——无 socket、结果不回流，事件照广播。
   * initiator = 调用方 emitter，directives = 单条 eval；宿主不认识游标语义（游标由调用方放进 args）。
   * 并发超 `MAX_DETACHED_RUNS` 即拒（不起新 run）；`thread` 仅随事件原样回带。
   */
  const startDetachedRun = (
    emitter: string,
    entry: Hash,
    args: Json,
    thread: string | null,
  ): { ok: true; run: string } | { ok: false; code: 'too_many_runs' } => {
    if (detachedRuns.size >= MAX_DETACHED_RUNS) return { ok: false, code: 'too_many_runs' }
    const runId = randomUUID()
    detachedRuns.add(runId)
    const controller = new AbortController()
    runs.set(runId, controller)
    broadcast('host', 'run.started', { run: runId, thread })
    let finished = false
    // 收口幂等：run.started / run.finished 严格成对、恰好一次（异常路径也以 refused 收口）
    const finish = (status: string): void => {
      if (finished) return
      finished = true
      broadcast('host', 'run.finished', { run: runId, thread, status })
    }
    const task = runSubmission({
      writer,
      directives: [{ kind: 'eval', entry, args }],
      // detached run 不继承调用方 caps：以空 caps 起，权限最小化
      caps: {},
      limits: DEFAULT_LIMITS,
      initiator: emitter,
      runId,
      now: nextNow,
      router,
      callTimeoutMs: options.callTimeoutMs,
      signal: controller.signal,
      initialOwnerOf: () => emitter,
      ctxFor: cachedProjection,
      onAudit: persistAudit,
      onRound: persistRound,
      onAdvanced: applyWorldSerial,
    })
      .then((outcome) => {
        finish(outcome.status)
      })
      .catch((err: unknown) => {
        // detached run 无调用方等待：先广播 run.finished{refused} 收口，错误只进运维日志
        appendLifecycle(paths.lifecycleFile, {
          at: Date.now(),
          kind: 'host',
          event: 'run_failed',
          run: runId,
          reason: err instanceof Error ? err.message : String(err),
        })
        finish('refused')
      })
      .finally(() => {
        detachedRuns.delete(runId)
        runs.delete(runId)
        inflight.delete(task)
      })
    inflight.add(task)
    return { ok: true, run: runId }
  }

  const handleSubmit = async (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'submit' }>,
    directives: DirectiveDraft[],
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    broadcast('host', 'run.started', { run: runId, thread })
    let status = 'refused'
    try {
      // 入站直提 eval 的属主：命令入口哈希 → 声明身份；解析不到则不路由（A1 不猜）
      const entryOwners = new Map<string, string>()
      for (const command of listCommands(writer.snapshot().world)) {
        if (!entryOwners.has(command.entry)) entryOwners.set(command.entry, command.identity)
      }
      const outcome = await runSubmission({
        writer,
        directives,
        caps: message.caps ?? {},
        limits: message.limits ?? DEFAULT_LIMITS,
        initiator: 'client',
        runId,
        now: nextNow,
        router,
        callTimeoutMs: options.callTimeoutMs,
        signal,
        initialOwnerOf: (directive) =>
          directive.kind === 'eval' ? entryOwners.get(directive.entry) : undefined,
        ctxFor: cachedProjection,
        onAudit: persistAudit,
        onRound: persistRound,
        onAdvanced: applyWorldSerial,
      })
      status = outcome.status
      send(socket, {
        v: PROTOCOL_VERSION,
        kind: 'result',
        run: runId,
        status: outcome.status,
        observations: outcome.observations,
      })
    } catch (err) {
      appendLifecycle(paths.lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'run_failed',
        run: runId,
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      // run.started / run.finished 严格成对、恰好一次：异常路径也以 refused 收口
      broadcast('host', 'run.finished', { run: runId, thread, status })
    }
  }

  const handleCommand = async (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'command' }>,
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    if (typeof message.name !== 'string') {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'bad_directive',
        message: 'command name must be a string',
      })
      return
    }
    const command = resolveCommand(writer.snapshot().world, message.name)
    if (command === null) {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'unknown_command',
        message: message.name,
      })
      return
    }
    const args = message.args ?? null
    if (command.argsSchema !== null) {
      const schemaDef = writer.snapshot().world.defs[command.argsSchema]
      // 运行期 add_gen 产出的 argsSchema 未必过入世门禁：命令侧补一次方言元校验（fail-closed）
      const dialect = schemaDef === undefined ? null : validateArgsSchema(schemaDef.body)
      if (schemaDef === undefined || dialect === null || !dialect.ok) {
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'error',
          code: 'bad_args_schema',
          message: message.name,
        })
        return
      }
      if (!validateArgs(schemaDef.body, args)) {
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'error',
          code: 'bad_args',
          message: message.name,
        })
        return
      }
    }
    const directives: DirectiveDraft[] = [{ kind: 'eval', entry: command.entry, args }]
    broadcast('host', 'run.started', { run: runId, thread })
    let status = 'refused'
    try {
      // 命令也是一次 run：给审计一个可查询的回合 id（命令 result 不带 run，仅审计 / 运维可见）。
      // 与 submit 同规建信号：cancel{run} 与停机 abort() 都能覆盖 command run。
      const outcome = await runSubmission({
        writer,
        directives,
        caps: message.caps ?? {},
        limits: message.limits ?? DEFAULT_LIMITS,
        initiator: 'command',
        runId,
        now: nextNow,
        router,
        callTimeoutMs: options.callTimeoutMs,
        signal,
        initialOwnerOf: (directive) => (directive.kind === 'eval' ? command.identity : undefined),
        ctxFor: cachedProjection,
        onAudit: persistAudit,
        onRound: persistRound,
        onAdvanced: applyWorldSerial,
      })
      status = outcome.status
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'result',
        status: outcome.status,
        observations: outcome.observations,
      })
    } catch (err) {
      appendLifecycle(paths.lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'run_failed',
        run: runId,
        reason: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      // run.started / run.finished 严格成对、恰好一次：异常路径也以 refused 收口
      broadcast('host', 'run.finished', { run: runId, thread, status })
    }
  }

  const server = createServer((socket: Socket) => {
    clients.add(socket)
    const decoder = createFrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      let frames: Json[]
      try {
        frames = decoder.push(chunk)
      } catch {
        // 畸形帧：断掉该客户端，写者进程不因入站损坏退出
        socket.destroy()
        return
      }
      for (const raw of frames) {
        const message = readMessage(raw)
        if (message === null) continue
        try {
          dispatch(socket, message)
        } catch {
          socket.destroy()
          return
        }
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  let stopPromise: Promise<void> | undefined
  const doStop = async (): Promise<void> => {
    stopping = true
    try {
      appendLifecycle(paths.lifecycleFile, { at: Date.now(), kind: 'host', event: 'stop' })
    } finally {
      // 在途 / 并发推进中的 run 先取消：它们按 cancelled 落定，停机不耗在调用超时上
      for (const controller of runs.values()) controller.abort()
      // 等全部在途 run 收敛（审计 / 业务写不落在停机中途），再断连接与服务
      await Promise.allSettled([...inflight])
      for (const client of clients) client.destroy()
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      } catch {
        // 未进入监听状态时 close 可能报错；停机继续
      }
      try {
        if (runtime !== undefined) await runtime.stop()
      } catch {
        // 停机尽力而为；锁必须释放
      }
      if (process.platform !== 'win32') {
        try {
          unlinkSync(address)
        } catch {
          // socket 文件可能已被外部清理；停机不因此失败
        }
      }
      releaseLock(paths.lockFile)
    }
  }

  /** 停机幂等：并发 / 重复调用共享同一个 promise。 */
  const stop = (): Promise<void> => {
    if (stopPromise === undefined) stopPromise = doStop()
    return stopPromise
  }

  const dispatch = (socket: Socket, message: InboundMessage): void => {
    if (message.v !== PROTOCOL_VERSION) {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'protocol_mismatch',
        message: `protocol ${message.v} != ${PROTOCOL_VERSION}`,
      })
      return
    }
    switch (message.kind) {
      case 'submit': {
        if (stopping) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'internal',
            message: 'stopping',
          })
          return
        }
        const directives = asDirectives(message.directives)
        if (directives === null) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'directives must be an array of directives',
          })
          return
        }
        const submit = message
        const runId = randomUUID()
        const thread = typeof submit.thread === 'string' ? submit.thread : null
        const controller = new AbortController()
        runs.set(runId, controller)
        // accepted 先于推进发出：长提交不阻塞后到客户端的受理确认（run 入册后即可被 cancel 命中）
        send(socket, { v: PROTOCOL_VERSION, id: submit.id, kind: 'accepted', run: runId })
        // 多个 run 并发推进（eval / 等待效果不互斥），只在落账那一刻经 writer 串行
        const task = handleSubmit(socket, submit, directives, runId, thread, controller.signal)
          .catch(() => {
            try {
              send(socket, {
                v: PROTOCOL_VERSION,
                id: submit.id,
                kind: 'error',
                code: 'internal',
                message: 'submit failed',
              })
            } catch {
              // 客户端已断：错误无处可送
            }
          })
          .finally(() => {
            runs.delete(runId)
            inflight.delete(task)
          })
        inflight.add(task)
        return
      }
      case 'command': {
        if (stopping) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'internal',
            message: 'stopping',
          })
          return
        }
        const command = message
        const runId = randomUUID()
        const thread = typeof command.thread === 'string' ? command.thread : null
        const controller = new AbortController()
        runs.set(runId, controller)
        const task = handleCommand(socket, command, runId, thread, controller.signal)
          .catch(() => {
            try {
              send(socket, {
                v: PROTOCOL_VERSION,
                id: command.id,
                kind: 'error',
                code: 'internal',
                message: 'command failed',
              })
            } catch {
              // 客户端已断：错误无处可送
            }
          })
          .finally(() => {
            runs.delete(runId)
            inflight.delete(task)
          })
        inflight.add(task)
        return
      }
      case 'cancel': {
        if (typeof message.run !== 'string' || message.run.length === 0) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'cancel expects run',
          })
          return
        }
        const controller = runs.get(message.run)
        if (controller === undefined) {
          // 未知 / 已结束的 run：fail-closed（不猜、不静默）
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'unknown_run',
            message: message.run,
          })
          return
        }
        controller.abort()
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted' })
        return
      }
      case 'audit': {
        const filter = parseAuditFilter(message.filter)
        if (filter === null) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'bad audit filter',
          })
          return
        }
        const report = audits.query(filter)
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'audits',
          records: report.records as unknown as Json[],
          truncated: report.truncated,
        })
        return
      }
      case 'asset.put': {
        const result = putAsset(paths.assetsDir, message.mime, message.bytes)
        if (!result.ok) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: result.code,
            message: 'asset put rejected',
          })
          return
        }
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'asset.ref',
          ref: result.ref as unknown as Json,
        })
        return
      }
      case 'asset.get': {
        const result = getAsset(paths.assetsDir, message.sha256)
        if (!result.ok) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: result.code,
            message: message.sha256,
          })
          return
        }
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'asset.bytes',
          sha256: result.sha256,
          size: result.size,
          bytes: result.bytes,
        })
        return
      }
      case 'secrets.put': {
        const { name, value } = message
        if (typeof name !== 'string' || typeof value !== 'string' || !isValidSecretName(name)) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'secrets.put expects { name, value }',
          })
          return
        }
        const written = putSecret(paths.secretsFile, name, value)
        if (!written.ok) {
          // 损坏文件 fail-closed：不静默以 {} 覆写丢密钥
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: written.reason === 'corrupt' ? 'internal' : 'bad_directive',
            message: `secrets.put rejected: ${written.reason}`,
          })
          return
        }
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'secrets.ok', name })
        return
      }
      case 'secrets.delete': {
        const { name } = message
        if (typeof name !== 'string' || !isValidSecretName(name)) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: 'bad_directive',
            message: 'secrets.delete expects { name }',
          })
          return
        }
        const removed = deleteSecret(paths.secretsFile, name)
        if (!removed.ok) {
          send(socket, {
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            code: removed.reason === 'corrupt' ? 'internal' : 'bad_directive',
            message: `secrets.delete rejected: ${removed.reason}`,
          })
          return
        }
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'secrets.ok', name })
        return
      }
      case 'commands': {
        const commands = listCommands(writer.snapshot().world).map((command) => ({
          identity: command.identity,
          name: command.name,
          entry: command.entry,
        }))
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'list', commands })
        return
      }
      case 'status': {
        const loaded =
          runtime === undefined
            ? []
            : runtime.loaded().map((entry) => ({ id: entry.id, gen: entry.gen }))
        const current = writer.snapshot()
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'state',
          world_head: { seq: current.head.seq, hash: current.head.hash },
          world_rev: cachedWorldRev(current.world, current.head),
          loaded,
        })
        return
      }
      case 'stop': {
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted' })
        setImmediate(() => {
          stop().catch(() => {
            // 停机尽力而为；失败由锁 / socket 清理逻辑兜底
          })
        })
        return
      }
    }
  }

  try {
    appendLifecycle(paths.lifecycleFile, { at: startedAt, kind: 'host', event: 'start' })
    runtime = await startAssembly({
      root,
      world: writer.snapshot().world,
      log: (record) => appendLifecycle(paths.lifecycleFile, record as unknown as Json),
      onEvent: (impl, topic, payload) => broadcast(impl, topic, payload),
      startWrapper: options.startWrapper,
      depsDir: paths.depsDir,
    })
    const driftLogged = new Set<string>()
    router = createRoundRouter({
      endpoints: runtime.endpoints,
      host: createHostCapability({
        assetsDir: paths.assetsDir,
        audits,
        world: () => writer.snapshot().world,
        abortRun: (run) => {
          const controller = runs.get(run)
          if (controller === undefined) return false
          controller.abort()
          return true
        },
        startDetachedRun,
        isStopping: () => stopping,
      }),
      onDrift: (impl, cap, gen) => {
        // 同一 (发出者, pin 名, 依赖世代) 只记一条证据，避免每次调用都刷运维日志
        const key = `${impl}\u0000${cap}\u0000${gen}`
        if (driftLogged.has(key)) return
        driftLogged.add(key)
        appendLifecycle(paths.lifecycleFile, {
          at: Date.now(),
          kind: 'dep',
          event: 'drift',
          impl,
          cap,
          gen,
        })
      },
    })
    await listen(server, address)
  } catch (err) {
    // 启动失败不泄漏：停已起服务、关监听、释放锁
    if (runtime !== undefined) {
      try {
        await runtime.stop()
      } catch {
        // 清理尽力而为，不遮蔽原始错误
      }
    }
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } catch {
      // 未进入监听状态时 close 可能报错
    }
    releaseLock(paths.lockFile)
    throw err
  }

  return {
    root,
    socket: address,
    stop,
    emitEvent: broadcast,
  }
}
