// 起服务编排：物化 → 准备（资产直拷 + 依赖恢复 / 构建）→ 按 transport 起服务并握手 → 组装 ServiceRuntime。
// 拆成准备（物化 + 资产直拷 + 依赖恢复 / 构建）与 spawn（起服务 + 握手）两个阶段：
// 准备阶段不占端口等独占资源，独占序可在 drain 旧实例之前先做完，把换代空窗压到「起服务 + 握手」。
// 形态（stdio / inproc / worker）由 plugin.json.transport 声明，本文件只按声明选择模型。
// 只做「起一个」，不含健康 / 重启 / 隔离（那些在 runtime.ts 的监督逻辑里）。

import { mkdirSync } from 'node:fs'
import { materializeCommit } from './materialize.ts'
import { ServiceLink } from '../service-link.ts'
import { selectServiceHost } from './service-host.ts'
import { ensurePluginDataDir } from '../plugin-data.ts'
import {
  EXIT_WAIT_MS,
  HandshakeFailedError,
  manifestCovers,
  parseHealth,
  parseRestart,
  ServiceStartError,
} from './supervision.ts'
import type { ServiceRuntime } from './supervision.ts'
import type { ServiceLifecycle } from './service-host.ts'
import type { PluginDecl } from './decl.ts'
import type { CallResponse, ServiceManifest } from '../service-link.ts'
import type { CallEnv } from '../wire.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

export interface ServiceLauncherDeps {
  world: World
  materializedDir: string
  /** 源码 CAS 目录：物化 pointer blob 时经它共享字节；inline 旧世界可省。 */
  blobsDir?: string
  handshakeTimeoutMs: number
  /**
   * 该身份的插件 ③ 目录（`state/plugins/<id>/`）：宿主保证存在；stdio 注入 spawn env，
   * inproc / worker 作 loader 参数。宿主不认识目录内容，只统一 GC。
   */
  pluginStateDir?: string
  /**
   * 插件 ④ 目录根（`state/data/`）：声明 `durable` 的身份在准备阶段建本身份目录
   * （`state/data/<id>/`）；stdio 注入 spawn env，inproc / worker 作 loader 参数；未声明者不建目录、不注入。
   */
  pluginDataRoot?: string
  /**
   * 宿主侧服务启动包装器（最小沙箱形态）：只前置到 stdio spawn 命令行，未配置 = 现状。
   * 宿主不认识语言，也不据此改声明 / 契约。
   */
  startWrapper?: string
  /**
   * 物化后、起服务前的依赖恢复 / 构建；缺省不恢复（由运行时按声明绑定）。
   * 传声明进去：`plugin.json.build` 决定跑什么，宿主不解释语言。
   * 抛错按启动失败传播，不启动服务。
   */
  restore?: (cwd: string, decl: PluginDecl) => Promise<void>
  /**
   * 物化后、依赖恢复前的投递目录大资产直拷（`assets_manifest`）；缺省不拷。
   * 必须在依赖恢复前：Rust 构建期输入（`include_bytes!`）依赖它已就位；抛错按启动失败传播。
   */
  copyAssets?: (cwd: string) => void
  /** 反向调用（服务 → 宿主）转发；缺省不接线，服务发 `port.call` 得 `not_loaded`。 */
  onPortCall?: (
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
  onServiceEvent?: (impl: string, topic: string, payload: Json) => void
  onExtraDropped: (impl: string, gen: Hash, caps: string[]) => void
  onChannelClosed: (service: ServiceRuntime, reason: string) => void
  onExit: (service: ServiceRuntime, reason: string) => void
}

/**
 * 准备阶段产物：物化目录 + 声明 `durable` 时的本身份持久目录。
 * 准备阶段只读写物化目录与宿主侧依赖缓存，不起服务、不占独占资源，
 * 故独占序可在旧实例仍在服务时先做完；起服务阶段直接拿它作 cwd，避免重复物化。
 */
export interface PreparedService {
  cwd: string
  /** 声明 `durable` 时已建好的本身份持久目录；否则 `undefined`（未声明不建目录）。 */
  dataDir?: string
}

/**
 * 准备阶段：物化 + 大资产直拷 + 依赖恢复 / 构建 + ④ 目录建目录，返回准备产物。
 * 不起服务、不占端口；失败时尚未起服务，按启动失败分类传播（`materialize_failed` / `deps_failed`）。
 * ④ 目录在此阶段建（不占独占资源），独占序可在 drain 旧实例前先完成。
 */
export async function prepareService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
): Promise<PreparedService> {
  const cwd = materializeCommit(deps.world, gen, deps.materializedDir, {
    blobsDir: deps.blobsDir,
  })
  if (cwd === null) throw new ServiceStartError('materialize_failed')
  // 大资产直拷先于依赖恢复：构建期输入（如 Rust include_bytes!）须在构建前就位
  if (deps.copyAssets !== undefined) {
    try {
      deps.copyAssets(cwd)
    } catch (err) {
      if (err instanceof ServiceStartError) throw err
      throw new ServiceStartError('deps_failed')
    }
  }
  // 依赖恢复 / 构建先于起服务：失败时尚未起服务，按启动失败分类传播。
  if (deps.restore !== undefined) {
    try {
      await deps.restore(cwd, decl)
    } catch (err) {
      if (err instanceof ServiceStartError) throw err
      throw new ServiceStartError('deps_failed')
    }
  }
  // ④ 目录：声明 `durable` 才建；未声明者不建目录（不给隐式持久层）。
  if (decl.state === 'durable' && deps.pluginDataRoot !== undefined) {
    return { cwd, dataDir: ensurePluginDataDir(deps.pluginDataRoot, id) }
  }
  return { cwd }
}

/**
 * 起服务阶段：按 `decl.transport` 选择形态，起通道并握手；起不来（导入 / spawn / 先死 / 握手不过）即抛错并清理。
 * 握手超时窗口从此刻开始：只覆盖起服务之后的协议往返，不含准备阶段的物化 / 构建（见下方 raceStartup）。
 */
export async function spawnService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
  prepared: PreparedService,
): Promise<ServiceRuntime> {
  // 插件 ③ 目录按身份创建并只注入本身份：不同身份互不可见彼此缓存目录
  const pluginStateDir = deps.pluginStateDir
  if (pluginStateDir !== undefined) mkdirSync(pluginStateDir, { recursive: true })
  const host = selectServiceHost(decl.transport)
  const { channel, lifecycle } = await host.start(decl, {
    ...prepared,
    pluginStateDir,
    startWrapper: deps.startWrapper,
  })
  let service: ServiceRuntime | null = null
  const link = new ServiceLink(channel, {
    impl: id,
    gen,
    onEvent: (topic, payload) => deps.onServiceEvent?.(id, topic, payload),
    onPortCall: deps.onPortCall,
    onClosed: (reason) => {
      if (service !== null) deps.onChannelClosed(service, reason)
    },
  })
  let manifest: ServiceManifest
  try {
    // 握手超时窗口从此刻开始：只覆盖起服务之后的协议往返，不含准备阶段的物化 / 构建。
    manifest = await raceStartup(link, lifecycle, deps.handshakeTimeoutMs)
  } catch (err) {
    link.close()
    lifecycle.terminate()
    // 终止后有界等执行体退出再抛出，避免握手失败留下未回收的服务执行体
    await lifecycle.waitForExit(EXIT_WAIT_MS)
    throw err
  }
  if (!manifestCovers(decl, manifest)) {
    link.close()
    lifecycle.terminate()
    await lifecycle.waitForExit(EXIT_WAIT_MS)
    throw new HandshakeFailedError()
  }
  const extras = manifest.implements.filter((cap) => !decl.implements.includes(cap))
  if (extras.length > 0) deps.onExtraDropped(id, gen, extras)

  service = {
    id,
    gen,
    decl,
    transport: decl.transport,
    proc: lifecycle.proc,
    channel,
    lifecycle,
    link,
    pid: channel.pid,
    startedAt: Date.now(),
    attempts: 0,
    healthFailures: 0,
    restart: parseRestart(decl.restart),
    health: parseHealth(decl.health),
    healthTimer: null,
    restartTimer: null,
    channelCloseTimer: null,
    healthInFlight: false,
    draining: false,
    handledExit: false,
    pendingExitReason: null,
  }
  const runtime = service
  lifecycle.onExit((reason) => deps.onExit(runtime, reason))
  return runtime
}

/** 一次性起服务：准备 + 起服务。缺省（重叠）序与装配期等不拆分阶段调用方沿用此入口。 */
export async function launchService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
): Promise<ServiceRuntime> {
  const prepared = await prepareService(deps, id, gen, decl)
  return spawnService(deps, id, gen, decl, prepared)
}

/** 握手与「执行体先退出」竞速：谁先发生谁定结果。 */
function raceStartup(
  link: ServiceLink,
  lifecycle: ServiceLifecycle,
  timeoutMs: number,
): Promise<ServiceManifest> {
  return new Promise<ServiceManifest>((resolve, reject) => {
    let settled = false
    lifecycle.onExit((reason) => {
      if (settled) return
      settled = true
      reject(new ServiceStartError(`exited:${reason}`))
    })
    link.handshake(timeoutMs).then(
      (manifest) => {
        if (settled) return
        settled = true
        resolve(manifest)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        reject(err as Error)
      },
    )
  })
}
