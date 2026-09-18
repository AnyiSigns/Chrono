// 服务进程监督工具：重启 / 健康策略解析、退避与复位计时、进程树终止、起服务错误分类。
// 装配运行时的编排（计划、启动、握手、隔离、停机）在 runtime.ts。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ServiceChannelError, SERVICE_PROTOCOL_VERSION } from '../service-link.ts'
import type { ServiceLink, ServiceManifest } from '../service-link.ts'
import type { PluginDecl } from './decl.ts'
import type { Hash, Json } from '../../kernel/index.ts'

export interface RestartPolicy {
  policy: 'on-exit' | 'never'
  backoff: 'none' | 'fixed' | 'exponential'
  baseMs: number
  maxMs: number
  max: number
  windowMs: number
  drainMs: number
}

export interface HealthPolicy {
  intervalMs: number
  timeoutMs: number
}

/** 一个在跑的服务实例（含监督计时与退出标记）。 */
export interface ServiceRuntime {
  id: string
  gen: Hash
  decl: PluginDecl
  proc: ChildProcess
  link: ServiceLink
  pid: number
  startedAt: number
  attempts: number
  restart: RestartPolicy
  health: HealthPolicy
  healthTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  channelCloseTimer: NodeJS.Timeout | null
  healthInFlight: boolean
  draining: boolean
  handledExit: boolean
  pendingExitReason: string | null
}

/** 握手形态校验：协议版本 / 声明协议 / 身份 / 能力覆盖 / 状态档——只查形态，不查语义。 */
export function manifestCovers(decl: PluginDecl, manifest: ServiceManifest): boolean {
  if (manifest.v !== SERVICE_PROTOCOL_VERSION) return false
  if (manifest.protocol !== decl.protocol) return false
  if (manifest.identity !== decl.identity) return false
  if (manifest.state !== decl.state) return false
  if (!decl.implements.every((cap) => manifest.implements.includes(cap))) return false
  for (const [cap, methods] of Object.entries(decl.methods)) {
    const provided = manifest.methods[cap] ?? []
    if (!methods.every((method) => provided.includes(method))) return false
  }
  return true
}

/** 起服务失败（物化 / spawn / 进程先死 / 握手超时）：记 `service.start_failed`。 */
export class ServiceStartError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'ServiceStartError'
    this.reason = reason
  }
}

/** manifest 形态 / 覆盖校验不过：记 `handshake.failed`。 */
export class HandshakeFailedError extends Error {
  constructor() {
    super('handshake_failed')
    this.name = 'HandshakeFailedError'
  }
}

/** 起服务失败的机械分类：握手形态问题 vs 起服务 / 通道问题。 */
export type StartFailure = { event: 'handshake' } | { event: 'service'; reason: string }

export function classifyStartFailure(err: unknown): StartFailure {
  if (err instanceof HandshakeFailedError) return { event: 'handshake' }
  if (
    err instanceof ServiceChannelError &&
    (err.code === 'bad_manifest' || err.code === 'protocol_error')
  ) {
    return { event: 'handshake' }
  }
  if (err instanceof ServiceStartError) return { event: 'service', reason: err.reason }
  if (err instanceof ServiceChannelError) return { event: 'service', reason: err.code }
  return { event: 'service', reason: 'unknown' }
}

function asRecord(value: Json | undefined): { [k: string]: Json } | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
}

function numberField(record: { [k: string]: Json } | null, key: string, fallback: number): number {
  const value = record?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

export function parseRestart(value: Json): RestartPolicy {
  const record = asRecord(value)
  const backoff = record?.['backoff']
  return {
    // v1 只认 on-exit / never；缺失或未知按 on-exit（宽容，不新增入世门禁）
    policy: record?.['policy'] === 'never' ? 'never' : 'on-exit',
    backoff:
      backoff === 'none' || backoff === 'fixed' || backoff === 'exponential'
        ? backoff
        : 'exponential',
    baseMs: numberField(record, 'backoff_ms', 500),
    maxMs: numberField(record, 'backoff_max_ms', 30_000),
    max: Math.floor(numberField(record, 'max', 5)),
    windowMs: numberField(record, 'window_ms', 60_000),
    drainMs: numberField(record, 'drain_ms', 5_000),
  }
}

export function parseHealth(value: Json): HealthPolicy {
  const record = asRecord(value)
  return {
    intervalMs: numberField(record, 'interval_ms', 10_000),
    timeoutMs: numberField(record, 'timeout_ms', 2_000),
  }
}

export function backoffDelay(policy: RestartPolicy, attempt: number): number {
  if (policy.backoff === 'none') return 0
  if (policy.backoff === 'fixed') return policy.baseMs
  return Math.min(policy.baseMs * 2 ** Math.max(0, attempt - 1), policy.maxMs)
}

export function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit:${code}`
  if (signal !== null) return `signal:${signal}`
  return 'exit:unknown'
}

/**
 * 杀服务进程树：宿主以 shell 起服务，`child.kill()` 只杀 shell 包装进程，
 * 会遗留真正的服务进程。Windows 用 `taskkill /T /F`，POSIX 用进程组（spawn 时 detached）。
 * 不让 `child.kill()` 与 `taskkill` 抢跑——抢跑会缩短 taskkill 枚举子树的窗口。
 *
 * 已知限制（Windows）：`taskkill` 是异步的，极窄窗口内 shell 已 fork 但尚未被枚举到的
 * 孙进程可能漏网；漏网进程由「stdin EOF 自退出」义务兜底（宿主关闭通道即 EOF）。
 */
export function terminateChild(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
      return
    } catch {
      // taskkill 不可用时退回直接 kill
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // 进程组不可用时退回直接 kill
    }
  }
  try {
    child.kill()
  } catch {
    // 进程可能已退出
  }
}

/** 等子进程真正退出（有界）；已退出立即返回。 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve()
    }, timeoutMs)
    timer.unref?.()
    child.once('exit', onExit)
  })
}

export function stopChild(child: ChildProcess, link: ServiceLink): void {
  link.close()
  terminateChild(child)
}
