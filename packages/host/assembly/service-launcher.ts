// 起服务编排：物化 → spawn（stdio 管道）→ hello/manifest → 形态校验 → 组装 ServiceRuntime 并挂退出监听。
// 拆成准备（物化 + 资产直拷 + 依赖恢复 / 构建）与 spawn（起进程 + 握手）两个阶段：
// 准备阶段不占端口等独占资源，独占序可在 drain 旧实例之前先做完，把换代空窗压到「spawn + 握手」。
// 只做「起一个」，不含健康 / 重启 / 隔离（那些在 runtime.ts 的监督逻辑里）。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { materializeCommit } from './materialize.ts'
import { ServiceLink } from '../service-link.ts'
import { ensurePluginDataDir } from '../plugin-data.ts'
import {
  EXIT_WAIT_MS,
  exitReason,
  HandshakeFailedError,
  manifestCovers,
  parseHealth,
  parseRestart,
  ServiceStartError,
  stopChild,
  waitForExit,
} from './supervision.ts'
import type { ServiceRuntime } from './supervision.ts'
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
   * 该身份的插件 ③ 目录（`state/plugins/<id>/`）：宿主保证存在并以 `CHRONO_PLUGIN_STATE`
   * 注入 spawn env；宿主不认识目录内容，只统一 GC。
   */
  pluginStateDir?: string
  /**
   * 插件 ④ 目录根（`state/data/`）：声明 `durable` 的身份在准备阶段建本身份目录
   * （`state/data/<id>/`）并以 `CHRONO_PLUGIN_DATA` 注入 spawn env；未声明者不建目录、不注入。
   */
  pluginDataRoot?: string
  /**
   * 宿主侧服务启动包装器（最小沙箱形态）：只前置到 spawn 命令行，未配置 = 现状。
   * 宿主不认识语言，也不据此改声明 / 契约。
   */
  startWrapper?: string
  /**
   * 物化后、spawn 前的依赖恢复 / 构建；缺省不恢复（由运行时按声明绑定）。
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
 * 拼接实际 spawn 命令：包装器命令片段前置到原 `start`，交给 shell 重新解析（跨平台同口径）。
 * 未配置包装器 → 原样返回 `start`（零行为变化）。
 */
export function composeStartCommand(start: string, wrapper?: string): string {
  return wrapper === undefined ? start : `${wrapper} ${start}`
}

/**
 * 准备阶段产物：物化目录 + 声明 `durable` 时的本身份持久目录。
 * 准备阶段只读写物化目录与宿主侧依赖缓存，不 spawn 进程、不占独占资源，
 * 故独占序可在旧实例仍在服务时先做完；spawn 阶段直接拿它作 cwd，避免重复物化。
 */
export interface PreparedService {
  cwd: string
  /** 声明 `durable` 时已建好的本身份持久目录；否则 `undefined`（未声明不建目录）。 */
  dataDir?: string
}

/**
 * 准备阶段：物化 + 大资产直拷 + 依赖恢复 / 构建 + ④ 目录建目录，返回准备产物。
 * 不 spawn 进程、不占端口；失败时尚未起进程，按启动失败分类传播（`materialize_failed` / `deps_failed`）。
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
  // 依赖恢复 / 构建先于 spawn：失败时尚未起进程，按启动失败分类传播。
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
 * spawn 阶段：在准备好的物化目录里起进程并握手；起不来（spawn / 先死 / 握手不过）即抛错并清理。
 * 握手超时窗口从此刻开始：只覆盖 spawn 之后的协议往返，不含准备阶段的物化 / 构建（见下方 raceStartup）。
 */
export async function spawnService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
  prepared: PreparedService,
): Promise<ServiceRuntime> {
  const cwd = prepared.cwd
  // 插件 ③ 目录按身份创建并只注入本身份：不同身份互不可见彼此缓存目录
  const pluginStateDir = deps.pluginStateDir
  if (pluginStateDir !== undefined) mkdirSync(pluginStateDir, { recursive: true })
  // ③ 与 ④ 两个变量都注入、互不替代：③ 可重算（可随时删），④ 不可重算（跨代存活、进备份）。
  // ④ 目录已在准备阶段建好（`prepared.dataDir`）；未声明 `durable` 时两者皆不注入。
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (pluginStateDir !== undefined) env['CHRONO_PLUGIN_STATE'] = pluginStateDir
  if (prepared.dataDir !== undefined) env['CHRONO_PLUGIN_DATA'] = prepared.dataDir
  const child = spawn(composeStartCommand(decl.start, deps.startWrapper), {
    cwd,
    shell: true,
    windowsHide: true,
    // POSIX 下建独立进程组，便于连同 shell 包装一起杀整树
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  // 服务日志走 stderr；宿主持有读端防写满阻塞，stdout 只许协议帧
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  child.stderr?.on('error', () => {})
  child.stdout?.on('error', () => {})
  child.stdin?.on('error', () => {})

  let service: ServiceRuntime | null = null
  const link = new ServiceLink(child, {
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
    // 握手超时窗口从此刻开始：只覆盖 spawn 之后的协议往返，不含准备阶段的物化 / 构建。
    manifest = await raceStartup(link, child, deps.handshakeTimeoutMs)
  } catch (err) {
    stopChild(child, link)
    // terminate 后有界等进程退出再抛出，避免握手失败留下未回收的服务进程
    await waitForExit(child, EXIT_WAIT_MS)
    throw err
  }
  if (!manifestCovers(decl, manifest)) {
    stopChild(child, link)
    await waitForExit(child, EXIT_WAIT_MS)
    throw new HandshakeFailedError()
  }
  const extras = manifest.implements.filter((cap) => !decl.implements.includes(cap))
  if (extras.length > 0) deps.onExtraDropped(id, gen, extras)

  service = {
    id,
    gen,
    decl,
    proc: child,
    link,
    pid: child.pid ?? -1,
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
  child.once('exit', (code, signal) => deps.onExit(runtime, exitReason(code, signal)))
  child.once('error', () => deps.onExit(runtime, 'spawn_error'))
  if (child.exitCode !== null || child.signalCode !== null) {
    deps.onExit(runtime, exitReason(child.exitCode, child.signalCode))
  }
  return runtime
}

/** 一次性起服务：准备 + spawn。缺省（重叠）序与装配期等不拆分阶段调用方沿用此入口。 */
export async function launchService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
): Promise<ServiceRuntime> {
  const prepared = await prepareService(deps, id, gen, decl)
  return spawnService(deps, id, gen, decl, prepared)
}

/** 握手与「进程先死」竞速：谁先发生谁定结果。 */
function raceStartup(
  link: ServiceLink,
  child: ChildProcess,
  timeoutMs: number,
): Promise<ServiceManifest> {
  return new Promise<ServiceManifest>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      reject(new ServiceStartError(`exited:${code ?? signal ?? 'unknown'}`))
    }
    const onError = (): void => reject(new ServiceStartError('spawn_error'))
    child.once('exit', onExit)
    child.once('error', onError)
    link.handshake(timeoutMs).then(
      (manifest) => {
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        resolve(manifest)
      },
      (err: unknown) => {
        child.removeListener('exit', onExit)
        child.removeListener('error', onError)
        reject(err as Error)
      },
    )
  })
}
