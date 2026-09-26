// 宿主保留能力类的接线：组装 `createHostCapability` 的依赖，并实现反向调用 `port.call` 的转发。
// 反向调用按**发出者身份** `pins` 路由后转发给目标服务，帧填 `env`（同一 run / thread）。

import { createHostCapability } from './host-capability.ts'
import { HOST_CAPABILITY } from './host-methods.ts'
import { redactPortArgs } from './port-audit.ts'
import type { PortAuditSink } from './port-audit.ts'
import { resolveMethodTimeoutMs } from './method-timeouts.ts'
import { DEFAULT_CALL_TIMEOUT_MS } from './effect/index.ts'
import type { HostCapabilityCall, RoundRouter } from './effect/index.ts'
import type { InboundHandlers } from './inbound/handlers.ts'
import type { RunRegistry } from './run-registry.ts'
import type { AuditQuery } from './audit.ts'
import type { CallResponse } from './service-link.ts'
import type { CallEnv } from './wire.ts'
import type { HostPaths } from './paths.ts'
import type { WorldWriter } from './writer.ts'
import type { Json, World } from '../kernel/index.ts'

export interface CapabilityWiringDeps {
  root: string
  paths: HostPaths
  writer: WorldWriter
  audits: AuditQuery
  registry: RunRegistry
  /** 活路由器 getter：装配完成前为 undefined。 */
  getRouter: () => RoundRouter | undefined
  /** 路由就绪信号：监听先于装配，服务可能在装配完成前发起反向调用。 */
  routerReady: Promise<void>
  /** 已应用世界 getter（与端点表同代）：超时解析与路由同世界。 */
  liveWorld: () => World
  isStopping: () => boolean
  startDetachedRun: InboundHandlers['startDetachedRun']
  callTimeoutMs?: number
  portAudit: PortAuditSink
  nextNow: () => number
}

export interface CapabilityWiring {
  capability: HostCapabilityCall
  handlePortCall: (
    impl: string,
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ) => Promise<CallResponse>
}

export function createCapabilityWiring(deps: CapabilityWiringDeps): CapabilityWiring {
  const capability = createHostCapability({
    root: deps.root,
    assetsDir: deps.paths.assetsDir,
    blobsDir: deps.paths.blobsDir,
    runtimeDir: deps.paths.runtimeDir,
    audits: deps.audits,
    world: () => deps.writer.snapshot().world,
    abortRun: (run) => deps.registry.abort(run),
    startDetachedRun: deps.startDetachedRun,
    isStopping: deps.isStopping,
  })

  /**
   * 反向调用：服务发 `port.call` 时按发出者身份 `pins` 路由后转发给目标服务。
   * 目标调用帧同样填 `env`：取发起服务在途正向调用的回合信息（同一 run / thread）；无在途调用时
   * 补宿主固定时钟、run / thread 记 null。返回值一律是数据，不抛错（失败作数据回 `port.error`）。
   */
  const handlePortCall = async (
    impl: string,
    port: string,
    method: string,
    args: Json,
    env: CallEnv | undefined,
  ): Promise<CallResponse> => {
    if (deps.getRouter() === undefined) {
      // 装配尚未完成：监听先于装配，服务可能已连上并发起反向调用，等路由就绪再转发。
      await deps.routerReady
    }
    const router = deps.getRouter()
    if (router === undefined) return { ok: false, code: 'not_loaded', message: 'router not ready' }
    const world = deps.liveWorld()
    const routed = router.resolve(world, impl, port, method)
    if (!routed.ok) return { ok: false, code: routed.error, message: routed.error }
    // 反向调用帧的 env：run / thread 取发起服务在途正向调用的回合信息（无在途补宿主时钟），
    // emitter = 发起该反向调用的服务身份（与正向调用帧的「发出者身份」口径一致）。
    const callEnv: CallEnv = {
      run: env?.run ?? null,
      thread: env?.thread ?? null,
      now: env?.now ?? deps.nextNow(),
      emitter: impl,
    }
    // 端口审计：env 值脱敏后只落宿主侧内存面（不进世界、不写链）；旁路失败不影响转发
    try {
      deps.portAudit.record({
        at: Date.now(),
        from: impl,
        target: routed.row.impl,
        port,
        method,
        args: redactPortArgs(args),
        run: callEnv.run,
        thread: callEnv.thread,
      })
    } catch {
      // 审计落点异常不阻断反向调用（旁路取证，非业务通道）
    }
    // 超时按活世界解析（与路由同代），避免锚定旧世代取到已摘除世代的方法级声明。
    const timeoutMs =
      resolveMethodTimeoutMs(world, routed.row.impl, port, method) ??
      deps.callTimeoutMs ??
      DEFAULT_CALL_TIMEOUT_MS
    try {
      return await routed.row.link.call(port, method, args, timeoutMs, undefined, callEnv)
    } catch {
      return { ok: false, code: 'transport_failed', message: 'port.call transport failed' }
    }
  }

  return { capability, handlePortCall }
}
