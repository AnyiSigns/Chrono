// 宿主进程：唯一写者。抢锁 → 全量重放 → 开入站 socket → 串行处理提交。
// 装配与效果边界由此汇合：本文件只做接线与派发，不解释命令语义。

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import {
  assemblyGen,
  gcMaterialized,
  listCommands,
  readPluginDecl,
  resolveCommand,
  startAssembly,
  validateArgs,
  validateArgsSchema,
} from './assembly/index.ts'
import type { AssemblyRuntimeHandle, CommandDecl, PluginDecl } from './assembly/index.ts'
import {
  DEFAULT_CALL_TIMEOUT_MS,
  createRoundRouter,
  parsePlanDirectives,
  refusedReasons,
  runSubmission,
} from './effect/index.ts'
import type { DirectiveDraft, RoundRouter } from './effect/index.ts'
import { PeriodicScheduler } from './periodic.ts'
import type { PeriodicEntry, PeriodicRead } from './periodic.ts'
import { readMethodTimeouts, resolveMethodTimeoutMs } from './method-timeouts.ts'
import { PortAuditRing, redactPortArgs } from './port-audit.ts'
import type { PortAuditRecord, PortAuditSink } from './port-audit.ts'
import { InvalidDeclLog } from './invalid-decl-log.ts'
import { appendJournal, acquireLock, loadAnchor, readJournal, releaseLock } from './ledger/index.ts'
import { DEFAULT_COMPACT_TAIL_ENTRIES, compactWorld } from './compact.ts'
import { AuditIndex, auditRecordOf, parseAuditFilter } from './audit.ts'
import { getAsset, putAsset } from './assets.ts'
import { createHostCapability } from './host-capability.ts'
import { deleteSecret, isValidSecretName, putSecret } from './secrets.ts'
import { gcPluginState } from './plugin-state.ts'
import { appendLifecycle } from './lifecycle.ts'
import type { LifecycleRecord } from './lifecycle.ts'
import { hostPaths, socketPath } from './paths.ts'
import { resolveStartWrapper } from './options.ts'
import { projectBaseOnly } from './projection/index.ts'
import { WorldWriter } from './writer.ts'
import { reloadPlugin, startSourceWatcher } from './watch/index.ts'
import type { SourceWatcherHandle, WatchTarget } from './watch/index.ts'
import { PROTOCOL_VERSION, createFrameDecoder, encodeFrame } from './wire.ts'
import type { CallEnv, InboundMessage, Limits, OutboundMessage } from './wire.ts'
import type { CallResponse } from './service-link.ts'
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
  /** 端口审计落点（反向 `port.call`）：缺省写宿主侧有界内存环形缓冲。 */
  portAuditSink?: PortAuditSink
  /**
   * 源码 watcher：默认关。打开后盯 `state/plugins.json` 登记的投递路径，
   * 文件变动即自动重新入世并交装配跟随换代（开发态热更，不引入开发/生产分叉）。
   */
  watch?: boolean
  /** watcher 的终端可视线（前台模式直出终端）；缺省写宿主 stdout。 */
  watchLog?: (line: string) => void
}

export interface HostHandle {
  root: string
  socket: string
  /** 停机序列：等在途提交 → 断开客户端 → 关闭服务 → 释放锁。 */
  stop: () => Promise<void>
  /** 插件事件透传入口：只广播给已连接客户端，不落账、不推进。 */
  emitEvent: (impl: string, topic: string, payload: Json) => void
  /**
   * 端口审计只读快照（时间正序、有界）：反向 `port.call` 的宿主侧取证，
   * 不进世界、不写链、不参与重放。注入 `portAuditSink` 时仍同时写入本快照。
   */
  portAuditRecords: () => PortAuditRecord[]
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

/** JS 原型键：投影路径段出现即拒（否则读到的是函数 / 原型，不是数据）。 */
const UNSAFE_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

/** 沿投影字面路径取值；路径不合 / 越界 / 原型键 → null（宿主只机械取用，不解释业务）。 */
function readProjectionPath(projection: Json, path: Json[]): Json {
  let current: Json = projection
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (UNSAFE_PROJECTION_KEYS.has(segment)) return null
      if (typeof current !== 'object' || current === null || Array.isArray(current)) return null
      current = (current as { [k: string]: Json })[segment] ?? null
    } else if (typeof segment === 'number' && Array.isArray(current)) {
      current = current[segment] ?? null
    } else {
      return null
    }
  }
  return current
}

/** 周期方法 bag：按 `schema.periodic.reads` 机械取投影片段；无 reads → null。 */
function buildPeriodicBag(projection: Json, reads: PeriodicRead[]): Json {
  if (reads.length === 0) return null
  const bag: { [k: string]: Json } = {}
  for (const read of reads) bag[read.key] = readProjectionPath(projection, read.path)
  return bag
}

/** 声明里含该方法的能力类（方法名 → cap）；多类同名取字典序第一个。 */
function capOfMethod(decl: PluginDecl, method: string): string | null {
  for (const cap of Object.keys(decl.methods).sort()) {
    if (decl.methods[cap].includes(method)) return cap
  }
  return null
}

/**
 * 命令 args 的机械校验（无 socket 版）：命令入口 / 入站转发 / 周期触发共用同一口径。
 * 运行期 add_gen 产出的 argsSchema 未必过入世门禁，故这里补一次方言元校验（fail-closed）。
 */
function commandArgsIssue(
  world: World,
  command: CommandDecl,
  args: Json,
): 'ok' | 'bad_args_schema' | 'bad_args' {
  if (command.argsSchema === null) return 'ok'
  const schemaDef = world.defs[command.argsSchema]
  const dialect = schemaDef === undefined ? null : validateArgsSchema(schemaDef.body)
  if (schemaDef === undefined || dialect === null || !dialect.ok) return 'bad_args_schema'
  return validateArgs(schemaDef.body, args) ? 'ok' : 'bad_args'
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
    const view = projectBaseOnly(world, head, { blobsDir: paths.blobsDir })
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
  // 物化目录（③ 可重算）统一 GC：抢锁后、装配前，每身份保留 active 代码世代 + 前 N 代。
  // 被回收的世代仍可由「指针 def + CAS 字节」重建，故回收不承担回滚承诺；绝不在 run 中删。
  // 删不掉不致命：记一条运维日志后继续启动（Windows 只读硬链接目录可能需要先解属性）。
  try {
    const report = gcMaterialized(paths.materializedDir, writer.snapshot().world)
    if (report.failed.length > 0) {
      appendLifecycle(paths.lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'gc_failed',
        reason: `materialized:${report.failed.length}`,
      })
    }
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

  /**
   * 端口审计落点：缺省写有界环形缓冲（`HostHandle.portAuditRecords` 可读）；
   * 注入 sink 时同时写入快照与 sink（sink 抛错由调用处的 try/catch 隔离，不阻断转发）。
   */
  const portAuditRing = new PortAuditRing()
  const injectedPortAuditSink = options.portAuditSink
  const portAudit: PortAuditSink =
    injectedPortAuditSink === undefined
      ? portAuditRing
      : {
          record: (record) => {
            portAuditRing.record(record)
            injectedPortAuditSink.record(record)
          },
        }

  /** H6 定时触发：按各插件 schema 的 `periodic` 声明调度周期 run；停机时清空。 */
  let periodic: PeriodicScheduler | undefined
  /** 周期声明非法条目：每次 `sync` 收集后按身份签名去重（声明修好再变坏可重记）。 */
  const periodicInvalidBuffer: { identity: string; reason: string }[] = []
  const periodicInvalid = new InvalidDeclLog((identity, reason) => {
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'dep',
      event: 'periodic_invalid',
      impl: identity,
      reason,
    })
  })
  /** 周期声明对齐：`sync` 期间收集非法条目，结束后按签名去重记录。 */
  const syncPeriodic = (world: World): void => {
    periodicInvalidBuffer.length = 0
    periodic?.sync(world)
    periodicInvalid.report(periodicInvalidBuffer)
  }

  /** 方法级超时声明非法：按身份签名去重，声明变化才重记（不永久屏蔽）。 */
  const methodTimeoutInvalid = new InvalidDeclLog((identity, reason) => {
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'dep',
      event: 'method_timeout_invalid',
      impl: identity,
      reason,
    })
  })
  const reportMethodTimeouts = (world: World): void => {
    methodTimeoutInvalid.report(readMethodTimeouts(world).invalid)
  }

  let runtime: AssemblyRuntimeHandle | undefined
  /** 源码 watcher（默认关）：只在显式打开时存在；停机时先停它，避免停机中途再起重建。 */
  let watcher: SourceWatcherHandle | undefined
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
      if (!stopping) {
        syncPeriodic(advancedWorld)
        reportMethodTimeouts(advancedWorld)
      }
    })
    runtimeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** 换代跟随失败的世代（构建 / 启动 / 握手）：watcher 据此把「旧版本继续服务」讲清楚。 */
  const followFailedGens = new Set<string>()

  /** 运维日志唯一落点；顺带记住跟随失败的世代，供 watcher 观测（只读派生，不额外写盘）。 */
  const recordLifecycle = (record: LifecycleRecord): void => {
    appendLifecycle(paths.lifecycleFile, record as unknown as Json)
    if (record.gen === undefined) return
    if (record.kind === 'service' && record.event === 'start_failed')
      followFailedGens.add(record.gen)
    if (record.kind === 'handshake' && record.event === 'failed') followFailedGens.add(record.gen)
  }

  /** watcher 的终端可视线：前台模式直出终端；测试可注入收集。 */
  const watchLog =
    options.watchLog ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`)
    })

  /**
   * watcher 一次触发：重新入世（内容未变则什么都不做）→ 装配跟随。
   * 换代走正常 `add_gen`（真 journal entry，可回滚可审计）；失败不替换在跑服务，
   * 只记运维日志并在 stdout 说清「旧版本继续服务」。
   */
  const handleWatchReload = async (target: WatchTarget, changedPath: string): Promise<void> => {
    if (stopping || runtime === undefined) return
    const label = target.entry.name
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'host',
      event: 'watch_triggered',
      impl: label,
      reason: changedPath,
    })
    const outcome = await reloadPlugin(
      { root, paths, writer, now: nextNow, applyWorld: applyWorldSerial },
      target.entry,
    )
    if (outcome.status === 'failed') {
      const reason = outcome.reasons.join('|')
      appendLifecycle(paths.lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'watch_failed',
        impl: outcome.identity ?? label,
        reason,
      })
      watchLog(`watcher: ${outcome.identity ?? label} 入世失败，旧版本继续服务（${reason}）`)
      return
    }
    if (outcome.status === 'unchanged') return
    const failed = followFailedGens.has(outcome.gen)
    appendLifecycle(paths.lifecycleFile, {
      at: Date.now(),
      kind: 'host',
      event: failed ? 'watch_follow_failed' : 'watch_applied',
      impl: outcome.identity,
      gen: outcome.gen,
    })
    watchLog(
      failed
        ? followFailureLine(outcome.identity)
        : `watcher: ${outcome.identity} 检测到改动 → 已重建并接管（gen ${outcome.gen.slice(0, 12)}）`,
    )
  }

  /**
   * 换代跟随失败的实况提示：准备阶段失败时旧实例仍在服务（端点已换新世代键）；
   * 独占序 drain 后的 spawn / 握手失败则已无旧实例，该身份转入「无服务但保留世代」按 `restart` 重试。
   * 按运行态实况区分，不笼统说「旧版本继续服务」。
   */
  const followFailureLine = (identity: string): string => {
    const running =
      runtime?.loaded().some((entry) => entry.id === identity && entry.service) ?? false
    return running
      ? `watcher: ${identity} 新世代构建 / 启动失败，旧版本继续服务`
      : `watcher: ${identity} 新世代启动失败，当前无可用服务（按 restart 策略重试）`
  }

  /**
   * 反向调用（protocol §2.4）：服务发 `port.call` 时按**发出者身份** `pins` 路由后转发给目标服务。
   * 目标调用帧同样填 `env`：取发起服务在途正向调用的回合信息（同一 run / thread）；无在途调用时
   * 补宿主固定时钟、run / thread 记 null。返回值一律是数据，不抛错（失败作数据回 `port.error`）。
   */
  const handlePortCall = async (
    impl: string,
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ): Promise<CallResponse> => {
    if (router === undefined) return { ok: false, code: 'not_loaded', message: 'router not ready' }
    const snapshot = writer.snapshot()
    const routed = router.resolve(snapshot.world, impl, port, method)
    if (!routed.ok) return { ok: false, code: routed.error, message: routed.error }
    const callEnv: CallEnv = env ?? { run: null, thread: null, now: nextNow() }
    // 端口审计：env 值脱敏后只落宿主侧内存面（不进世界、不写链）；旁路失败不影响转发
    try {
      portAudit.record({
        at: Date.now(),
        from: impl,
        target: routed.row.impl,
        port,
        method,
        args: redactPortArgs(args),
        run: callEnv.run,
        thread: callEnv.thread,
      })
    } catch {
      // 审计落点异常不阻断反向调用（旁路取证，非业务通道）
    }
    const timeoutMs =
      resolveMethodTimeoutMs(snapshot.world, routed.row.impl, port, method) ??
      options.callTimeoutMs ??
      DEFAULT_CALL_TIMEOUT_MS
    try {
      return await routed.row.link.call(port, method, args, timeoutMs, undefined, callEnv)
    } catch {
      return { ok: false, code: 'transport_failed', message: 'port.call transport failed' }
    }
  }

  /**
   * plan 条目按命令名解析（注入 effect）：与命令面同路（`resolveCommand`），
   * 返回入口 def + 声明方身份；effect 不认识装配。
   */
  const resolvePlanCommand = (
    world: World,
    name: string,
  ): { entry: Hash; identity: string } | undefined => {
    const command = resolveCommand(world, name, paths.blobsDir)
    return command === null ? undefined : { entry: command.entry, identity: command.identity }
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
    const finish = (status: string, reasons: string[]): void => {
      if (finished) return
      finished = true
      broadcast('host', 'run.finished', { run: runId, thread, status, reasons })
    }
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
      now: nextNow,
      router,
      callTimeoutMs: options.callTimeoutMs,
      signal: controller.signal,
      initialOwnerOf: () => emitter,
      resolveCommand: resolvePlanCommand,
      ctxFor: cachedProjection,
      onAudit: persistAudit,
      onRound: persistRound,
      onAdvanced: applyWorldSerial,
    })
      .then((outcome) => {
        finish(outcome.status, refusedReasons(outcome.observations))
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
        finish('refused', [])
      })
      .finally(() => {
        detachedRuns.delete(runId)
        runs.delete(runId)
        inflight.delete(task)
      })
    inflight.add(task)
    return { ok: true, run: runId }
  }

  /**
   * H6 定时触发：起一次周期 run。命令条目按声明入口 term 起 run；方法条目直接调该服务方法，
   * 其返回的计划值（`$directives`）由宿主按该身份落账。`thread` 恒 null（非发起者提交）。
   */
  const firePeriodic = (entry: PeriodicEntry): void => {
    if (stopping || runtime === undefined) return
    const runId = randomUUID()
    const controller = new AbortController()
    runs.set(runId, controller)
    broadcast('host', 'run.started', { run: runId, thread: null })
    let status = 'refused'
    let reasons: string[] = []
    const task: Promise<void> = runPeriodicEntry(entry, runId, controller.signal)
      .then((outcome) => {
        status = outcome.status
        reasons = outcome.reasons
      })
      .catch((err: unknown) => {
        appendLifecycle(paths.lifecycleFile, {
          at: Date.now(),
          kind: 'host',
          event: 'run_failed',
          run: runId,
          reason: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        runs.delete(runId)
        inflight.delete(task)
        broadcast('host', 'run.finished', { run: runId, thread: null, status, reasons })
      })
    inflight.add(task)
  }

  const runPeriodicEntry = async (
    entry: PeriodicEntry,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ status: string; reasons: string[] }> => {
    if (runtime === undefined) return { status: 'refused', reasons: [] }
    const snapshot = writer.snapshot()
    const world = snapshot.world
    const declRead = readPluginDecl(world, entry.identity, paths.blobsDir)
    if (declRead === null) return { status: 'refused', reasons: [] }
    const bag = buildPeriodicBag(cachedProjection(world, snapshot.head), entry.reads)
    let directives: DirectiveDraft[]
    if (entry.command !== undefined) {
      const command = resolveCommand(world, entry.command, paths.blobsDir)
      if (command === null || command.identity !== entry.identity) {
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
        resolveMethodTimeoutMs(world, entry.identity, cap, entry.method) ??
          options.callTimeoutMs ??
          DEFAULT_CALL_TIMEOUT_MS,
        signal,
        { run: runId, thread: null, now: nextNow() },
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
      now: nextNow,
      router,
      callTimeoutMs: options.callTimeoutMs,
      signal,
      initialOwnerOf: () => entry.identity,
      resolveCommand: resolvePlanCommand,
      ctxFor: cachedProjection,
      onAudit: persistAudit,
      onRound: persistRound,
      onAdvanced: applyWorldSerial,
    })
    return { status: outcome.status, reasons: refusedReasons(outcome.observations) }
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
    let reasons: string[] = []
    try {
      // 入站直提 eval 的属主：命令入口哈希 → 声明身份；解析不到则不路由（A1 不猜）
      const entryOwners = new Map<string, string>()
      for (const command of listCommands(writer.snapshot().world, paths.blobsDir)) {
        if (!entryOwners.has(command.entry)) entryOwners.set(command.entry, command.identity)
      }
      const outcome = await runSubmission({
        writer,
        directives,
        caps: message.caps ?? {},
        limits: message.limits ?? DEFAULT_LIMITS,
        initiator: 'client',
        runId,
        thread,
        now: nextNow,
        router,
        callTimeoutMs: options.callTimeoutMs,
        signal,
        initialOwnerOf: (directive) =>
          directive.kind === 'eval' && 'entry' in directive
            ? entryOwners.get(directive.entry)
            : undefined,
        resolveCommand: resolvePlanCommand,
        ctxFor: cachedProjection,
        onAudit: persistAudit,
        onRound: persistRound,
        onAdvanced: applyWorldSerial,
      })
      status = outcome.status
      reasons = refusedReasons(outcome.observations)
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
      broadcast('host', 'run.finished', { run: runId, thread, status, reasons })
    }
  }

  /**
   * 命令 args 的机械校验（命令入口与入站转发共用）：坏 schema / 坏参直接回错并返回 false。
   * 运行期 add_gen 产出的 argsSchema 未必过入世门禁，故命令侧补一次方言元校验（fail-closed）。
   */
  const checkCommandArgs = (
    socket: Socket,
    id: string,
    command: CommandDecl,
    args: Json,
  ): boolean => {
    const issue = commandArgsIssue(writer.snapshot().world, command, args)
    if (issue === 'ok') return true
    send(socket, {
      v: PROTOCOL_VERSION,
      id,
      kind: 'error',
      code: issue,
      message: command.name,
    })
    return false
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
    const command = resolveCommand(writer.snapshot().world, message.name, paths.blobsDir)
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
    if (!checkCommandArgs(socket, message.id, command, args)) return
    const directives: DirectiveDraft[] = [{ kind: 'eval', entry: command.entry, args }]
    broadcast('host', 'run.started', { run: runId, thread })
    let status = 'refused'
    let reasons: string[] = []
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
        thread,
        now: nextNow,
        router,
        callTimeoutMs: options.callTimeoutMs,
        signal,
        initialOwnerOf: (directive) => (directive.kind === 'eval' ? command.identity : undefined),
        resolveCommand: resolvePlanCommand,
        ctxFor: cachedProjection,
        onAudit: persistAudit,
        onRound: persistRound,
        onAdvanced: applyWorldSerial,
      })
      status = outcome.status
      reasons = refusedReasons(outcome.observations)
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
      broadcast('host', 'run.finished', { run: runId, thread, status, reasons })
    }
  }

  /**
   * H8 插件入站转发：壳把 `/p/<id>/*` 转成宿主入站帧，宿主按 `identity` 只转发到该身份
   * **自己声明**的入口 term（构造一次 run）；命令不属于该身份即拒——宿主不认识业务，只做机械路由。
   */
  const handleForward = async (
    socket: Socket,
    message: Extract<InboundMessage, { kind: 'forward' }>,
    runId: string,
    thread: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      typeof message.identity !== 'string' ||
      message.identity.length === 0 ||
      typeof message.command !== 'string' ||
      message.command.length === 0
    ) {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'bad_directive',
        message: 'forward expects { identity, command }',
      })
      return
    }
    const command = resolveCommand(writer.snapshot().world, message.command, paths.blobsDir)
    if (command === null || command.identity !== message.identity) {
      send(socket, {
        v: PROTOCOL_VERSION,
        id: message.id,
        kind: 'error',
        code: 'unknown_command',
        message: message.command,
      })
      return
    }
    const args = message.args ?? null
    if (!checkCommandArgs(socket, message.id, command, args)) return
    const directives: DirectiveDraft[] = [{ kind: 'eval', entry: command.entry, args }]
    broadcast('host', 'run.started', { run: runId, thread })
    let status = 'refused'
    let reasons: string[] = []
    try {
      const outcome = await runSubmission({
        writer,
        directives,
        caps: message.caps ?? {},
        limits: message.limits ?? DEFAULT_LIMITS,
        initiator: 'forward',
        runId,
        thread,
        now: nextNow,
        router,
        callTimeoutMs: options.callTimeoutMs,
        signal,
        initialOwnerOf: () => command.identity,
        resolveCommand: resolvePlanCommand,
        ctxFor: cachedProjection,
        onAudit: persistAudit,
        onRound: persistRound,
        onAdvanced: applyWorldSerial,
      })
      status = outcome.status
      reasons = refusedReasons(outcome.observations)
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
      broadcast('host', 'run.finished', { run: runId, thread, status, reasons })
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
    // 先停周期调度与 watcher：停机中途不再起新的周期 run / 重建
    periodic?.stop()
    if (watcher !== undefined) {
      try {
        await watcher.stop()
      } catch {
        // watcher 停机尽力而为；锁必须释放
      }
    }
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
      case 'forward': {
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
        const forward = message
        const runId = randomUUID()
        const thread = typeof forward.thread === 'string' ? forward.thread : null
        const controller = new AbortController()
        runs.set(runId, controller)
        const task = handleForward(socket, forward, runId, thread, controller.signal)
          .catch(() => {
            try {
              send(socket, {
                v: PROTOCOL_VERSION,
                id: forward.id,
                kind: 'error',
                code: 'internal',
                message: 'forward failed',
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
        const commands = listCommands(writer.snapshot().world, paths.blobsDir).map((command) => ({
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
      log: recordLifecycle,
      onEvent: (impl, topic, payload) => broadcast(impl, topic, payload),
      onPortCall: handlePortCall,
      startWrapper: options.startWrapper,
      depsDir: paths.depsDir,
      blobsDir: paths.blobsDir,
    })
    const driftLogged = new Set<string>()
    router = createRoundRouter({
      endpoints: runtime.endpoints,
      blobsDir: paths.blobsDir,
      host: createHostCapability({
        assetsDir: paths.assetsDir,
        blobsDir: paths.blobsDir,
        runtimeDir: paths.runtimeDir,
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
    // H6 定时触发：装配就绪后按各插件 schema 的 periodic 声明排程；声明变更随 applyWorld 增量对齐
    // 非法条目由 syncPeriodic 按签名去重记录（每条都 fsync，避免每轮落账重复刷）
    periodic = new PeriodicScheduler({
      onFire: firePeriodic,
      onInvalid: (identity, reason) => periodicInvalidBuffer.push({ identity, reason }),
    })
    syncPeriodic(writer.snapshot().world)
    reportMethodTimeouts(writer.snapshot().world)
    await listen(server, address)
    // 源码 watcher：默认关；只监听、不落账——变动经宿主落账互斥段提交，再交装配跟随。
    // 挂在装配就绪之后：回调依赖 runtime（跟随换代）与 router（新服务调用），
    // 且开监听即意味着宿主已可用，此时才开始监听源码。
    if (options.watch === true) {
      watcher = startSourceWatcher({
        root,
        onReload: handleWatchReload,
        onError: (target, reason) => {
          appendLifecycle(paths.lifecycleFile, {
            at: Date.now(),
            kind: 'host',
            event: 'watch_failed',
            impl: target.entry.name,
            reason,
          })
        },
      })
      appendLifecycle(paths.lifecycleFile, {
        at: Date.now(),
        kind: 'host',
        event: 'watch_start',
        reason: String(watcher.targets.length),
      })
      watchLog(`watcher: 已监听 ${watcher.targets.length} 个投递路径`)
    }
  } catch (err) {
    // 启动失败不泄漏：停周期调度与已起服务、关监听、释放锁
    stopping = true
    periodic?.stop()
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
    portAuditRecords: () => portAuditRing.records(),
  }
}
