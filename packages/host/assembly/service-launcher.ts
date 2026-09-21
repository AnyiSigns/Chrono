// 起服务编排：物化 → spawn（stdio 管道）→ hello/manifest → 形态校验 → 组装 ServiceRuntime 并挂退出监听。
// 只做「起一个」，不含健康 / 重启 / 隔离（那些在 runtime.ts 的监督逻辑里）。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { materializeCommit } from './materialize.ts'
import { ServiceLink } from '../service-link.ts'
import {
  exitReason,
  HandshakeFailedError,
  manifestCovers,
  parseHealth,
  parseRestart,
  ServiceStartError,
  stopChild,
} from './supervision.ts'
import type { ServiceRuntime } from './supervision.ts'
import type { PluginDecl } from './decl.ts'
import type { CallResponse, ServiceManifest } from '../service-link.ts'
import type { CallEnv } from '../wire.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

export interface ServiceLauncherDeps {
  world: World
  materializedDir: string
  handshakeTimeoutMs: number
  /**
   * 该身份的插件 ③ 目录（`state/plugins/<id>/`）：宿主保证存在并以 `CHRONO_PLUGIN_STATE`
   * 注入 spawn env；宿主不认识目录内容，只统一 GC。
   */
  pluginStateDir?: string
  /**
   * 宿主侧服务启动包装器（最小沙箱形态）：只前置到 spawn 命令行，未配置 = 现状。
   * 宿主不认识语言，也不据此改声明 / 契约。
   */
  startWrapper?: string
  /**
   * 物化后、spawn 前的依赖恢复；缺省不恢复（由运行时按清单绑定）。
   * 抛错按启动失败传播，不启动服务。
   */
  restore?: (cwd: string) => Promise<void>
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

/** 物化并拉起一个服务实例；起不来（物化 / spawn / 先死 / 握手不过）即抛错并清理。 */
export async function launchService(
  deps: ServiceLauncherDeps,
  id: string,
  gen: Hash,
  decl: PluginDecl,
): Promise<ServiceRuntime> {
  const cwd = materializeCommit(deps.world, gen, deps.materializedDir)
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
  // 依赖恢复先于 spawn：失败时尚未起进程，按启动失败分类传播
  if (deps.restore !== undefined) {
    try {
      await deps.restore(cwd)
    } catch (err) {
      if (err instanceof ServiceStartError) throw err
      throw new ServiceStartError('deps_failed')
    }
  }
  // 插件 ③ 目录按身份创建并只注入本身份：不同身份互不可见彼此缓存目录
  const pluginStateDir = deps.pluginStateDir
  if (pluginStateDir !== undefined) mkdirSync(pluginStateDir, { recursive: true })
  const env =
    pluginStateDir === undefined
      ? process.env
      : { ...process.env, CHRONO_PLUGIN_STATE: pluginStateDir }
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
    manifest = await raceStartup(link, child, deps.handshakeTimeoutMs)
  } catch (err) {
    stopChild(child, link)
    throw err
  }
  if (!manifestCovers(decl, manifest)) {
    stopChild(child, link)
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
