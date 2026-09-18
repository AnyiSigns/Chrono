// 装配运行时：装配计划 → 实际服务进程（物化 / 握手 / 健康重启 / 停机）。
// 只读世界：不写链、不改 active；生命周期事件经注入的 log 落运维日志（state/lifecycle.log）。
// 坏分支只隔离：握手不过 / 重启超限 → 该身份及其依赖者标 not_loaded，其余照常。

import { buildOwnerIndex, computeAssemblyPlan } from './closure.ts'
import { readPluginDecl } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { launchService } from './service-launcher.ts'
import { EndpointTable } from '../endpoint-table.ts'
import { hostPaths } from '../paths.ts'
import type { HostPaths } from '../paths.ts'
import type { AssemblyPlan } from './closure.ts'
import {
  backoffDelay,
  classifyStartFailure,
  stopChild,
  terminateChild,
  waitForExit,
} from './supervision.ts'
import type { ServiceRuntime } from './supervision.ts'
import type { LifecycleKind, LifecycleRecord } from '../lifecycle.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

/** 未声明超时时的握手上限；仅连接建立用，不是效果调用超时。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

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
  stop: () => Promise<void>
}

export interface StartAssemblyOptions {
  root: string
  world: World
  log: (record: LifecycleRecord) => void
  onEvent?: (impl: string, topic: string, payload: Json) => void
  /** 测试可注入更短的握手超时；缺省 10s。 */
  handshakeTimeoutMs?: number
}

type LifecycleFields = Omit<LifecycleRecord, 'at' | 'kind' | 'event'>

class AssemblyRuntime implements AssemblyRuntimeHandle {
  readonly endpoints = new EndpointTable()
  order: string[] = []

  private readonly world: World
  private readonly log: (record: LifecycleRecord) => void
  private readonly onEvent?: (impl: string, topic: string, payload: Json) => void
  private readonly handshakeTimeoutMs: number
  private readonly paths: HostPaths
  private readonly plan: AssemblyPlan
  private readonly ownerIndex: Map<Hash, string>
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
    this.paths = hostPaths(options.root)
    this.plan = computeAssemblyPlan(options.world)
    this.ownerIndex = buildOwnerIndex(options.world)
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
      const gen = this.activeGen(id)
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

  private activeGen(id: string): { payload: Hash; pins: Record<string, Hash>; sig: Hash } | null {
    const identity = this.world.ids[id]
    if (identity === undefined || identity.active === null) return null
    return identity.gens.find((gen) => gen.payload === identity.active) ?? null
  }

  private buildDependencyMaps(): void {
    for (const id of this.plan.order) {
      const gen = this.activeGen(id)
      const deps = new Set<string>()
      for (const pin of Object.values(gen?.pins ?? {})) {
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
    const gen = this.activeGen(id)
    if (read === null || gen === null) {
      this.record('service', 'start_failed', {
        impl: id,
        gen: gen?.payload,
        reason: 'bad_plugin_decl',
      })
      this.isolated.add(id)
      return
    }
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
    for (const reached of this.reverseReachable([id])) {
      if (reached !== id) this.record('dep', 'stale', { impl: reached })
      this.isolated.add(reached)
    }
  }

  private launch(id: string, gen: Hash, decl: PluginDecl): Promise<ServiceRuntime> {
    return launchService(
      {
        world: this.world,
        materializedDir: this.paths.materializedDir,
        handshakeTimeoutMs: this.handshakeTimeoutMs,
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
    // 隔离后不得再排程（防御：当前调用点均已先判 isolated，且中途无 await）
    if (this.stopping || this.isolated.has(service.id)) return
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
    // 防御：隔离时 isolateBranch 已 clearRestart 清掉未触发的 timer
    if (this.stopping || this.isolated.has(service.id)) return
    try {
      const next = await this.launch(service.id, service.gen, service.decl)
      // 重启窗口内该身份可能已被隔离：不得复活
      if (this.stopping || this.isolated.has(service.id)) {
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
      // 承重守卫：等待 launch 期间该身份可能已被别的坏分支隔离 → 不再记失败、不再排程
      if (this.isolated.has(service.id)) return
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
    for (const id of this.reverseReachable([seed])) {
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
