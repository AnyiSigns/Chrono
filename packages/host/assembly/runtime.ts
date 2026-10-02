// 装配运行时：装配计划 → 实际服务进程（物化 / 握手 / 健康重启 / 换代跟随 / 停机）。
// 只读世界：不写链、不改 active；生命周期事件经注入的 log 落运维日志（state/lifecycle.log）。
// 坏分支只隔离：握手不过 / 重启超限 / 依赖退役 → 该身份及其依赖者标 not_loaded，其余照常。
// 例外（换代跟随）：新代码世代构建 / 启动失败不隔离——新世代不激活，旧进程继续服务。
// A6 换代跟随：链头推进后比对世界，本插件自身**代码世代**换代才动作——数据热生效（reload/ack，
// 进程不动）/ 代码起新服务（旧服务 drain）；依赖换代不重装（A1 重解析路由），依赖退役则隔离。
// G7 A1：数据世代（同身份混合世代）变化不触发跟随 / 隔离 / 服务动作。

import { resolve } from 'node:path'
import { computeAssemblyPlan } from './closure.ts'
import { capabilityOwnerConflicts, effectiveMethods, manyNeedsMap } from './capability-index.ts'
import { assemblyGen, isCodeGen, needsBindingsOf, readPluginDecl, readPluginDeclOfGen } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { HOST_CAPABILITY } from '../host-methods.ts'
import type { IdentitySuspendResult } from '../host-methods.ts'
import { classifyGenerationChange } from './generation.ts'
import { launchService, prepareService, spawnService } from './service-launcher.ts'
import type { PreparedService, ServiceLauncherDeps } from './service-launcher.ts'
import {
  DEFAULT_START_CONCURRENCY,
  computeStartLayers,
  runWithConcurrency,
} from './start-layers.ts'
import { restoreDependencies } from './deps.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'
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
  teardownService,
  terminateService,
  waitForServiceExit,
} from './supervision.ts'
import { isSafeIdentityName } from '../common/paths-safe.ts'
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
 * 起服务**临时性**失败的退避重试上限：握手超时 / 通道关闭多为宿主卡顿或对端尚未就绪，
 * 退避重试而非当场判坏分支隔离；坏声明 / 缺 start / 协议错误等命定失败仍立即隔离（fail-closed 不变）。
 */
const START_RETRY_MAX = 5
const START_RETRY_BASE_MS = 2_000
const START_RETRY_MAX_MS = 30_000

/**
 * 临时性起服务失败码：可退避重试，其余（坏声明 / 构建失败 / 执行体入口坏）按坏分支隔离。
 * `unknown` 是未分类的原始异常（历史上一度把 secrets 整条依赖链拖下线），同样先重试兜底。
 */
const TRANSIENT_START_REASONS = new Set(['timeout', 'closed', 'unknown'])

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
  /** 本次装配解析一次的生态 profile（声明解析 / 依赖恢复 / SDK 布局同源）；只读视图。 */
  readonly ecosystem: EcosystemProfile
  /** A6 换代跟随：链头推进后交新世界，宿主自身 active 换代 / 依赖退役在此落地。 */
  applyWorld: (world: World) => Promise<void>
  stop: () => Promise<void>
  /**
   * 运行期休眠一个身份（保留索引的运行期隔离）：停服务、摘端点，世界 `active` 不变、仍入能力索引。
   * `not_found` = 身份不存在 / 无代码世代 / 已退役；已休眠再 suspend 幂等。
   */
  suspend: (id: string) => Promise<IdentitySuspendResult>
  /** 运行期恢复一个身份：按其当前代码世代重启；未休眠再 resume 幂等。 */
  resume: (id: string) => Promise<IdentitySuspendResult>
  /** 当刻运行期休眠集（只读、内存态、不持久）：入世解析与 `one` 选择按它跳过休眠提供方。 */
  suspendedIds: () => ReadonlySet<string>
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
  /** 框架安装里的 SDK 目录（`plugin-sdk/`）；缺省按宿主模块位置解析，测试可注入。 */
  sdkDir?: string
  /**
   * 生态 profile（锁文件 / 排除名 / npm-cargo env / SDK 布局 / 入口扩展名）；缺省内建默认。
   * 由组合根在启动时解析一次后注入，装配侧不再各处 `readEcosystem`。
   */
  ecosystem?: EcosystemProfile
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
    provider?: string,
  ) => Promise<CallResponse>
}

class AssemblyRuntime implements AssemblyRuntimeHandle {
  readonly endpoints = new EndpointTable()
  order: string[] = []

  private world: World
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
    provider?: string,
  ) => Promise<CallResponse>
  private readonly paths: HostPaths
  private readonly blobsDir: string
  private readonly sdkDir: string | undefined
  readonly ecosystem: EcosystemProfile
  private readonly plan: AssemblyPlan
  private readonly depsOf = new Map<string, string[]>()
  private readonly dependents = new Map<string, string[]>()
  /** 已记运维事件的拥有方冲突键（cap+owners+contracts）：同世界重复 applyWorld 不重记。 */
  private ownerConflictKeys = new Set<string>()
  /**
   * 已隔离身份 → 隔离时所处的代码世代 payload。值为该身份在新代码世代到来时复归的判据：
   * 新代码世代不同才可能复归（同代码世代 / 数据世代变化不复归），并需重新校验仍有效。
   */
  private readonly isolated = new Map<string, Hash | null>()
  private readonly loadedIds = new Set<string>()
  /**
   * 运行期休眠集（内存态、不持久）：休眠 = 保留索引的运行期隔离。
   * 仍留在 `loadedIds`（`loaded()` 报 `service:false`）、世界 `active` 不变，仅停服务、摘端点。
   */
  private readonly suspended = new Set<string>()
  private readonly services = new Map<string, ServiceRuntime>()
  private readonly pendingRestarts = new Set<Promise<void>>()
  /** 在途启动任务：`stop()` 须等它们落定，避免停机返回后仍有启动中的服务挂上端点。 */
  private readonly pendingStarts = new Set<Promise<void>>()
  /**
   * 起服务临时性失败（握手超时 / 通道关闭）的退避重试态：计数 + 在途计时器。
   * 成功装载、判永久隔离或停机时自清；避免一次卡顿把可用插件永久隔离（须等新代码世代才复归）。
   */
  private readonly startAttempts = new Map<string, number>()
  private readonly startRetryTimers = new Map<string, NodeJS.Timeout>()
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
    this.sdkDir = options.sdkDir
    this.ecosystem = options.ecosystem ?? DEFAULT_ECOSYSTEM
    const depsDir = options.depsDir ?? this.paths.depsDir
    this.restore =
      options.restore ??
      ((cwd, decl) =>
        restoreDependencies(cwd, depsDir, decl.build, undefined, this.startWrapper, this.ecosystem))
    this.sourceRoot =
      options.sourceRoot ?? ((identity) => resolvePluginSourceRoot(this.paths.root, identity))
    this.onPortCall = options.onPortCall
    this.plan = computeAssemblyPlan(options.world)
    this.swapHost = {
      isStopping: () => this.stopping,
      isIsolated: (id) => this.isolated.has(id),
      serviceOf: (id) => this.services.get(id),
      isSuspended: (id) => this.suspended.has(id),
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
      rekeyEndpoints: (service, gen, decl, endpointDecl) =>
        this.rekeyEndpoints(service, gen, decl, endpointDecl),
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
      const beforeCode = beforeIdentity === undefined ? null : this.codeGenPayloadOf(prev, id)
      const afterCode = this.codeGenPayloadOf(next, id)
      // 代码世代变化才跟随；数据世代变化（beforeCode === afterCode）不动作。
      // 纯数据身份（无代码世代）`assemblyGen` 会回落到数据世代——这里只认真正的代码世代，
      // 否则数据世代内容变化会被误判为代码换代并隔离（数据变化不动服务）。
      // 休眠身份跳过换代启动（不因换代 / 重新激活自动恢复），仅显式 `resume` 才重启。
      if (beforeCode !== afterCode && !this.suspended.has(id)) {
        changed.push(id)
      }
    }
    try {
      // `many` 成员集变更（加减提供方）虽不改消费方代码世代，却要重注入其成员表：
      // 按世界前后快照 diff 出成员集变化的消费方，强制换代重启（进程不动无法更新服务工厂 ctx）。
      const prevMany = manyNeedsMap(prev, this.blobsDir, this.ecosystem)
      const nextMany = manyNeedsMap(next, this.blobsDir, this.ecosystem)
      const manyKey = (map: Map<string, Record<string, string[]>>, id: string): string =>
        JSON.stringify(map.get(id) ?? null)
      const reinject = new Set<string>()
      for (const id of new Set([...prevMany.keys(), ...nextMany.keys()])) {
        if (this.suspended.has(id)) continue
        if (next.ids[id]?.active == null) continue
        if (manyKey(prevMany, id) === manyKey(nextMany, id)) continue
        reinject.add(id)
      }
      const follow = [...new Set([...changed, ...reinject])].sort()
      this.recordCapabilityOwnerConflicts(next)
      for (const id of follow) await this.followGeneration(prev, next, id, reinject.has(id))
      // 连带复归：被跟随且已装载 / 复归的身份，其曾被连带隔离的依赖者若依赖已齐 → 一并复归。
      for (const id of follow) {
        if (this.loadedIds.has(id) && !this.isolated.has(id)) await this.rejoinDependentsOf(id)
      }
      for (const id of retired) await this.retireBranch(id)
    } catch (err) {
      // 跟随未全部成功：世界与索引回到 prev，使「从已应用世界 diff」在下次调用时仍视这些身份为待跟随。
      // 注意：本方法**不会自动重试同一链头**，也**不回滚已完成的部分副作用**（已起 / 已停的服务）；
      // 只有当宿主再次以更高链头调用 applyWorld 时，才会从 prev 重新 diff 并重试变更身份。
      // 故失败窗口内运行态可能与世界短暂不一致，属已知残留风险，由下一次跟随收敛。
      this.world = prev
      this.buildDependencyMaps()
      throw err
    }
  }

  async start(): Promise<void> {
    for (const event of this.plan.events) {
      this.record('dep', event.kind, { impl: event.id })
    }
    this.buildDependencyMaps()
    this.recordCapabilityOwnerConflicts(this.world)
    // 启动序先落定：start 中途抛出时 `stop` 仍能按它逆序收口已 spawn 的服务，不留孤儿。
    this.order = [...this.plan.order]
    // 按依赖层起：同层无依赖边可并发（带上限），层间顺序保证被依赖者先起。
    // 某身份失败时其反向可达的依赖者（必在更晚的层）会在本层结束前被标隔离，
    // 故后续层的 dep 判定仍读到一致的装载状态，不出现半更新。
    const layers = computeStartLayers(this.plan.order, this.depsOf)
    for (const layer of layers) {
      await runWithConcurrency(layer, this.startConcurrency, (id) => this.trackStart(id))
    }
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

  suspendedIds(): ReadonlySet<string> {
    return this.suspended
  }

  /**
   * 休眠 / 恢复的公共前置：身份不存在 / 无代码世代 / 已退役 → `not_found`；
   * 坏分支隔离态 → `isolated`（不属休眠面：隔离只由新代码世代的复归判定解除，显式 resume 不得绕过）。
   */
  private suspendable(id: string): IdentitySuspendResult {
    const identity = this.world.ids[id]
    if (identity === undefined || identity.active === null) return { ok: false, code: 'not_found' }
    if (this.assemblyGenOf(id) === null) return { ok: false, code: 'not_found' }
    if (this.isolated.has(id)) return { ok: false, code: 'isolated' }
    return { ok: true }
  }

  /**
   * 运行期休眠：停目标身份服务、摘目标端点，保留 `loadedIds`（`loaded()` 报 `service:false`）与能力索引。
   * 不隔离目标、不连坐依赖者（绝不走 isolateBranch / isolateAll / retireBranch）；不换人、不碰数据目录。
   */
  async suspend(id: string): Promise<IdentitySuspendResult> {
    const allowed = this.suspendable(id)
    if (!allowed.ok) return allowed
    if (this.suspended.has(id)) return { ok: true }
    this.suspended.add(id)
    await this.detachService(id)
    this.record('dep', 'suspended', { impl: id })
    return { ok: true }
  }

  /**
   * 运行期恢复：按身份**当前代码世代**重启（与装配同路），清休眠标记并记 `dep.resumed`。
   * 起服务失败会把该身份转入隔离（坏分支），据实报 `isolated`，不与「未休眠」的幂等成功混淆。
   */
  async resume(id: string): Promise<IdentitySuspendResult> {
    const allowed = this.suspendable(id)
    if (!allowed.ok) return allowed
    if (!this.suspended.has(id)) return { ok: true }
    this.suspended.delete(id)
    this.record('dep', 'resumed', { impl: id })
    await this.trackStart(id)
    if (this.isolated.has(id)) return { ok: false, code: 'isolated' }
    this.noteRuntimeStart(id)
    return { ok: true }
  }

  /**
   * 摘除目标身份的在跑服务：停服务、清计时器、摘该身份全部端点、有界等退出。
   * 只动目标自身，不隔离、不连坐、不移出 `loadedIds`（与 `isolateAll` 的差别仅在此）。
   */
  private async detachService(id: string): Promise<void> {
    // 先摘端点：摘除立即生效，避免排空期间仍有调用落到目标服务
    this.endpoints.removeIdentity(id)
    const service = this.services.get(id)
    if (service !== undefined) {
      this.services.delete(id)
      this.clearHealth(service)
      this.clearRestart(service)
      service.draining = true
      if (!service.handledExit) {
        service.handledExit = true
        try {
          await service.link.drain(service.restart.drainMs, service.restart.drainMs + 1_000)
        } catch {
          // 排空超时按强杀处理（停机 / 换代同规）
        }
        teardownService(service)
        this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'suspended' })
        await waitForServiceExit(service, EXIT_WAIT_MS)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    // 多服务并发 teardown：各服务的 drain / 终止 / 等退出相互独立，串行等待会把停机最坏拖成 N×EXIT_WAIT_MS。
    // 状态变更（从 services 摘除、清计时器）在各 stopService 的同步段按停机序依次完成，随后才并发等待。
    const teardown = [...this.order].reverse().map((id) => this.stopService(id))
    await Promise.allSettled(teardown)
    // 等在途启动落地（其内部会看到 stopping 并停掉刚起的服务，且 entry 守卫挡住新启动），再清表：
    // 否则 stop 返回后仍可能有启动中的服务挂上端点 / 进程。
    await Promise.allSettled([...this.pendingStarts])
    // 等在途重启落地（其内部会看到 stopping 并停掉刚起的服务），再清表
    await Promise.allSettled([...this.pendingRestarts])
    for (const timer of this.startRetryTimers.values()) clearTimeout(timer)
    this.startRetryTimers.clear()
    this.startAttempts.clear()
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
      // 退出已受理：仍等它真正落定再继续，避免停机返回时残留未回收执行体
      await waitForServiceExit(service, EXIT_WAIT_MS)
      return
    }
    service.handledExit = true
    try {
      await service.link.drain(service.restart.drainMs, service.restart.drainMs + 1_000)
      teardownService(service)
    } catch {
      teardownService(service)
      this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'drain_timeout' })
    }
    await waitForServiceExit(service, EXIT_WAIT_MS)
  }

  private record(kind: LifecycleKind, event: string, fields: LifecycleFields = {}): void {
    this.log({ at: Date.now(), kind, event, ...fields })
  }

  /**
   * 记同一能力类多拥有方契约冲突：`capabilityContract` 取码元序首个拥有方，世界增删拥有方
   * 会静默改绑消费方所用的契约。这里按「cap + 拥有方 + 契约」去重记运维事件，使冲突可见；
   * 同世界重复调用不重记（applyWorld 幂等）。
   */
  private recordCapabilityOwnerConflicts(world: World): void {
    const seen = new Set<string>()
    for (const conflict of capabilityOwnerConflicts(world, this.blobsDir, this.ecosystem)) {
      const key = `${conflict.cap}\u0000${conflict.owners.join(',')}\u0000${conflict.contracts
        .map((contract) => contract.join('|'))
        .join(';')}`
      seen.add(key)
      if (this.ownerConflictKeys.has(key)) continue
      this.record('host', 'capability_owner_conflict', {
        cap: conflict.cap,
        caps: conflict.owners,
        reason: conflict.diverges ? 'contract_mismatch' : 'multiple_owners',
      })
    }
    this.ownerConflictKeys = seen
  }

  /** 装配取用世代（G7 A1）：最近代码世代；无代码世代回落 active；retired → null。 */
  private assemblyGenOf(id: string): Gen | null {
    return assemblyGen(this.world, id)
  }

  /**
   * 世界里的**代码**世代 payload：`assemblyGen` 回落到数据世代（纯数据身份 / 合成世界）时为 null。
   * `applyWorld` 用它判「代码换代」，令数据世代变化不被误判为代码换代。
   */
  private codeGenPayloadOf(world: World, id: string): Hash | null {
    const gen = assemblyGen(world, id)
    return gen !== null && isCodeGen(world, gen) ? gen.payload : null
  }

  /** 依赖图（谁 `needs.one` 谁）按当前世界重算：换代会改绑定，退役隔离靠它取反向可达。 */
  private buildDependencyMaps(): void {
    this.depsOf.clear()
    this.dependents.clear()
    for (const id of Object.keys(this.world.ids).sort()) {
      const gen = this.assemblyGenOf(id)
      const deps = new Set<string>()
      if (gen !== null) {
        for (const bound of Object.values(needsBindingsOf(this.world, gen))) {
          // 宿主依赖哨兵 `host`：不是世界身份，不构成依赖边
          if (bound === HOST_CAPABILITY) continue
          if (Object.hasOwn(this.world.ids, bound)) deps.add(bound)
        }
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

  /** 追踪一次启动任务：`stop()` 据此等在途启动落定，保证停机返回后无残留启动 / 端点。 */
  private trackStart(id: string): Promise<void> {
    const task: Promise<void> = this.startIdentity(id).finally(() => {
      this.pendingStarts.delete(task)
    })
    this.pendingStarts.add(task)
    return task
  }

  private async startIdentity(id: string): Promise<void> {
    // 停机 / 已休眠（含启动窗口内被 suspend）：不得起服务。启动成功后的后置守卫同口径。
    if (this.stopping || this.suspended.has(id)) return
    if (this.isolated.has(id)) return
    const deps = this.depsOf.get(id) ?? []
    const missing = deps.filter((dep) => !this.loadedIds.has(dep))
    if (missing.length > 0) {
      // 依赖在世界里、只是暂未装载（装配 / 换代 / 对端自身重试窗口内）→ 慢速持续重试：只要依赖
      // 存在且未判坏分支，就等它回来（不受硬上限约束，避免长一点的依赖恢复把依赖者永久拖下线）。
      // 依赖确实缺席，或依赖本身已判坏分支隔离，才连带隔离（fail-closed 不破）。
      const blocked = missing.some(
        (dep) => !Object.hasOwn(this.world.ids, dep) || this.isolated.has(dep),
      )
      if (!blocked && this.scheduleStartRetry(id, false)) return
      this.record('dep', 'stale', { impl: id })
      this.isolated.set(id, this.assemblyGenOf(id)?.payload ?? null)
      return
    }
    const read = readPluginDecl(this.world, id, this.blobsDir, this.ecosystem)
    if (read === null) {
      this.record('service', 'start_failed', { impl: id, reason: 'bad_plugin_decl' })
      this.isolated.set(id, this.assemblyGenOf(id)?.payload ?? null)
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
      // 启动窗口内该身份可能已被别的坏分支隔离 / 被运营休眠（在途 launch）：不得复活
      if (this.stopping || this.isolated.has(id) || this.suspended.has(id)) {
        if (this.isolated.has(id)) this.record('dep', 'stale', { impl: id })
        teardownService(service)
        await waitForServiceExit(service, EXIT_WAIT_MS)
        return
      }
      this.services.set(id, service)
      this.loadedIds.add(id)
      this.registerEndpoints(service)
      this.startHealth(service)
      this.clearStartRetry(id)
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
    const failure = classifyStartFailure(err)
    // 临时性失败（握手超时 / 通道关闭）先退避重试；超限或命定失败才转坏分支隔离。
    if (
      failure.event === 'service' &&
      TRANSIENT_START_REASONS.has(failure.reason) &&
      this.scheduleStartRetry(id)
    ) {
      return
    }
    this.clearStartRetry(id)
    await this.isolateStartFailure(id)
  }

  /**
   * 排一次起服务退避重试（临时性失败 / 依赖暂未装载）。有界：超过 `START_RETRY_MAX` 回 false，
   * 交调用方按坏分支隔离。计时器到点重走 `trackStart`，其内部会再判停机 / 休眠 / 隔离 / 已装载。
   * 返回是否已排程（false 表示重试已耗尽，调用方应走隔离）。
   */
  private scheduleStartRetry(id: string, bounded = true): boolean {
    if (this.stopping || this.suspended.has(id) || this.isolated.has(id)) return false
    if (this.startRetryTimers.has(id)) return true
    const attempts = (this.startAttempts.get(id) ?? 0) + 1
    if (bounded && attempts > START_RETRY_MAX) {
      this.startAttempts.delete(id)
      return false
    }
    this.startAttempts.set(id, attempts)
    const step = Math.min(attempts, START_RETRY_MAX)
    const delay = Math.min(START_RETRY_BASE_MS * 2 ** (step - 1), START_RETRY_MAX_MS)
    const timer = setTimeout(() => {
      this.startRetryTimers.delete(id)
      if (this.stopping || this.suspended.has(id) || this.isolated.has(id)) return
      if (this.loadedIds.has(id) || !Object.hasOwn(this.world.ids, id)) return
      void this.trackStart(id)
    }, delay)
    timer.unref?.()
    this.startRetryTimers.set(id, timer)
    return true
  }

  /** 清一个身份的起服务重试态（成功装载 / 判永久隔离 / 停机时）。 */
  private clearStartRetry(id: string): void {
    const timer = this.startRetryTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.startRetryTimers.delete(id)
    }
    this.startAttempts.delete(id)
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
          teardownService(service)
          this.record('service', 'exit', { impl: id, gen: service.gen, reason: 'isolated' })
          exits.push(waitForServiceExit(service, EXIT_WAIT_MS))
        }
      }
      this.endpoints.removeIdentity(id)
      this.loadedIds.delete(id)
      // 隔离态优先于休眠态：休眠标记一并清掉，避免「已隔离却仍报休眠」（会卡住复归判定）。
      this.suspended.delete(id)
      this.isolated.set(id, this.assemblyGenOf(id)?.payload ?? null)
    }
    await Promise.allSettled(exits)
  }

  /**
   * 单个身份自身**代码世代**换代后的跟随（A6 + G7 A1）：
   * 数据变化 → reload/ack（进程不动）；代码变化 → 起新服务、旧服务 drain；
   * 全新身份 → 按装配同路起（依赖未装载则隔离）；新代码世代构建 / 启动失败 → 新世代不激活，
   * 旧服务继续服务（失败只记运维日志）。数据世代只影响投影读侧，不进本路径。
   */
  private async followGeneration(
    prev: World,
    next: World,
    id: string,
    forceRestart = false,
  ): Promise<void> {
    if (this.stopping || this.suspended.has(id)) return
    // 已隔离身份：仅当新代码世代不同于隔离世代且重新校验仍有效时复归，否则保持隔离
    if (this.isolated.has(id) && !this.rejoinIsolated(next, id)) return
    const identity = next.ids[id]
    const newCodeGen = assemblyGen(next, id)
    const newDecl =
      newCodeGen === null
        ? null
        : readPluginDeclOfGen(next, newCodeGen, this.blobsDir, this.ecosystem)
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
      await this.trackStart(id)
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
      // 无服务的数据身份：确保登记为已装载（隔离复归时服务已不在，需重新入册）
      this.loadedIds.add(id)
      return
    }
    if (oldService === undefined) {
      await this.trackStart(id)
      this.noteRuntimeStart(id)
      return
    }
    // `many` 成员集变更但代码世代未变：进程不动无法更新服务工厂 ctx，按「先退旧再起新」重注入。
    // 不走 swapService：同代码世代下「先挂新端点再退旧」会按同一 gen 键误删新端点，故先摘旧再起新。
    if (forceRestart) {
      this.swapHost.removeService(id, oldService)
      await this.stopSuperseded(oldService, 'superseded')
      if (this.stopping || this.isolated.has(id) || this.suspended.has(id)) return
      await this.trackStart(id)
      this.noteRuntimeStart(id)
      return
    }
    if (
      classifyGenerationChange(
        prev,
        oldCodeGen,
        next,
        newCodeGen,
        this.blobsDir,
        this.ecosystem,
      ) === 'data'
    ) {
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

  /**
   * 隔离身份的复归判定（仅新代码世代触发）：新代码世代须不同于隔离时记录的世代，
   * 且新世代自身有效（声明可解析、def 完整、相对新世界不 stale）、依赖均已装载。
   * 数据世代变化 / 同一代码世代不复归；依赖退役、成环等失效仍成立时 fail-closed 保持隔离。
   * 复归只清隔离标记并记 `dep.rejoined`，随后由 `followGeneration` 常规路径重起（服务已缺席）。
   */
  private rejoinIsolated(next: World, id: string): boolean {
    const newCodeGen = assemblyGen(next, id)
    if (newCodeGen === null) return false
    if (this.isolated.get(id) === newCodeGen.payload) return false
    const identity = next.ids[id]
    const newDecl = readPluginDeclOfGen(next, newCodeGen, this.blobsDir, this.ecosystem)
    const payloadDef = next.defs[newCodeGen.payload]
    if (
      identity === undefined ||
      newDecl === null ||
      payloadDef === undefined ||
      stale(payloadDef, next, id)
    ) {
      return false
    }
    // 依赖仍须已装载：依赖退役 / 未恢复时本身份仍属坏分支，不得复归
    const deps = this.depsOf.get(id) ?? []
    if (deps.some((dep) => !this.loadedIds.has(dep))) return false
    this.isolated.delete(id)
    this.record('dep', 'rejoined', { impl: id, gen: newCodeGen.payload })
    return true
  }

  /**
   * 依赖恢复后的**连带复归**：某个身份成功装载 / 复归后，扫描其曾被连带隔离的反向依赖者，
   * 只要「其依赖已全部装载」就清隔离并重起。用于补上 `applyWorld` 只跟随「自身代码世代变化」的盲区：
   * 主依赖先坏（或超时被隔离）、其代码修好复归后，依赖者不会因自身世代未变而永久缺席。
   * 只复活依赖已健康的身份，非「回落」；每个候选最多尝试一次，避免失败-隔离的自旋。
   */
  private async rejoinDependentsOf(seed: string): Promise<void> {
    const tried = new Set<string>()
    for (;;) {
      if (this.stopping) return
      let progressed = false
      for (const id of this.reverseReachable([seed]).values()) {
        if (id === seed || tried.has(id)) continue
        if (!this.isolated.has(id) || this.suspended.has(id)) continue
        const deps = this.depsOf.get(id) ?? []
        if (deps.some((dep) => !this.loadedIds.has(dep))) continue
        tried.add(id)
        this.isolated.delete(id)
        this.record('dep', 'rejoined', { impl: id, gen: this.assemblyGenOf(id)?.payload })
        await this.trackStart(id)
        progressed = true
      }
      if (!progressed) return
    }
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

  /**
   * 端点重挂：进程不动，端点行从旧 gen 键换到新 gen 键（同 link / pid）。
   * `decl` 描述新世代，决定载体后续重启与 `loaded` 报告；`endpointDecl` 描述**在跑进程**的声明，
   * 决定端点方法集——换代失败降级时二者不同（跑的是旧代码、世代键却是新世代），
   * 端点须按旧声明重挂，否则会挂上旧进程并不实现的方法。
   */
  private rekeyEndpoints(
    service: ServiceRuntime,
    gen: Hash,
    decl: PluginDecl,
    endpointDecl: PluginDecl = decl,
  ): void {
    // 纵深防御：停机 / 已隔离 / 已休眠后不得重挂端点（调用方已守卫，此处再挡一层）
    if (this.stopping || this.isolated.has(service.id) || this.suspended.has(service.id)) return
    this.endpoints.removeGeneration(service.id, service.gen)
    this.clearHealth(service)
    service.gen = gen
    service.decl = decl
    service.restart = parseRestart(decl.restart)
    service.health = parseHealth(decl.health)
    this.registerEndpoints(service, endpointDecl)
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
    teardownService(service)
    await waitForServiceExit(service, EXIT_WAIT_MS)
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
      sdkDir: this.sdkDir,
      ecosystem: this.ecosystem,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      pluginStateDir: resolve(this.paths.pluginsDir, id),
      pluginDataRoot: this.paths.dataDir,
      startWrapper: this.startWrapper,
      restore: this.restore,
      onPortCall:
        this.onPortCall === undefined
          ? undefined
          : (port, method, args, env, provider) =>
              this.onPortCall!(id, port, method, args, env, provider),
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
      id,
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
      this.record('dep', 'assets_manifest_invalid', { impl: id, reason: manifest.reason })
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

  private registerEndpoints(service: ServiceRuntime, decl: PluginDecl = service.decl): void {
    for (const cap of decl.implements) {
      const methods = effectiveMethods(
        this.world,
        service.id,
        decl,
        cap,
        this.blobsDir,
        this.ecosystem,
      )
      const judgments = decl.judgments?.[cap] ?? {}
      for (const method of methods) {
        // 判定承载的方法由宿主就地求值，不登记服务端点（判定优先且不 spawn 服务）。
        if (Object.hasOwn(judgments, method)) continue
        this.endpoints.add({
          impl: service.id,
          gen: service.gen,
          cap,
          method,
          transport: service.transport,
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
    // 启动宽限期内不发探针、不记失败：启动风暴下 CPU 被构建 / 安装挤占，此时的探针超时不是服务的问题。
    // 重启实例的 `startedAt` 已刷新，宽限期同样覆盖重启后的启动窗口。
    if (Date.now() - service.startedAt < service.health.gracePeriodMs) return
    service.healthInFlight = true
    try {
      const ok = await service.link.probe(service.health.timeoutMs)
      if (ok) {
        // 探针成功即视为存活：连续失败计数与重启尝试一并归零，避免累计到永久隔离
        service.healthFailures = 0
        service.attempts = 0
      } else {
        service.healthFailures += 1
        if (service.healthFailures >= service.health.failureThreshold) {
          await this.markUnhealthy(service)
        }
      }
    } catch {
      service.healthFailures += 1
      if (service.healthFailures >= service.health.failureThreshold) {
        await this.markUnhealthy(service)
      }
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
    terminateService(service)
    await waitForServiceExit(service, EXIT_WAIT_MS)
    this.handleProcessExit(service, 'health_timeout')
  }

  private handleChannelClosed(service: ServiceRuntime, reason: string): void {
    if (service.handledExit || this.stopping || service.draining) return
    // 通道断多半是执行体已在退出：先让退出事件带真实 code 收尾；到期还没退再强杀（服务已哑但未死）
    if (service.channelCloseTimer === null) {
      service.channelCloseTimer = setTimeout(() => {
        service.channelCloseTimer = null
        if (!service.lifecycle.exited) {
          terminateService(service)
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
    // 已休眠身份的服务退出：既不重启也不隔离（休眠态优先；退避窗口内 suspend 不得被重启复活）
    if (this.suspended.has(service.id)) return
    // 进程已死：该 gen 的端点不可用，先摘除；重启成功后重挂
    this.endpoints.removeGeneration(service.id, service.gen)
    this.record('service', 'exit', {
      impl: service.id,
      gen: service.gen,
      reason: service.pendingExitReason ?? reason,
    })
    // 进程已死：从服务表摘除，令 `loaded` 在重启退避窗口内据实报 `service:false`。
    // 服务表只含在跑服务；重试成功由 `attemptRestart` 重新登记，无需在此保留死实例。
    if (this.services.get(service.id) === service) this.services.delete(service.id)
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
    // 隔离 / 休眠 / 已被换代取代后不得再排程（防御：当前调用点均已先判，且中途无 await）
    if (this.stopping || this.isolated.has(service.id) || this.suspended.has(service.id)) return
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
    // 防御：隔离时 isolateBranch 已 clearRestart 清掉未触发的 timer；换代取代同理不重启。
    // 休眠立即生效：退避窗口内 suspend 后此排程即便仍挂起也不得复活进程。
    if (this.stopping || this.isolated.has(service.id) || this.suspended.has(service.id)) return
    if (this.assemblyGenOf(service.id)?.payload !== service.gen) return
    // 该身份的活服务已被别的路径换掉（如休眠后 resume 已重起）：旧载体的排程不得再起第二个实例
    const current = this.services.get(service.id)
    if (current !== undefined && current !== service) return
    try {
      const next = await this.launch(service.id, service.gen, service.decl)
      // 重启窗口内该身份可能已被隔离 / 休眠 / 换代：不得复活
      if (this.stopping || this.isolated.has(service.id) || this.suspended.has(service.id)) {
        teardownService(next)
        await waitForServiceExit(next, EXIT_WAIT_MS)
        return
      }
      if (this.assemblyGenOf(service.id)?.payload !== service.gen) {
        teardownService(next)
        await waitForServiceExit(next, EXIT_WAIT_MS)
        return
      }
      next.attempts = service.attempts
      this.services.set(service.id, next)
      this.endpoints.removeGeneration(service.id, service.gen)
      this.registerEndpoints(next)
      this.startHealth(next)
    } catch (err) {
      // 承重守卫：等待 launch 期间该身份可能已被别的坏分支隔离 / 休眠 / 换代 → 不再记失败、不再排程
      if (this.isolated.has(service.id) || this.suspended.has(service.id)) return
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
  try {
    await runtime.start()
  } catch (err) {
    // start 中途抛出时已 spawn 的服务必须收口：runtime 尚未交调用方，stop 是唯一停它们的地方。
    try {
      await runtime.stop()
    } catch {
      // 清理尽力而为，不遮蔽原始错误
    }
    throw err
  }
  return runtime
}
