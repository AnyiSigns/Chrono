// 装配运行时：装配计划 → 实际服务进程（物化 / 握手 / 健康重启 / 换代跟随 / 停机）。
// 只读世界：不写链、不改 active；生命周期事件经注入的 log 落运维日志（state/lifecycle.log）。
// 坏分支只隔离：握手不过 / 重启超限 / 依赖退役 → 该身份及其依赖者标 not_loaded，其余照常。
// 例外（换代跟随）：新代码世代构建 / 启动失败不隔离——新世代不激活，旧进程继续服务。
// A6 换代跟随：链头推进后比对世界，本插件自身**代码世代**换代才动作——数据热生效（reload/ack，
// 进程不动）/ 代码起新服务（旧服务 drain）；依赖换代不重装（A1 重解析路由），依赖退役则隔离。
// G7 A1：数据世代（同身份混合世代）变化不触发跟随 / 隔离 / 服务动作。

import { resolve } from 'node:path'
import { buildOwnerIndex, computeAssemblyPlan } from './closure.ts'
import { assemblyGen, readPluginDecl, readPluginDeclOfGen } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { classifyGenerationChange } from './generation.ts'
import { launchService, prepareService, spawnService } from './service-launcher.ts'
import type { PreparedService, ServiceLauncherDeps } from './service-launcher.ts'
import {
  DEFAULT_START_CONCURRENCY,
  computeStartLayers,
  runWithConcurrency,
} from './start-layers.ts'
import { restoreDependencies } from './deps.ts'
import { copyAssetsManifest, readAssetsManifest } from './assets-manifest.ts'
import { resolvePluginSourceRoot } from './ingest.ts'
import { EndpointTable } from '../endpoint-table.ts'
import { hostPaths } from '../paths.ts'
import type { CallResponse } from '../service-link.ts'
import type { CallEnv } from '../wire.ts'
import type { HostPaths } from '../paths.ts'
import type { AssemblyPlan } from './closure.ts'
import {
  EXIT_WAIT_MS,
  ServiceStartError,
  backoffDelay,
  classifyStartFailure,
  parseHealth,
  parseRestart,
  stopChild,
  terminateChild,
  waitForExit,
} from './supervision.ts'
import { isSafeIdentityName } from './identity-name.ts'
import { swapService } from './swap.ts'
import type { ServiceRuntime } from './supervision.ts'
import type { SwapHost } from './swap.ts'
import type { LifecycleFields, LifecycleKind, LifecycleRecord } from '../lifecycle.ts'
import { stale } from '../../kernel/index.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

/** 未声明超时时的握手上限；仅连接建立用，不是效果调用超时。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** 数据换代 `reload` 等 `ack` 的上限；超时按装载失败保守改走起新服务。 */
const DEFAULT_RELOAD_TIMEOUT_MS = 10_000

/**
 * 宿主事件循环延迟（ms）监视：探针超时若发生在宿主自身卡顿期间（多兆字节提交 / GC / 同步哈希），
 * 全服务会**同时**报超时——据此杀服务会把一次卡顿放大成级联重启、丢掉在途回合。
 * 延迟高于探针超时即判定「宿主卡顿」，暂停探针与误杀判定。
 */
let eventLoopLagMs = 0
let lagMonitor: NodeJS.Timeout | null = null

function ensureLagMonitor(): void {
  if (lagMonitor !== null) return
  const intervalMs = 1000
  let last = Date.now()
  lagMonitor = setInterval(() => {
    const now = Date.now()
    eventLoopLagMs = Math.max(0, now - last - intervalMs)
    last = now
  }, intervalMs)
  lagMonitor.unref?.()
}

function hostLagging(timeoutMs: number): boolean {
  return eventLoopLagMs > timeoutMs
}

/** 已装载身份（供 `status.loaded`）：数据身份（无服务）也在列。 */
export interface LoadedIdentity {
  id: string
  gen: Hash
  service: boolean
}

export interface AssemblyRuntimeHandle {
  loaded: () => LoadedIdentity[]
  endpoints: EndpointTable
  order: string[]
  /** A6 换代跟随：链头推进后交新世界，宿主自身 active 换代 / 依赖退役在此落地。 */
  applyWorld: (world: World) => Promise<void>
  stop: () => Promise<void>
}

export interface StartAssemblyOptions {
  root: string
  world: World
  log: (record: LifecycleRecord) => void
  onEvent?: (impl: string, topic: string, payload: Json) => void
  /** 测试可注入更短的握手超时；缺省 10s。 */
  handshakeTimeoutMs?: number
  /** 测试可注入更短的 reload/ack 超时；缺省 10s。 */
  reloadTimeoutMs?: number
  /** 装配同层并发上限；缺省 `DEFAULT_START_CONCURRENCY`，测试可注入 1 或更大以观测重叠。 */
  startConcurrency?: number
  /** 服务启动包装器（宿主侧最小沙箱形态）；缺省无（零行为变化）。 */
  startWrapper?: string
  /** 依赖缓存目录；缺省由 root 派生的 `state/deps`。 */
  depsDir?: string
  /** 源码 CAS 目录；缺省由 root 派生的 `state/blobs`。 */
  blobsDir?: string
  /** 物化后的依赖恢复 / 构建；缺省按声明绑定 `restoreDependencies`，测试可注入桩。 */
  restore?: (cwd: string, decl: PluginDecl) => Promise<void>
  /**
   * 投递包源目录解析（大资产直拷用）：缺省按 `state/plugins.json` 解析；测试可注入。
   * 返回 null 表示该身份无已知源目录。
   */
  sourceRoot?: (identity: string) => string | null
  /** 反向调用（服务 → 宿主）转发；缺省不接线（`port.call` 得 `not_loaded`）。 */
  onPortCall?: (
    impl: string,
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
}

class AssemblyRuntime implements AssemblyRuntimeHandle {
  readonly endpoints = new EndpointTable()
  order: string[] = []

  private world: World
  private ownerIndex: Map<Hash, string>
  private readonly log: (record: LifecycleRecord) => void
  private readonly onEvent?: (impl: string, topic: string, payload: Json) => void
  private readonly handshakeTimeoutMs: number
  private readonly reloadTimeoutMs: number
  private readonly startConcurrency: number
  private readonly startWrapper: string | undefined
  private readonly restore: (cwd: string, decl: PluginDecl) => Promise<void>
  private readonly sourceRoot: (identity: string) => string | null
  private readonly onPortCall?: (
    impl: string,
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
  private readonly paths: HostPaths
  private readonly blobsDir: string
  private readonly plan: AssemblyPlan
  private readonly depsOf = new Map<string, string[]>()
  private readonly dependents = new Map<string, string[]>()
  private readonly isolated = new Set<string>()
  private readonly loadedIds = new Set<string>()
  private readonly services = new Map<string, ServiceRuntime>()
  private readonly pendingRestarts = new Set<Promise<void>>()
  /** 换人序所需能力的闭包视图，交 `swap.ts` 用；不暴露运行时私有状态。 */
  private readonly swapHost: SwapHost
  private stopping = false

  constructor(options: StartAssemblyOptions) {
    this.world = options.world
    this.log = options.log
    this.onEvent = options.onEvent
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.reloadTimeoutMs = options.reloadTimeoutMs ?? DEFAULT_RELOAD_TIMEOUT_MS
    this.startConcurrency = options.startConcurrency ?? DEFAULT_START_CONCURRENCY
    this.startWrapper = options.startWrapper
    this.paths = hostPaths(options.root)
    this.blobsDir = options.blobsDir ?? this.paths.blobsDir
    const depsDir = options.depsDir ?? this.paths.depsDir
    this.restore =
      options.restore ??
      ((cwd, decl) => restoreDependencies(cwd, depsDir, decl.build, undefined, this.startWrapper))
    this.sourceRoot =
      options.sourceRoot ?? ((identity) => resolvePluginSourceRoot(this.paths.root, identity))
    this.onPortCall = options.onPortCall
    this.plan = computeAssemblyPlan(options.world)
    this.ownerIndex = buildOwnerIndex(options.world)
    this.swapHost = {
      isStopping: () => this.stopping,
      isIsolated: (id) => this.isolated.has(id),
      serviceOf: (id) => this.services.get(id),
      adoptService: (service) => {
        this.services.set(service.id, service)
        this.registerEndpoints(service)
        this.startHealth(service)
      },
      removeService: (id, service) => {
        if (this.services.get(id) === service) this.services.delete(id)
      },
      launch: (id, gen, decl) => this.launch(id, gen, decl),
      prepare: (id, gen, decl) => this.prepare(id, gen, decl),
      launchPrepared: (id, gen, decl, prepared) => this.launchPrepared(id, gen, decl, prepared),
      rekeyEndpoints: (service, gen, decl) => this.rekeyEndpoints(service, gen, decl),
      clearRestart: (service) => this.clearRestart(service),
      recordStartFailure: (id, gen, err) => this.recordStartFailure(id, gen, err),
      stopSuperseded: (service, reason) => this.stopSuperseded(service, reason),
      scheduleGenerationRetry: (carrier, gen, decl) =>
        this.scheduleGenerationRetry(carrier, gen, decl),
    }
  }

  /**
   * A6 换代跟随：世界推进后，只对本插件**自身代码世代换代**动作（依赖换代不重装）；
   * `retire` / `set_active(null)` 走运行期 fail-closed 隔离（反向可达的发出者一并下线）。
   * G7 A1：数据世代变化（active 在代码 / 数据世代间移动）**不判 stale、不隔离、不动服务**。
   * 只读新世界、只改运行态（端点表 / 进程 / 隔离集），不写链、不改 active。
   */
  async applyWorld(next: World): Promise<void> {
    if (this.stopping) return
    const prev = this.world
    this.world = next
    this.ownerIndex = buildOwnerIndex(next)
    this.buildDependencyMaps()
    const ids = new Set([...Object.keys(prev.ids), ...Object.keys(next.ids)])
    const changed: string[] = []
    const retired: string[] = []
    for (const id of [...ids].sort()) {
      const beforeIdentity = prev.ids[id]
      const beforeActive = beforeIdentity?.active ?? null
      const afterActive = next.ids[id]?.active ?? null
      if (afterActive === null) {
        if (beforeActive !== null) retired.push(id)
        continue
      }
      const beforeCode =
        beforeIdentity === undefined ? null : (assemblyGen(prev, id)?.payload ?? null)
      const afterCode = assemblyGen(next, id)?.payload ?? null
      // 代码世代变化才跟随；数据世代变化（beforeCode === afterCode）不动作
      if (beforeCode !== afterCode || beforeActive === null) changed.push(id)
    }
    try {
      for (const id of changed) await this.followGeneration(prev, next, id)
      for (const id of retired) await this.retireBranch(id)
    } catch (err) {
      // 跟随未全部成功：世界与索引回到 prev，使「从已应用世界 diff」在下次调用时仍视这些身份为待跟随。
      // 注意：本方法**不会自动重试同一链头**，也**不回滚已完成的部分副作用**（已起 / 已停的服务）；
      // 只有当宿主再次以更高链头调用 applyWorld 时，才会从 prev 重新 diff 并重试变更身份。
      // 故失败窗口内运行态可能与世界短暂不一致，属已知残留风险，由下一次跟随收敛。
      this.world = prev
      this.ownerIndex = buildOwnerIndex(prev)
      this.buildDependencyMaps()
      throw err
    }
  }

  async start(): Promise<void> {
    for (const event of this.plan.events) {
      this.record('dep', event.kind, { impl: event.id })
    }
    this.buildDependencyMaps()
    // 按依赖层起：同层无依赖边可并发（带上限），层间顺序保证被依赖者先起。
    // 某身份失败时其反向可达的依赖者（必在更晚的层）会在本层结束前被标隔离，
    // 故后续层的 dep 判定仍读到一致的装载状态，不出现半更新。
    const layers = computeStartLayers(this.plan.order, this.depsOf)
    for (const layer of layers) {
      await runWithConcurrency(layer, this.startConcurrency, (id) => this.startIdentity(id))
    }
    this.order = [...this.plan.order]
  }

  loaded(): LoadedIdentity[] {
    const out: LoadedIdentity[] = []
    for (const id of Object.keys(this.world.ids).sort()) {
      if (!this.loadedIds.has(id)) continue
      const gen = this.assemblyGenOf(id)
      if (gen !== null) out.push({ id, gen: gen.payload, service: this.services.has(id) })
    }
    return out
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    // 多服务并发 teardown：各服务的 drain / 终止 / 等退出相互独立，串行等待会把停机最坏拖成 N×EXIT_WAIT_MS。
    // 状态变更（从 services 摘除、清计时器）在各 stopService 的同步段按停机序依次完成，随后才并发等待。
    const teardown = [...this.order].reverse().map((id) => this.stopService(id))
    await Promise.allSettled(teardown)
    // 等在途重启落地（其内部会看到 stopping 并停掉刚起的服务），再清表
    await Promise.allSettled([...this.pendingRestarts])
    this.endpoints.clear()
    this.loadedIds.clear()
  }

  /** 停机单个服务：排空 → 终止 → 有界等退出；已受理退出的只等退出。 */
  private async stopService(id: string): Promise<void> {
    const service = this.services.get(id)
    if (service === undefined) return
    this.services.delete(id)
    this.clearHealth(service)
    this.clearRestart(service)
    service.draining = true
    if (service.handledExit) {
      // 退出已受理：仍等它真正落定再继续，避免停机返回时残留未回收进程
      await waitForExit(service.proc, EXIT_WAIT_MS)
      return
    }
    service.handledExit = true
    try {
      await service.link.drain(service.restart.drainMs, service.restart.drainMs + 1_000)
      stopChild(service.proc, service.link)
    } catch {
      stopChild(service.proc, service.link)
      this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'drain_timeout' })
    }
    await waitForExit(service.proc, EXIT_WAIT_MS)
  }

  private record(kind: LifecycleKind, event: string, fields: LifecycleFields = {}): void {
    this.log({ at: Date.now(), kind, event, ...fields })
  }

  /** 装配取用世代（G7 A1）：最近代码世代；无代码世代回落 active；retired → null。 */
  private assemblyGenOf(id: string): Gen | null {
    return assemblyGen(this.world, id)
  }

  /** 依赖图（谁 pins 谁）按当前世界重算：换代会改 pins，退役隔离靠它取反向可达。 */
  private buildDependencyMaps(): void {
    this.depsOf.clear()
    this.dependents.clear()
    for (const id of Object.keys(this.world.ids).sort()) {
      const gen = this.assemblyGenOf(id)
      const deps = new Set<string>()
      for (const pin of Object.values(gen?.pins ?? {})) {
        // 保留能力类 `host`：不是世界身份，不构成依赖边
        if (pin === HOST_CAPABILITY) continue
        const owner = this.ownerIndex.get(pin)
        if (owner !== undefined) deps.add(owner)
      }
      this.depsOf.set(id, [...deps])
      for (const dep of deps) {
        const list = this.dependents.get(dep)
        if (list === undefined) this.dependents.set(dep, [id])
        else list.push(id)
      }
    }
  }

  private reverseReachable(seeds: Iterable<string>): Set<string> {
    const reached = new Set<string>()
    const queue: string[] = []
    for (const seed of seeds) {
      if (!reached.has(seed)) {
        reached.add(seed)
        queue.push(seed)
      }
    }
    while (queue.length > 0) {
      const current = queue.pop() as string
      for (const dependent of this.dependents.get(current) ?? []) {
        if (!reached.has(dependent)) {
          reached.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return reached
  }

  private async startIdentity(id: string): Promise<void> {
    if (this.isolated.has(id)) return
    const deps = this.depsOf.get(id) ?? []
    if (deps.some((dep) => !this.loadedIds.has(dep))) {
      this.record('dep', 'stale', { impl: id })
      this.isolated.add(id)
      return
    }
    const read = readPluginDecl(this.world, id, this.blobsDir)
    if (read === null) {
      this.record('service', 'start_failed', { impl: id, reason: 'bad_plugin_decl' })
      this.isolated.add(id)
      return
    }
    // G7 A1：服务按「最近代码世代」起（数据世代可能正处 active，不参与物化 / 声明）
    const gen = read.gen
    if (read.decl.start.trim().length === 0) {
      // 数据身份 = 无执行件且未声命令。声明了 execute 成员却没给 start：坏声明，隔离
      const hasExecute = read.decl.members.some((member) => member.kind === 'execute')
      if (hasExecute) {
        this.record('service', 'start_failed', {
          impl: id,
          gen: gen.payload,
          reason: 'missing_start_command',
        })
        await this.isolateStartFailure(id)
        return
      }
      this.loadedIds.add(id)
      return
    }
    try {
      const service = await this.launch(id, gen.payload, read.decl)
      // 启动窗口内该身份可能已被别的坏分支隔离（在途 launch）：不得复活
      if (this.stopping || this.isolated.has(id)) {
        if (!this.stopping) this.record('dep', 'stale', { impl: id })
        stopChild(service.proc, service.link)
        await waitForExit(service.proc, EXIT_WAIT_MS)
        return
      }
      this.services.set(id, service)
      this.loadedIds.add(id)
      this.registerEndpoints(service)
      this.startHealth(service)
    } catch (err) {
      await this.handleStartFailure(id, gen.payload, err)
    }
  }

  /** 记一条起服务 / 握手失败；是否隔离由调用方决定（装配期隔离，换代失败保留旧世代）。 */
  private recordStartFailure(id: string, gen: Hash, err: unknown): void {
    const failure = classifyStartFailure(err)
    if (failure.event === 'handshake') {
      this.record('handshake', 'failed', { impl: id, gen })
    } else {
      this.record('service', 'start_failed', { impl: id, gen, reason: failure.reason })
    }
  }

  private async handleStartFailure(id: string, gen: Hash, err: unknown): Promise<void> {
    this.recordStartFailure(id, gen, err)
    await this.isolateStartFailure(id)
  }

  /** 起服务失败 / 坏声明的分支隔离：该身份 + 反向可达依赖者。 */
  private async isolateStartFailure(id: string): Promise<void> {
    const reached = this.reverseReachable([id])
    for (const other of reached) {
      if (other !== id) this.record('dep', 'stale', { impl: other })
    }
    await this.isolateAll(reached)
  }

  /**
   * 下线一批身份：停服务、摘端点、移出已装载、标记隔离（坏分支只隔离，绝不回落）。
   * terminate 后统一有界 `waitForExit` 再结算；状态变更同步完成，退出回收在末尾一并等待。
   */
  private async isolateAll(ids: Iterable<string>): Promise<void> {
    const exits: Promise<void>[] = []
    for (const id of ids) {
      const service = this.services.get(id)
      if (service !== undefined) {
        this.services.delete(id)
        this.clearHealth(service)
        this.clearRestart(service)
        service.draining = true
        if (!service.handledExit) {
          service.handledExit = true
          stopChild(service.proc, service.link)
          this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'isolated' })
          exits.push(waitForExit(service.proc, EXIT_WAIT_MS))
        }
      }
      this.endpoints.removeIdentity(id)
      this.loadedIds.delete(id)
      this.isolated.add(id)
    }
    await Promise.allSettled(exits)
  }

  /**
   * 单个身份自身**代码世代**换代后的跟随（A6 + G7 A1）：
   * 数据变化 → reload/ack（进程不动）；代码变化 → 起新服务、旧服务 drain；
   * 全新身份 → 按装配同路起（依赖未装载则隔离）；新代码世代构建 / 启动失败 → 新世代不激活，
   * 旧服务继续服务（失败只记运维日志）。数据世代只影响投影读侧，不进本路径。
   */
  private async followGeneration(prev: World, next: World, id: string): Promise<void> {
    if (this.stopping || this.isolated.has(id)) return
    const identity = next.ids[id]
    const newCodeGen = assemblyGen(next, id)
    const newDecl =
      newCodeGen === null ? null : readPluginDeclOfGen(next, newCodeGen, this.blobsDir)
    const payloadDef = newCodeGen === null ? undefined : next.defs[newCodeGen.payload]
    if (
      identity === undefined ||
      newCodeGen === null ||
      newDecl === null ||
      payloadDef === undefined ||
      stale(payloadDef, next, id)
    ) {
      this.record('dep', 'stale', { impl: id })
      await this.isolateAll(this.reverseReachable([id]))
      return
    }
    const oldCodeGen = assemblyGen(prev, id)
    if (oldCodeGen === null) {
      // 全新身份（或从 active=null 重新激活）：与装配同路起服务
      await this.startIdentity(id)
      this.noteRuntimeStart(id)
      return
    }
    const oldService = this.services.get(id)
    if (newDecl.decl.start.trim().length === 0) {
      // 新世代没有执行件：声明了 execute 成员 → 坏声明；否则退化为数据身份
      const hasExecute = newDecl.decl.members.some((member) => member.kind === 'execute')
      if (hasExecute) {
        this.record('service', 'start_failed', {
          impl: id,
          gen: newCodeGen.payload,
          reason: 'missing_start_command',
        })
        await this.isolateAll(this.reverseReachable([id]))
        return
      }
      if (oldService !== undefined) await this.retireService(id, oldService, 'superseded')
      return
    }
    if (oldService === undefined) {
      await this.startIdentity(id)
      this.noteRuntimeStart(id)
      return
    }
    if (classifyGenerationChange(prev, oldCodeGen, next, newCodeGen, this.blobsDir) === 'data') {
      const reloaded = await this.tryReload(oldService, newCodeGen.payload)
      if (this.stopping || this.isolated.has(id)) return
      if (reloaded) {
        this.rekeyEndpoints(oldService, newCodeGen.payload, newDecl.decl)
        return
      }
      // reload 未确认：保守按代码换代（起新服务 + 旧服务 drain），不把旧进程当已热更新
    }
    await swapService(this.swapHost, id, oldService, newCodeGen.payload, newDecl.decl)
  }

  /** 数据换代：通知服务新世代并等 ack；超时 / 通道断返回 false（交调用方保守处理）。 */
  private async tryReload(service: ServiceRuntime, gen: Hash): Promise<boolean> {
    try {
      await service.link.reload(gen, this.reloadTimeoutMs)
      return true
    } catch {
      return false
    }
  }

  /** 端点重挂：进程不动，端点行从旧 gen 键换到新 gen 键（同 link / pid）。 */
  private rekeyEndpoints(service: ServiceRuntime, gen: Hash, decl: PluginDecl): void {
    // 纵深防御：停机 / 已隔离后不得重挂端点（调用方已守卫，此处再挡一层）
    if (this.stopping || this.isolated.has(service.id)) return
    this.endpoints.removeGeneration(service.id, service.gen)
    this.clearHealth(service)
    service.gen = gen
    service.decl = decl
    service.restart = parseRestart(decl.restart)
    service.health = parseHealth(decl.health)
    this.registerEndpoints(service)
    this.startHealth(service)
  }

  /** 排空并停掉被换代取代的服务（不重启）；退出路径记 service.exit。 */
  private async stopSuperseded(service: ServiceRuntime, reason: string): Promise<void> {
    this.clearHealth(service)
    this.clearRestart(service)
    service.draining = true
    let drainReason = reason
    try {
      await service.link.drain(service.restart.drainMs, service.restart.drainMs + 1_000)
    } catch {
      drainReason = 'drain_timeout'
    }
    this.endpoints.removeGeneration(service.id, service.gen)
    this.record('service', 'exit', { impl: service.id, gen: service.gen, reason: drainReason })
    stopChild(service.proc, service.link)
    await waitForExit(service.proc, EXIT_WAIT_MS)
  }

  /** 新世代无执行件：旧服务按换代路径退场，身份保留为数据身份。 */
  private async retireService(id: string, service: ServiceRuntime, reason: string): Promise<void> {
    if (this.services.get(id) === service) this.services.delete(id)
    await this.stopSuperseded(service, reason)
    this.endpoints.removeIdentity(id)
  }

  /**
   * 独占序下旧服务已 drain、新世代起不来：把该身份的换代失败转入「无服务但保留世代」
   * （端点缺席 → 调用得 `not_loaded`），按 `restart` 策略重试新世代。
   * 不复活已 drain 的旧进程——那会让运行服务停在旧代码世代，违反「不拿更旧世代顶上」。
   * 复用崩溃重启路径（`attemptRestart`）避免两套重启机：已退场的旧 `ServiceRuntime` 只剩
   * 策略与计时状态，就地改写成新世代的载体即可；重试超限同样记 `restart_exhausted` 并隔离分支。
   */
  private scheduleGenerationRetry(carrier: ServiceRuntime, gen: Hash, decl: PluginDecl): void {
    carrier.gen = gen
    carrier.decl = decl
    carrier.restart = parseRestart(decl.restart)
    carrier.health = parseHealth(decl.health)
    carrier.attempts = 0
    this.countRestartAttempt(carrier)
  }

  /** 运行期新起的身份补进停机序（反序停机时一并 drain）。 */
  private noteRuntimeStart(id: string): void {
    if (!this.loadedIds.has(id)) return
    if (!this.order.includes(id)) this.order.push(id)
  }

  /** 依赖退役（retire / set_active(null)）：反向可达的发出者及其依赖者一并隔离，不回落。 */
  private async retireBranch(seed: string): Promise<void> {
    const reached = this.reverseReachable([seed])
    for (const id of [...reached].sort()) {
      this.record('dep', 'retired', { impl: id })
    }
    await this.isolateAll(reached)
  }

  /** 起服务公共依赖：spawn 阶段与一次性入口共用；`copyAssets` 有记账副作用，另由准备入口单独绑定。 */
  private launcherDeps(id: string): ServiceLauncherDeps {
    return {
      world: this.world,
      materializedDir: this.paths.materializedDir,
      blobsDir: this.blobsDir,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      pluginStateDir: resolve(this.paths.pluginsDir, id),
      startWrapper: this.startWrapper,
      restore: this.restore,
      onPortCall:
        this.onPortCall === undefined
          ? undefined
          : (port, method, args, env) => this.onPortCall!(id, port, method, args, env),
      onServiceEvent: this.onEvent,
      onExtraDropped: (impl, extraGen, caps) =>
        this.record('handshake', 'extra_dropped', { impl, gen: extraGen, caps }),
      onChannelClosed: (service, reason) => this.handleChannelClosed(service, reason),
      onExit: (service, reason) => this.handleProcessExit(service, reason),
    }
  }

  /** 身份名不安全时拒绝起服务（路径穿越 / 非法目录名），否则 `state/plugins/<id>/` 会逃出插件区。 */
  private rejectUnsafeIdentity(id: string, gen: Hash): boolean {
    if (isSafeIdentityName(id)) return false
    this.record('service', 'start_failed', { impl: id, gen, reason: 'bad_identity' })
    return true
  }

  private launch(id: string, gen: Hash, decl: PluginDecl): Promise<ServiceRuntime> {
    // 运行期写指令可造任意 id；身份名不安全（路径穿越 / 非法目录名）时拒绝起服务，
    // 否则 `state/plugins/<id>/` 会逃出插件区、被当可写状态交给插件进程。
    if (this.rejectUnsafeIdentity(id, gen)) {
      return Promise.reject(new ServiceStartError('bad_identity'))
    }
    return launchService(
      { ...this.launcherDeps(id), copyAssets: this.assetsCopyOf(id) },
      id,
      gen,
      decl,
    )
  }

  /** 准备阶段：物化 + 资产直拷 + 依赖恢复 / 构建；不 spawn，独占序可在 drain 旧实例前先调。 */
  private prepare(id: string, gen: Hash, decl: PluginDecl): Promise<PreparedService> {
    if (this.rejectUnsafeIdentity(id, gen)) {
      return Promise.reject(new ServiceStartError('bad_identity'))
    }
    return prepareService(
      { ...this.launcherDeps(id), copyAssets: this.assetsCopyOf(id) },
      gen,
      decl,
    )
  }

  /** spawn 阶段：在准备产物上起进程并握手（不再物化）。 */
  private launchPrepared(
    id: string,
    gen: Hash,
    decl: PluginDecl,
    prepared: PreparedService,
  ): Promise<ServiceRuntime> {
    return spawnService(this.launcherDeps(id), id, gen, decl, prepared)
  }

  /**
   * 投递目录大资产直拷的绑定：`schema.assets_manifest` 声明非法只记运维日志、按无清单处理；
   * 有合法清单但源目录未知 → 直拷必失败（`deps_failed`），不静默跳过（缺资产会让构建 / 运行失败得更晚）。
   */
  private assetsCopyOf(id: string): ((cwd: string) => void) | undefined {
    const manifest = readAssetsManifest(this.world, id)
    if (!manifest.ok) {
      this.record('dep', 'periodic_invalid', { impl: id, reason: manifest.reason })
      return undefined
    }
    if (manifest.entries.length === 0) return undefined
    const sourceDir = this.sourceRoot(id)
    if (sourceDir === null) {
      return () => {
        throw new ServiceStartError('deps_failed')
      }
    }
    return (cwd) => copyAssetsManifest(manifest.entries, sourceDir, cwd)
  }

  private registerEndpoints(service: ServiceRuntime): void {
    for (const cap of service.decl.implements) {
      for (const method of service.decl.methods[cap] ?? []) {
        this.endpoints.add({
          impl: service.id,
          gen: service.gen,
          cap,
          method,
          transport: 'stdio',
          pid: service.pid,
          link: service.link,
        })
      }
    }
  }

  private startHealth(service: ServiceRuntime): void {
    if (service.health.intervalMs <= 0) return
    service.healthTimer = setInterval(() => {
      void this.probe(service)
    }, service.health.intervalMs)
    service.healthTimer.unref?.()
  }

  private async probe(service: ServiceRuntime): Promise<void> {
    ensureLagMonitor()
    // 在途调用时暂停探针：服务帧循环把 `probe` 排在在途调用之后，忙时探针必超时（误杀长调用）。
    // 宿主自身卡顿（事件循环延迟 > 探针超时）时同样暂停：此时的超时不是服务的问题。
    if (
      this.stopping ||
      service.handledExit ||
      service.draining ||
      service.healthInFlight ||
      service.link.hasInflightCall() ||
      hostLagging(service.health.timeoutMs)
    ) {
      return
    }
    service.healthInFlight = true
    try {
      const ok = await service.link.probe(service.health.timeoutMs)
      if (!ok) await this.markUnhealthy(service)
    } catch {
      await this.markUnhealthy(service)
    } finally {
      service.healthInFlight = false
    }
  }

  /**
   * 探针无回应 / `ok:false`：按服务退出路径处理（杀进程树 → 重启）。在途调用视为健康，不误杀。
   * terminate 后有界 `waitForExit` 再结算；`healthInFlight` 在整个探针期间为真，挡住重入。
   */
  private async markUnhealthy(service: ServiceRuntime): Promise<void> {
    if (service.handledExit || this.stopping || service.draining || service.link.hasInflightCall())
      return
    // 宿主卡顿导致的超时不据此杀服务：延迟高于探针超时说明是宿主自身被拖住，不是服务哑了。
    if (hostLagging(service.health.timeoutMs)) return
    service.pendingExitReason = 'health_timeout'
    terminateChild(service.proc)
    await waitForExit(service.proc, EXIT_WAIT_MS)
    this.handleProcessExit(service, 'health_timeout')
  }

  private handleChannelClosed(service: ServiceRuntime, reason: string): void {
    if (service.handledExit || this.stopping || service.draining) return
    // 通道断多半是进程已在退出：先让退出事件带真实 code 收尾；到期还没退再强杀（服务已哑但未死）
    if (service.channelCloseTimer === null) {
      service.channelCloseTimer = setTimeout(() => {
        service.channelCloseTimer = null
        if (service.proc.exitCode === null && service.proc.signalCode === null) {
          terminateChild(service.proc)
        }
        this.handleProcessExit(service, reason)
      }, 200)
      service.channelCloseTimer.unref?.()
    }
  }

  private handleProcessExit(service: ServiceRuntime, reason: string): void {
    if (service.handledExit) return
    service.handledExit = true
    this.clearHealth(service)
    if (service.channelCloseTimer !== null) {
      clearTimeout(service.channelCloseTimer)
      service.channelCloseTimer = null
    }
    if (this.stopping || service.draining || this.isolated.has(service.id)) return
    // 进程已死：该 gen 的端点不可用，先摘除；重启成功后重挂
    this.endpoints.removeGeneration(service.id, service.gen)
    this.record('service', 'exit', {
      impl: service.id,
      gen: service.gen,
      reason: service.pendingExitReason ?? reason,
    })
    // 已被换代取代（自身 active 不再是本 gen）→ 不重启旧世代（A6：绝不回落）
    if (this.assemblyGenOf(service.id)?.payload !== service.gen) return
    // 声明 never：不重启，退出即隔离该分支（退出监听无法 await，隔离内部的退出回收自成一体）
    if (service.restart.policy === 'never') {
      void this.isolateBranch(service.id)
      return
    }
    // 稳定复位只看【本次真实运行时长】：活过 window 才清零；握手成功与否不复位
    if (Date.now() - service.startedAt >= service.restart.windowMs) service.attempts = 0
    this.countRestartAttempt(service)
  }

  /**
   * 记一次重启尝试：自增 → 超限隔离，否则退避后再起。
   * 不复位 window——relaunch 失败重试同样计数，避免「每次失败都清零、永不超限」。
   */
  private countRestartAttempt(service: ServiceRuntime): void {
    // 隔离 / 已被换代取代后不得再排程（防御：当前调用点均已先判，且中途无 await）
    if (this.stopping || this.isolated.has(service.id)) return
    if (this.assemblyGenOf(service.id)?.payload !== service.gen) return
    service.attempts += 1
    if (service.attempts > service.restart.max) {
      this.record('service', 'restart_exhausted', { impl: service.id, gen: service.gen })
      void this.isolateBranch(service.id)
      return
    }
    const delay = backoffDelay(service.restart, service.attempts)
    service.restartTimer = setTimeout(() => {
      const tracked: Promise<void> = this.attemptRestart(service).finally(() => {
        this.pendingRestarts.delete(tracked)
      })
      this.pendingRestarts.add(tracked)
    }, delay)
    service.restartTimer.unref?.()
  }

  private async attemptRestart(service: ServiceRuntime): Promise<void> {
    // 防御：隔离时 isolateBranch 已 clearRestart 清掉未触发的 timer；换代取代同理不重启
    if (this.stopping || this.isolated.has(service.id)) return
    if (this.assemblyGenOf(service.id)?.payload !== service.gen) return
    try {
      const next = await this.launch(service.id, service.gen, service.decl)
      // 重启窗口内该身份可能已被隔离 / 换代：不得复活
      if (this.stopping || this.isolated.has(service.id)) {
        stopChild(next.proc, next.link)
        await waitForExit(next.proc, EXIT_WAIT_MS)
        return
      }
      if (this.assemblyGenOf(service.id)?.payload !== service.gen) {
        stopChild(next.proc, next.link)
        await waitForExit(next.proc, EXIT_WAIT_MS)
        return
      }
      next.attempts = service.attempts
      this.services.set(service.id, next)
      this.endpoints.removeGeneration(service.id, service.gen)
      this.registerEndpoints(next)
      this.startHealth(next)
    } catch (err) {
      // 承重守卫：等待 launch 期间该身份可能已被别的坏分支隔离 / 换代 → 不再记失败、不再排程
      if (this.isolated.has(service.id)) return
      if (this.assemblyGenOf(service.id)?.payload !== service.gen) return
      const failure = classifyStartFailure(err)
      if (failure.event === 'handshake') {
        this.record('handshake', 'failed', { impl: service.id, gen: service.gen })
      } else {
        this.record('service', 'start_failed', {
          impl: service.id,
          gen: service.gen,
          reason: failure.reason,
        })
      }
      this.countRestartAttempt(service)
    }
  }

  /** 隔离坏分支：种子 + 反向可达依赖者下线（停服务、清端点、移出已装载）。 */
  private async isolateBranch(seed: string): Promise<void> {
    await this.isolateAll(this.reverseReachable([seed]))
  }

  private clearHealth(service: ServiceRuntime): void {
    if (service.healthTimer !== null) {
      clearInterval(service.healthTimer)
      service.healthTimer = null
    }
  }

  private clearRestart(service: ServiceRuntime): void {
    if (service.restartTimer !== null) {
      clearTimeout(service.restartTimer)
      service.restartTimer = null
    }
  }
}

/** 起装配运行时：按装配计划逐身份物化 / 起服务 / 握手；坏分支隔离，其余照常。 */
export async function startAssembly(options: StartAssemblyOptions): Promise<AssemblyRuntimeHandle> {
  const runtime = new AssemblyRuntime(options)
  await runtime.start()
  return runtime
}
