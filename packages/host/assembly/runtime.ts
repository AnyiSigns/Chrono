// 装配运行时：装配计划 → 实际服务进程（物化 / 握手 / 健康重启 / 换代跟随 / 停机）。
// 只读世界：不写链、不改 active；生命周期事件经注入的 log 落运维日志（state/lifecycle.log）。
// 坏分支只隔离：握手不过 / 重启超限 / 依赖退役 → 该身份及其依赖者标 not_loaded，其余照常。
// A6 换代跟随：链头推进后比对世界，本插件自身**代码世代**换代才动作——数据热生效（reload/ack，
// 进程不动）/ 代码起新服务（旧服务 drain）；依赖换代不重装（A1 重解析路由），依赖退役则隔离。
// G7 A1：数据世代（同身份混合世代）变化不触发跟随 / 隔离 / 服务动作。

import { resolve } from 'node:path'
import { buildOwnerIndex, computeAssemblyPlan } from './closure.ts'
import { assemblyGen, readPluginDecl, readPluginDeclOfGen } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import { classifyGenerationChange } from './generation.ts'
import { launchService } from './service-launcher.ts'
import { restoreDependencies } from './deps.ts'
import { EndpointTable } from '../endpoint-table.ts'
import { hostPaths } from '../paths.ts'
import type { HostPaths } from '../paths.ts'
import type { AssemblyPlan } from './closure.ts'
import {
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
import type { ServiceRuntime } from './supervision.ts'
import type { LifecycleKind, LifecycleRecord } from '../lifecycle.ts'
import { stale } from '../../kernel/index.ts'
import type { Gen, Hash, Json, World } from '../../kernel/index.ts'

/** 未声明超时时的握手上限；仅连接建立用，不是效果调用超时。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** 数据换代 `reload` 等 `ack` 的上限；超时按装载失败保守改走起新服务。 */
const DEFAULT_RELOAD_TIMEOUT_MS = 10_000

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
  /** 服务启动包装器（宿主侧最小沙箱形态）；缺省无（零行为变化）。 */
  startWrapper?: string
  /** 依赖缓存目录；缺省由 root 派生的 `state/deps`。 */
  depsDir?: string
  /** 物化后的依赖恢复；缺省按清单绑定 `restoreDependencies`，测试可注入桩。 */
  restore?: (cwd: string) => Promise<void>
}

type LifecycleFields = Omit<LifecycleRecord, 'at' | 'kind' | 'event'>

class AssemblyRuntime implements AssemblyRuntimeHandle {
  readonly endpoints = new EndpointTable()
  order: string[] = []

  private world: World
  private ownerIndex: Map<Hash, string>
  private readonly log: (record: LifecycleRecord) => void
  private readonly onEvent?: (impl: string, topic: string, payload: Json) => void
  private readonly handshakeTimeoutMs: number
  private readonly reloadTimeoutMs: number
  private readonly startWrapper: string | undefined
  private readonly restore: (cwd: string) => Promise<void>
  private readonly paths: HostPaths
  private readonly plan: AssemblyPlan
  private readonly depsOf = new Map<string, string[]>()
  private readonly dependents = new Map<string, string[]>()
  private readonly isolated = new Set<string>()
  private readonly loadedIds = new Set<string>()
  private readonly services = new Map<string, ServiceRuntime>()
  private readonly pendingRestarts = new Set<Promise<void>>()
  private stopping = false

  constructor(options: StartAssemblyOptions) {
    this.world = options.world
    this.log = options.log
    this.onEvent = options.onEvent
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.reloadTimeoutMs = options.reloadTimeoutMs ?? DEFAULT_RELOAD_TIMEOUT_MS
    this.startWrapper = options.startWrapper
    this.paths = hostPaths(options.root)
    const depsDir = options.depsDir ?? this.paths.depsDir
    this.restore =
      options.restore ?? ((cwd) => restoreDependencies(cwd, depsDir, undefined, this.startWrapper))
    this.plan = computeAssemblyPlan(options.world)
    this.ownerIndex = buildOwnerIndex(options.world)
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
    for (const id of changed) await this.followGeneration(prev, next, id)
    for (const id of retired) this.retireBranch(id)
  }

  async start(): Promise<void> {
    for (const event of this.plan.events) {
      this.record('dep', event.kind, { impl: event.id })
    }
    this.buildDependencyMaps()
    for (const id of this.plan.order) {
      await this.startIdentity(id)
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
    for (const id of [...this.order].reverse()) {
      const service = this.services.get(id)
      if (service === undefined) continue
      this.services.delete(id)
      this.clearHealth(service)
      this.clearRestart(service)
      service.draining = true
      if (service.handledExit) continue
      service.handledExit = true
      try {
        await service.link.drain(service.restart.drainMs, service.restart.drainMs + 1_000)
        stopChild(service.proc, service.link)
      } catch {
        stopChild(service.proc, service.link)
        this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'drain_timeout' })
      }
      await waitForExit(service.proc, 2_000)
    }
    // 等在途重启落地（其内部会看到 stopping 并停掉刚起的服务），再清表
    await Promise.allSettled([...this.pendingRestarts])
    this.endpoints.clear()
    this.loadedIds.clear()
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
    const read = readPluginDecl(this.world, id)
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
        this.isolateStartFailure(id)
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
        await waitForExit(service.proc, 2_000)
        return
      }
      this.services.set(id, service)
      this.loadedIds.add(id)
      this.registerEndpoints(service)
      this.startHealth(service)
    } catch (err) {
      this.handleStartFailure(id, gen.payload, err)
    }
  }

  private handleStartFailure(id: string, gen: Hash, err: unknown): void {
    const failure = classifyStartFailure(err)
    if (failure.event === 'handshake') {
      this.record('handshake', 'failed', { impl: id, gen })
    } else {
      this.record('service', 'start_failed', { impl: id, gen, reason: failure.reason })
    }
    this.isolateStartFailure(id)
  }

  /** 起服务失败 / 坏声明的分支隔离：该身份 + 反向可达依赖者。 */
  private isolateStartFailure(id: string): void {
    const reached = this.reverseReachable([id])
    for (const other of reached) {
      if (other !== id) this.record('dep', 'stale', { impl: other })
    }
    this.isolateAll(reached)
  }

  /** 下线一批身份：停服务、摘端点、移出已装载、标记隔离（坏分支只隔离，绝不回落）。 */
  private isolateAll(ids: Iterable<string>): void {
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
        }
      }
      this.endpoints.removeIdentity(id)
      this.loadedIds.delete(id)
      this.isolated.add(id)
    }
  }

  /**
   * 单个身份自身**代码世代**换代后的跟随（A6 + G7 A1）：
   * 数据变化 → reload/ack（进程不动）；代码变化 → 起新服务、旧服务 drain；
   * 全新身份 → 按装配同路起（依赖未装载则隔离）；新代码世代装载失败 → 隔离该分支（不回旧世代）。
   * 数据世代只影响投影读侧，不进本路径。
   */
  private async followGeneration(prev: World, next: World, id: string): Promise<void> {
    if (this.stopping || this.isolated.has(id)) return
    const identity = next.ids[id]
    const newCodeGen = assemblyGen(next, id)
    const newDecl = newCodeGen === null ? null : readPluginDeclOfGen(next, newCodeGen)
    const payloadDef = newCodeGen === null ? undefined : next.defs[newCodeGen.payload]
    if (
      identity === undefined ||
      newCodeGen === null ||
      newDecl === null ||
      payloadDef === undefined ||
      stale(payloadDef, next, id)
    ) {
      this.record('dep', 'stale', { impl: id })
      this.isolateAll(this.reverseReachable([id]))
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
        this.isolateAll(this.reverseReachable([id]))
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
    if (classifyGenerationChange(prev, oldCodeGen, next, newCodeGen) === 'data') {
      const reloaded = await this.tryReload(oldService, newCodeGen.payload)
      if (this.stopping || this.isolated.has(id)) return
      if (reloaded) {
        this.rekeyEndpoints(oldService, newCodeGen, newDecl.decl)
        return
      }
      // reload 未确认：保守按代码换代（起新服务 + 旧服务 drain），不把旧进程当已热更新
    }
    await this.swapService(id, oldService, newCodeGen.payload, newDecl.decl)
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

  /** 数据换代后的端点重挂：进程不动，端点行从旧 gen 键换到新 gen 键（同 link / pid）。 */
  private rekeyEndpoints(service: ServiceRuntime, gen: Gen, decl: PluginDecl): void {
    this.endpoints.removeGeneration(service.id, service.gen)
    this.clearHealth(service)
    service.gen = gen.payload
    service.decl = decl
    service.restart = parseRestart(decl.restart)
    service.health = parseHealth(decl.health)
    this.registerEndpoints(service)
    this.startHealth(service)
  }

  /**
   * 代码换代：物化 + 起新服务 + 握手 → 新端点半表先挂（新 run 立即路由新 gen）→
   * 旧服务 drain（期间健康探针缺席）→ 超时强杀；旧 gen 端点行在旧进程收尾时摘除。
   * 新服务起不来 → 隔离该分支（绝不回落旧世代）。
   */
  private async swapService(
    id: string,
    oldService: ServiceRuntime,
    newGen: Hash,
    newDecl: PluginDecl,
  ): Promise<void> {
    // 先阻断旧服务的重启排程：换代期间旧 gen 不得借崩溃重启复活
    this.clearRestart(oldService)
    let next: ServiceRuntime
    try {
      next = await this.launch(id, newGen, newDecl)
    } catch (err) {
      this.handleStartFailure(id, newGen, err)
      return
    }
    if (this.stopping || this.isolated.has(id)) {
      stopChild(next.proc, next.link)
      await waitForExit(next.proc, 2_000)
      return
    }
    if (this.services.get(id) !== oldService) {
      // 防御：旧服务已被别的路径替换；新服务不得顶掉更新的实例
      stopChild(next.proc, next.link)
      await waitForExit(next.proc, 2_000)
      return
    }
    oldService.draining = true // 先停健康探针与退出重启
    this.services.set(id, next)
    this.registerEndpoints(next)
    this.startHealth(next)
    await this.stopSuperseded(oldService, 'superseded')
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
    await waitForExit(service.proc, 2_000)
  }

  /** 新世代无执行件：旧服务按换代路径退场，身份保留为数据身份。 */
  private async retireService(id: string, service: ServiceRuntime, reason: string): Promise<void> {
    if (this.services.get(id) === service) this.services.delete(id)
    await this.stopSuperseded(service, reason)
    this.endpoints.removeIdentity(id)
  }

  /** 运行期新起的身份补进停机序（反序停机时一并 drain）。 */
  private noteRuntimeStart(id: string): void {
    if (!this.loadedIds.has(id)) return
    if (!this.order.includes(id)) this.order.push(id)
  }

  /** 依赖退役（retire / set_active(null)）：反向可达的发出者及其依赖者一并隔离，不回落。 */
  private retireBranch(seed: string): void {
    const reached = this.reverseReachable([seed])
    for (const id of [...reached].sort()) {
      this.record('dep', 'retired', { impl: id })
    }
    this.isolateAll(reached)
  }

  private launch(id: string, gen: Hash, decl: PluginDecl): Promise<ServiceRuntime> {
    // 运行期写指令可造任意 id；身份名不安全（路径穿越 / 非法目录名）时拒绝起服务，
    // 否则 `state/plugins/<id>/` 会逃出插件区、被当可写状态交给插件进程。
    if (!isSafeIdentityName(id)) {
      this.record('service', 'start_failed', { impl: id, gen, reason: 'bad_identity' })
      return Promise.reject(new ServiceStartError('bad_identity'))
    }
    return launchService(
      {
        world: this.world,
        materializedDir: this.paths.materializedDir,
        handshakeTimeoutMs: this.handshakeTimeoutMs,
        pluginStateDir: resolve(this.paths.pluginsDir, id),
        startWrapper: this.startWrapper,
        restore: this.restore,
        onServiceEvent: this.onEvent,
        onExtraDropped: (impl, extraGen, caps) =>
          this.record('handshake', 'extra_dropped', { impl, gen: extraGen, caps }),
        onChannelClosed: (service, reason) => this.handleChannelClosed(service, reason),
        onExit: (service, reason) => this.handleProcessExit(service, reason),
      },
      id,
      gen,
      decl,
    )
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
    if (this.stopping || service.handledExit || service.draining || service.healthInFlight) return
    service.healthInFlight = true
    try {
      const ok = await service.link.probe(service.health.timeoutMs)
      if (!ok) this.markUnhealthy(service)
    } catch {
      this.markUnhealthy(service)
    } finally {
      service.healthInFlight = false
    }
  }

  /** 探针无回应 / `ok:false`：按服务退出路径处理（杀进程树 → 重启）。 */
  private markUnhealthy(service: ServiceRuntime): void {
    if (service.handledExit || this.stopping || service.draining) return
    service.pendingExitReason = 'health_timeout'
    terminateChild(service.proc)
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
    // 声明 never：不重启，退出即隔离该分支
    if (service.restart.policy === 'never') {
      this.isolateBranch(service.id)
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
      this.isolateBranch(service.id)
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
        await waitForExit(next.proc, 2_000)
        return
      }
      if (this.assemblyGenOf(service.id)?.payload !== service.gen) {
        stopChild(next.proc, next.link)
        await waitForExit(next.proc, 2_000)
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
  private isolateBranch(seed: string): void {
    this.isolateAll(this.reverseReachable([seed]))
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
