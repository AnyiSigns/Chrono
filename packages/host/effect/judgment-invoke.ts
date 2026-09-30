// 判定内效果的解析与执行（宿主接线）：与 run-loop 的单值 `call` 同形——路由 → 端点行（服务 / 判定）→
// 调用 → 回灌；每次嵌套调用留一条审计草稿。判定自身不带 `ctx` / 不扩权，效果身份是判定属主身份。
//
// 递归界：判定 A 可 `eff` 到判定 B（经路由命中 B 的 `judgments`），B 的求值又经本函数——故用
// `AsyncLocalStorage` 按调用链记嵌套深度，超界 fail-closed（防跨身份判定互调成环时无限递归）。

import { AsyncLocalStorage } from 'node:async_hooks'
import { ServiceChannelError } from '../service-link.ts'
import { resolveAuditRedact } from '../audit-redact.ts'
import { resolveMethodTimeoutMs } from '../method-timeouts.ts'
import { DEFAULT_CALL_TIMEOUT_MS } from '../common/call-timeout.ts'
import { buildAudit } from './execute.ts'
import type { AuditDraft } from '../audit.ts'
import type { CallEnv } from '../wire.ts'
import type { RoundRouter } from './route.ts'
import type { EffRequest, EffResult, World } from '../../kernel/index.ts'

/** 判定互调的嵌套深度上限：超界作数据错误（内核归 `eff_error`），不无限递归。 */
export const MAX_JUDGMENT_DEPTH = 16

export interface JudgmentInvokeOptions {
  /** 路由 getter：与判定的解析世界同代（缺省 / 未就绪 → `not_loaded`）。 */
  getRouter: () => RoundRouter | undefined
  blobsDir?: string
  /** 审计时间戳来源（宿主固定时钟）。 */
  now: () => number
  /** 审计草稿落点（旁路侧存）；缺省不落审计。 */
  onAudit?: (draft: AuditDraft) => void
  /** 进程级调用超时缺省；方法级声明优先。 */
  callTimeoutMs?: number
}

/**
 * 构造判定内效果执行器：解析世界与路由同代，按目标身份取方法级超时与脱敏白名单，
 * 返回值恒是数据（成功值 / 错误值 / 通道错误码），与 `run-loop` 的 `call` 同形。
 */
export function createJudgmentInvoke(
  options: JudgmentInvokeOptions,
): (
  world: World,
  emitter: string,
  eff: EffRequest,
  signal?: AbortSignal,
  env?: CallEnv,
) => Promise<EffResult> {
  const depth = new AsyncLocalStorage<number>()
  return (world, emitter, eff, signal, env) => {
    const current = depth.getStore() ?? 0
    if (current >= MAX_JUDGMENT_DEPTH) {
      return Promise.resolve({ ok: false, error: 'recursion_limited' })
    }
    return depth.run(current + 1, () => invokeOnce(options, world, emitter, eff, signal, env))
  }
}

async function invokeOnce(
  options: JudgmentInvokeOptions,
  world: World,
  emitter: string,
  eff: EffRequest,
  signal: AbortSignal | undefined,
  env: CallEnv | undefined,
): Promise<EffResult> {
  const router = options.getRouter()
  if (router === undefined) return { ok: false, error: 'not_loaded' }
  const resolutionWorld = router.resolutionWorld?.(world) ?? world
  const routed = router.resolve(resolutionWorld, emitter, eff.port, eff.method)
  if (!routed.ok) return { ok: false, error: routed.error }
  const row = routed.row
  const timeoutMs =
    resolveMethodTimeoutMs(resolutionWorld, row.impl, eff.port, eff.method) ??
    options.callTimeoutMs ??
    DEFAULT_CALL_TIMEOUT_MS
  // 落帧 `env`：外层调用帧的 `run`/`thread`/`now` 原样回带，`emitter` 覆写为判定属主
  // （判定内效果的发出者身份恒是判定属主，不是外层调用方）；无外层 `env` 时不硬造，保持不填帧。
  const frameEnv: CallEnv | undefined = env === undefined ? undefined : { ...env, emitter }
  let result: EffResult
  try {
    const response = await row.link.call(
      eff.port,
      eff.method,
      eff.args,
      timeoutMs,
      signal,
      frameEnv,
    )
    result = response.ok
      ? { ok: true, value: response.value }
      : { ok: true, value: { error: response.code, message: response.message } }
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof ServiceChannelError ? err.code : 'transport_failed',
    }
  }
  if (options.onAudit !== undefined) {
    options.onAudit(
      buildAudit(
        eff,
        // 时间戳与帧同源（`env.now`）：同一次调用不得出现两个不一致的时钟来源；`run` 同外层 run。
        { by: emitter, now: env?.now ?? options.now(), emitter, run: env?.run ?? null },
        result,
        // 取消口径与 run-loop 的 `callEffect`（execute.ts）对齐：仅「已中止且结果就是 cancelled 通道错误」
        // 才记取消；超时 / 其它通道错误即便外层已中止也不误记为取消。
        signal?.aborted === true && result.ok === false && result.error === 'cancelled',
        resolveAuditRedact(resolutionWorld, row.impl, eff.port, eff.method),
      ),
    )
  }
  return result
}
