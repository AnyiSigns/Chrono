// 宿主组合根接线：读 options → bootstrap 起停编排 → 组装 follow / inbound / router / capability /
// periodic / watcher → 暴露运行态句柄。本模块只做接线，不解释命令语义、不持有业务判定。

import { hostPaths, socketPath } from './paths.ts'
import { bootstrapHost } from './bootstrap.ts'
import type { BootstrappedHost, WiredHost, WorldReady } from './bootstrap.ts'
import { RunRegistry } from './run-registry.ts'
import type { BroadcastFn } from './run-registry.ts'
import { createFollow } from './follow.ts'
import { createInboundServer } from './inbound/server.ts'
import type { DispatchFn, InboundServerHandle } from './inbound/server.ts'
import { createDispatch } from './inbound/dispatch.ts'
import { createInboundHandlers } from './inbound/handlers.ts'
import { createCapabilityWiring } from './capability-wiring.ts'
import { createPeriodicRunner } from './periodic-runner.ts'
import { createWatchReload } from './watch/host-reload.ts'
import { buildCommandIndex, startAssembly } from './assembly/index.ts'
import type { AssemblyRuntimeHandle, CommandIndex } from './assembly/index.ts'
import { createRoundRouter, fatalError } from './effect/index.ts'
import type { RoundRouter } from './effect/index.ts'
import { PeriodicScheduler } from './periodic.ts'
import { readMethodTimeouts } from './method-timeouts.ts'
import { InvalidDeclLog } from './invalid-decl-log.ts'
import { PortAuditRing } from './port-audit.ts'
import type { PortAuditRecord, PortAuditSink } from './port-audit.ts'
import { appendLifecycle, flushLifecycle, flushLifecycleSync } from './lifecycle.ts'
import type { LifecycleRecord } from './lifecycle.ts'
import { appendJournal } from './ledger/index.ts'
import { projectBaseOnly } from './projection/index.ts'
import { startSourceWatcher } from './watch/index.ts'
import type { SourceWatcherHandle } from './watch/index.ts'
import { resolveStartWrapper } from './options.ts'
import { worldRev } from '../kernel/index.ts'
import type { Hash, Json, World } from '../kernel/index.ts'
import type { HostOptions } from './host.ts'

/** 组合根接线的运行态句柄：停机 / 事件广播 / 端口审计只读快照。 */
export interface ComposedHost {
  socket: string
  stop: () => Promise<void>
  emitEvent: BroadcastFn
  portAuditRecords: () => PortAuditRecord[]
}

/** 起宿主：全程阻塞在入站 socket 上，直到 stop 被调用。 */
export async function composeHost(options: HostOptions): Promise<ComposedHost> {
  // 包装器防御：库调用方可能绕过入口解析，非法值同样 fail-closed（不静默降级为无包装器）
  if (options.startWrapper !== undefined) resolveStartWrapper(options.startWrapper)
  const root = options.root
  const paths = hostPaths(root)
  const address = socketPath(root)
  const startedAt = Date.now()
  const registry = new RunRegistry(startedAt)
  const followFailedGens = new Set<string>()
  let stopping = false
  let runtime: AssemblyRuntimeHandle | undefined
  let router: RoundRouter | undefined
  let periodic: PeriodicScheduler | undefined
  let watcher: SourceWatcherHandle | undefined
  let server: InboundServerHandle | undefined
  let stopImpl: (() => Promise<void>) | undefined
  let bootstrappedRef: BootstrappedHost | undefined
  let shutdownPending = false
  let stopPromise: Promise<void> | undefined
  // 入站监听先于装配：服务连上后可能在装配完成前发起反向调用，这里挂起等待路由就绪。
  let routerReadyResolve: (() => void) | undefined
  const routerReady = new Promise<void>((resolve) => {
    routerReadyResolve = resolve
  })

  /** 运维日志安全写入：日志是旁路，写失败不得在 catch / 事件监听器内抛成未捕获异常。 */
  const safeAppendLifecycle = (record: LifecycleRecord): void => {
    try {
      appendLifecycle(paths.lifecycleFile, record as unknown as Json)
    } catch {
      // 日志写不进去只损失可观测性，不影响主流程
    }
  }

  /** 运维日志唯一落点；顺带记住跟随失败的世代，供 watcher 观测（只读派生，不额外写盘）。 */
  const recordLifecycle = (record: LifecycleRecord): void => {
    safeAppendLifecycle(record)
    if (record.gen === undefined) return
    if (record.kind === 'service' && record.event === 'start_failed') followFailedGens.add(record.gen)
    if (record.kind === 'handshake' && record.event === 'failed') followFailedGens.add(record.gen)
  }

  /** 停机幂等：并发 / 重复调用共享同一个 promise。 */
  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) return stopPromise
    stopPromise = (async () => {
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
      } catch {
        // 日志写不进去只损失可观测性
      }
      // 在途 / 并发推进中的 run 先取消：它们按 cancelled 落定，停机不耗在调用超时上
      registry.abortAll()
      await registry.settle()
      server?.destroyClients()
      await server?.close()
      try {
        if (runtime !== undefined) await runtime.stop()
      } catch {
        // 停机尽力而为；锁必须释放
      }
      server?.unlinkSocket()
      if (bootstrappedRef !== undefined) await bootstrappedRef.shutdown()
      else shutdownPending = true
    })()
    return stopPromise
  }
  stopImpl = stop

  /**
   * 落账致命态收口：run 抛错后若 `fatalError()` 非空（账本追加失败，内存世界已与磁盘分叉），
   * 记一条运维日志并把致命态升级为停机——继续服务只会让分叉随每轮提交放大。
   */
  const escalateFatal = (): void => {
    const fatal = fatalError()
    if (fatal === null) return
    safeAppendLifecycle({
      at: Date.now(),
      kind: 'host',
      event: 'persist_fatal_stop',
      reason: fatal.message,
    })
    try {
      flushLifecycleSync(paths.lifecycleFile)
    } catch {
      // 日志落稳失败不改变致命收口
    }
    void stopImpl?.().catch(() => {
      // 停机尽力而为；失败由锁 / socket 清理逻辑兜底
    })
  }

  /** 端口审计落点：缺省写有界环形缓冲；注入 sink 时同时写入快照与 sink。 */
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

  /** watcher 的终端可视线：前台模式直出终端；测试可注入收集。 */
  const watchLog =
    options.watchLog ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`)
    })

  /** 世界就绪后由组合根接线：监听 → 起装配 → 建 router / periodic / watcher。 */
  const buildWired = async (ready: WorldReady): Promise<WiredHost> => {
    const { writer, audits, world, head, setAuditTierWorld } = ready
    let ctxCache: { head: Hash | null; seq: number; view: Json } | undefined
    const cachedProjection = (target: World, targetHead: typeof head): Json => {
      if (ctxCache !== undefined && ctxCache.head === targetHead.hash) return ctxCache.view
      const view = projectBaseOnly(target, targetHead, { blobsDir: paths.blobsDir })
      // 单条缓存只被「不更旧」的链头覆盖：并发的陈旧 head 调用不得挤掉更新的缓存
      if (ctxCache === undefined || targetHead.seq >= ctxCache.seq) {
        ctxCache = { head: targetHead.hash, seq: targetHead.seq, view }
      }
      return view
    }
    // `world_rev` 是全量摘要（O(#defs)）：按链头缓存，避免每次 `status` 轮询都阻塞事件循环重算。
    let revCache: { head: Hash | null; rev: Hash } | undefined
    const cachedWorldRev = (target: World, targetHead: typeof head): Hash => {
      if (revCache !== undefined && revCache.head === targetHead.hash) return revCache.rev
      const rev = worldRev(target)
      revCache = { head: targetHead.hash, rev }
      return rev
    }
    // 命令索引按链头缓存：同头多路解析复用一次 `buildCommandIndex`（含名字映射）。
    let commandCache: { head: Hash | null; index: CommandIndex } | undefined
    const commandIndexFor = (target: World, targetHead: typeof head): CommandIndex => {
      if (commandCache !== undefined && commandCache.head === targetHead.hash) {
        return commandCache.index
      }
      const index = buildCommandIndex(target, paths.blobsDir)
      commandCache = { head: targetHead.hash, index }
      return index
    }

    /** 周期声明非法条目：每次 `sync` 收集后按身份签名去重（声明修好再变坏可重记）。 */
    const periodicInvalidBuffer: { identity: string; reason: string }[] = []
    const periodicInvalid = new InvalidDeclLog((identity, reason) => {
      safeAppendLifecycle({
        at: Date.now(),
        kind: 'dep',
        event: 'periodic_invalid',
        impl: identity,
        reason,
      })
    })
    const syncPeriodic = (target: World): void => {
      periodicInvalidBuffer.length = 0
      periodic?.sync(target)
      periodicInvalid.report(periodicInvalidBuffer)
    }
    /** 方法级超时声明非法：按身份签名去重，声明变化才重记（不永久屏蔽）。 */
    const methodTimeoutInvalid = new InvalidDeclLog((identity, reason) => {
      safeAppendLifecycle({
        at: Date.now(),
        kind: 'dep',
        event: 'method_timeout_invalid',
        impl: identity,
        reason,
      })
    })
    const reportMethodTimeouts = (target: World): void => {
      methodTimeoutInvalid.report(readMethodTimeouts(target).invalid)
    }

    let dispatchRef: DispatchFn | undefined
    let localServer: InboundServerHandle | undefined
    try {
      appendLifecycle(paths.lifecycleFile, { at: startedAt, kind: 'host', event: 'start' })
      // 启动是里程碑：立即落盘，宿主可用的那一刻 start 已可被外部观测
      flushLifecycle(paths.lifecycleFile)
      const follow = createFollow({
        initialWorld: world,
        initialHead: head,
        getRuntime: () => runtime,
        broadcast: (impl, topic, payload) => server?.broadcast(impl, topic, payload),
        safeAppendLifecycle,
        isStopping: () => stopping,
        onApplied: (next) => {
          setAuditTierWorld(next)
          if (!stopping) {
            syncPeriodic(next)
            reportMethodTimeouts(next)
          }
        },
      })

      localServer = createInboundServer({
        address,
        sockDir: paths.sockDir,
        getDispatch: () => {
          if (dispatchRef === undefined) throw new Error('dispatch not ready')
          return dispatchRef
        },
        onRuntimeError: (err) => {
          safeAppendLifecycle({
            at: Date.now(),
            kind: 'host',
            event: 'listen_error',
            reason: err.message,
          })
          // 运行期监听错误：按停机序列收口，不崩宿主
          void stopImpl?.()
        },
      })
      server = localServer

      const handlers = createInboundHandlers({
        writer,
        registry,
        callTimeoutMs: options.callTimeoutMs,
        send: localServer.send,
        getRouter: () => router,
        commandIndexFor,
        cachedProjection,
        persistAudit: (draft) => audits.append(draft),
        persistRound: (entries) => appendJournal(paths.journalFile, entries),
        applyWorldSerial: follow.applyWorldSerial,
        broadcast: localServer.broadcast,
        safeAppendLifecycle,
        escalateFatal,
      })

      const wiring = createCapabilityWiring({
        root,
        paths,
        writer,
        audits,
        registry,
        getRouter: () => router,
        routerReady,
        liveWorld: follow.liveWorld,
        isStopping: () => stopping,
        startDetachedRun: handlers.startDetachedRun,
        callTimeoutMs: options.callTimeoutMs,
        portAudit,
        nextNow: () => registry.nextNow(),
      })

      dispatchRef = createDispatch({
        send: localServer.send,
        registry,
        paths,
        audits,
        isStopping: () => stopping,
        requestStop: () => {
          // 同步置停机态：stop 经 setImmediate 延迟执行，窗口内不得再受理新 run
          stopping = true
          setImmediate(() => {
            void stopImpl?.().catch(() => {
              // 停机尽力而为
            })
          })
        },
        getRuntime: () => runtime,
        getSnapshot: () => writer.snapshot(),
        cachedWorldRev,
        commandIndexFor,
        handlers,
      })

      // 入站面先于装配监听：服务 spawn 后即可连上，装配完成前的反向调用由 handlePortCall 挂起等路由就绪。
      await localServer.listen()
      runtime = await startAssembly({
        root,
        world: writer.snapshot().world,
        log: recordLifecycle,
        onEvent: (impl, topic, payload) => localServer?.broadcast(impl, topic, payload),
        onPortCall: wiring.handlePortCall,
        startWrapper: options.startWrapper,
        depsDir: paths.depsDir,
        blobsDir: paths.blobsDir,
      })
      // 路由解析按「已应用世界」而非 run 锚定世界：端点表由 runtime.applyWorld 按该世界换代换键，
      // 锚定旧世代会在并发换代后解析到已被摘除的世代键（假 not_loaded）；liveWorld 与端点表同代。
      // 漂移证据按 (发出者, pin 名) 只留最近依赖世代，避免键含世代哈希的 Set 只增。
      const driftLogged = new Map<string, string>()
      router = createRoundRouter({
        endpoints: runtime.endpoints,
        blobsDir: paths.blobsDir,
        liveWorld: follow.liveWorld,
        host: wiring.capability,
        onDrift: (impl, cap, gen) => {
          const key = `${impl}\u0000${cap}`
          if (driftLogged.get(key) === gen) return
          driftLogged.set(key, gen)
          safeAppendLifecycle({ at: Date.now(), kind: 'dep', event: 'drift', impl, cap, gen })
        },
      })
      routerReadyResolve?.()

      const periodicRunner = createPeriodicRunner({
        writer,
        registry,
        paths,
        getRouter: () => router,
        getRuntime: () => runtime,
        liveWorld: follow.liveWorld,
        commandIndexFor,
        cachedProjection,
        persistAudit: (draft) => audits.append(draft),
        persistRound: (entries) => appendJournal(paths.journalFile, entries),
        applyWorldSerial: follow.applyWorldSerial,
        broadcast: localServer.broadcast,
        safeAppendLifecycle,
        escalateFatal,
        isStopping: () => stopping,
        callTimeoutMs: options.callTimeoutMs,
      })
      periodic = new PeriodicScheduler({
        onFire: periodicRunner.fire,
        onInvalid: (identity, reason) => periodicInvalidBuffer.push({ identity, reason }),
      })
      syncPeriodic(writer.snapshot().world)
      reportMethodTimeouts(writer.snapshot().world)

      // 源码 watcher：默认关；只监听、不落账——变动经宿主落账互斥段提交，再交装配跟随。
      if (options.watch === true) {
        const watchReload = createWatchReload({
          root,
          paths,
          writer,
          nextNow: () => registry.nextNow(),
          applyWorld: follow.applyWorldSerial,
          safeAppendLifecycle,
          escalateFatal,
          getRuntime: () => runtime,
          isStopping: () => stopping,
          followFailedGens,
          watchLog,
        })
        watcher = startSourceWatcher({
          root,
          onReload: watchReload.onReload,
          onError: (target, reason) => {
            safeAppendLifecycle({
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

      return { runtime }
    } catch (err) {
      // 接线中途抛出：清掉本函数已建的部分（server / runtime）；锁由 bootstrap 释放。
      try {
        localServer?.destroyClients()
        await localServer?.close()
      } catch {
        // 清理尽力而为，不遮蔽原始错误
      }
      try {
        if (runtime !== undefined) await runtime.stop()
      } catch {
        // 清理尽力而为，不遮蔽原始错误
      }
      throw err
    }
  }

  const bootstrapped = await bootstrapHost({
    root,
    paths,
    startedAt,
    compactTailEntries: options.compactTailEntries,
    safeAppendLifecycle,
    wire: buildWired,
  })
  bootstrappedRef = bootstrapped
  if (shutdownPending) await bootstrapped.shutdown()

  return {
    socket: address,
    stop,
    emitEvent: (impl, topic, payload) => server?.broadcast(impl, topic, payload),
    portAuditRecords: () => portAuditRing.records(),
  }
}
