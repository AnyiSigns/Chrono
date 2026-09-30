// 服务进程监督工具：重启 / 健康策略解析、退避与复位计时、进程树终止、起服务错误分类。
// 装配运行时的编排（计划、启动、握手、隔离、停机）在 runtime.ts。

import type { ChildProcess } from 'node:child_process'
import { killProcessTree } from '../common/platform/index.ts'
import {
  DEFAULT_HEALTH_FAILURE_THRESHOLD,
  DEFAULT_HEALTH_GRACE_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_RESTART_BACKOFF_MAX_MS,
  DEFAULT_RESTART_BACKOFF_MS,
  DEFAULT_RESTART_DRAIN_MS,
  DEFAULT_RESTART_MAX,
  DEFAULT_RESTART_WINDOW_MS,
} from '../options.ts'
import { ServiceChannelError, SERVICE_PROTOCOL_VERSION } from '../service-link.ts'
import type {
  ServiceChannel,
  ServiceLink,
  ServiceManifest,
  ServiceTransport,
} from '../service-link.ts'
import { asRecord } from '../common/json.ts'
import type { PluginDecl } from './decl.ts'
import type { ServiceLifecycle } from './service-host.ts'
import type { Hash, Json } from '../../kernel/index.ts'

/** terminate 后等待进程真正退出的有界窗口：结算 / 继续前先等它落定，避免遗留孤儿进程。 */
export const EXIT_WAIT_MS = 2_000

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
  /** 连续失败阈值：连续失败达到该次数才判不健康（缺省 3，最小 1）。 */
  failureThreshold: number
  /** 启动宽限期：服务启动后该窗口内不发探针、不记失败（缺省 max(intervalMs, 30s)）。 */
  gracePeriodMs: number
}

/** 一个在跑的服务实例（含监督计时与退出标记）。 */
export interface ServiceRuntime {
  id: string
  gen: Hash
  decl: PluginDecl
  transport: ServiceTransport
  /** 仅 stdio 有：被 spawn 的子进程；inproc / worker 无独立进程。 */
  proc?: ChildProcess
  channel: ServiceChannel
  lifecycle: ServiceLifecycle
  link: ServiceLink
  /** 物理进程 pid；inproc / worker 为 `undefined`。 */
  pid?: number
  startedAt: number
  attempts: number
  /** 连续探针失败计数：成功即清零；达到 `health.failureThreshold` 才走退出重启。 */
  healthFailures: number
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
    const judgments = decl.judgments?.[cap] ?? {}
    // 判定承载的方法由宿主就地求值，不要求服务实现；其余方法须服务覆盖。
    if (!methods.every((method) => Object.hasOwn(judgments, method) || provided.includes(method))) {
      return false
    }
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
    baseMs: numberField(record, 'backoff_ms', DEFAULT_RESTART_BACKOFF_MS),
    maxMs: numberField(record, 'backoff_max_ms', DEFAULT_RESTART_BACKOFF_MAX_MS),
    max: Math.floor(numberField(record, 'max', DEFAULT_RESTART_MAX)),
    windowMs: numberField(record, 'window_ms', DEFAULT_RESTART_WINDOW_MS),
    drainMs: numberField(record, 'drain_ms', DEFAULT_RESTART_DRAIN_MS),
  }
}

export function parseHealth(value: Json): HealthPolicy {
  const record = asRecord(value)
  const intervalMs = numberField(record, 'interval_ms', DEFAULT_HEALTH_INTERVAL_MS)
  const timeoutMs = numberField(record, 'timeout_ms', DEFAULT_HEALTH_TIMEOUT_MS)
  // 连续失败阈值：缺失回落默认阈值，下限 1（旧声明只给 interval_ms / timeout_ms，自动得默认阈值）
  const failureThreshold = Math.max(
    1,
    Math.floor(numberField(record, 'failure_threshold', DEFAULT_HEALTH_FAILURE_THRESHOLD)),
  )
  // 启动宽限期：缺失回落 max(intervalMs, 默认宽限)，覆盖启动风暴；显式给 0 则关闭宽限
  const gracePeriodMs = numberField(
    record,
    'grace_period_ms',
    Math.max(intervalMs, DEFAULT_HEALTH_GRACE_MS),
  )
  return { intervalMs, timeoutMs, failureThreshold, gracePeriodMs }
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

/** 杀服务进程树：形态分支在平台适配层（Windows taskkill / POSIX 进程组）。 */
export { killProcessTree as terminateChild }

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

/** 关通道并终止执行体（stdio 杀进程树；inproc / worker 关模型自身执行体）。 */
export function teardownService(service: ServiceRuntime): void {
  service.link.close()
  service.lifecycle.terminate()
}

/** 只终止执行体、不关通道（健康超时等路径用）。 */
export function terminateService(service: ServiceRuntime): void {
  service.lifecycle.terminate()
}

/** 等执行体真正退出（有界）；已退出立即返回。 */
export function waitForServiceExit(service: ServiceRuntime, timeoutMs: number): Promise<void> {
  return service.lifecycle.waitForExit(timeoutMs)
}
