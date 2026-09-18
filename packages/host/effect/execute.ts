// 效果执行：每次 EffRequest → EffResult 必留一条 EffectAudit def，并被业务写的 ref 指到。
// 审计 def 由宿主直接提交（不经 run directive），以保证它在业务写之前就可寻址。
// 端点调用由调用方注入（A1 路由 + 服务协议 call）；未注入或调用未执行 → 不解析形态。

import { H, commit } from '../../kernel/index.ts'
import type {
  EffRequest,
  EffResult,
  Entry,
  Hash,
  Head,
  Json,
  World,
  WriteRequest,
} from '../../kernel/index.ts'

export interface ExecuteOutcome {
  result: EffResult
  world: World
  head: Head
  /** 审计 def 键（= H(Def)）；审计写入失败时为 null。 */
  auditHash: Hash | null
  /** 审计 entry；幂等命中时为 null（def 已在世界，仍可被 ref 指到）。 */
  auditEntry: Entry | null
}

/**
 * 端点调用器：由调用方（run loop）按 A1 路由后注入；返回值一律是数据，
 * 不抛错——没执行（连接 / 帧 / 进程死亡 / 未解析 / 超时）返回 `{ok:false}`。
 */
export type EndpointCaller = (eff: EffRequest) => Promise<EffResult>

/** 审计元信息：entry 的 `by` / `at` 与审计 def 内的 `run` / `emitter`（F8 只读面按此过滤）。 */
export interface AuditMeta {
  /** 发起者（审计 entry 的 `by`）。 */
  by: string
  /** 该轮固定时间戳（审计 entry 的 `at`）。 */
  now: number
  /** 本 run 的 run id（`accepted{run}` 同值）；不传记 null。 */
  run?: string
  /** 发出者身份（A1 路由基准）；不传记 null。 */
  emitter?: string
}

/**
 * 审计结局（G2 起随审计 def 落账；#37 审计视图 / #54 监控按此过滤）：
 * - `ok`：端点有响应且为成功值；
 * - `error`：端点有响应但为错误（`value.error`，term 可据值分支）；
 * - `transport_failed`：没执行（未解析 / 连接 / 帧 / 进程死亡 / 超时）；
 * - `cancelled`：在途被真取消中止（`cancel{run}`；result 记 `{ok:false,error:'cancelled'}`）。
 */
export const AUDIT_OUTCOMES = ['ok', 'error', 'transport_failed', 'cancelled'] as const

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** 审计 def 的保留判别键（机械识别审计 entry）。 */
export const EFFECT_AUDIT_KIND = 'effect_audit'

function deriveOutcome(result: EffResult): AuditOutcome {
  if (result.ok !== true) return 'transport_failed'
  const value = result.value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (typeof (value as { [k: string]: Json })['error'] === 'string') return 'error'
  }
  return 'ok'
}

/**
 * 执行一次效果并落审计。世界与链头按引用就地演化（commit 语义）：
 * 调用方必须传入自己独占的世界副本，并在续跑时使用返回的 world / head。
 * @param eff 待解效果
 * @param world 当前世界（就地演化）
 * @param head 当前链头
 * @param meta 审计元信息（by / now / run / emitter）
 * @param call 端点调用器；缺省 = 无路由（记 `not_loaded`）
 * @param signal 该 run 的取消信号：中止且结果是 `{ok:false,error:'cancelled'}` 时 outcome 记 `cancelled`
 */
export async function executeEffect(
  eff: EffRequest,
  world: World,
  head: Head,
  meta: AuditMeta,
  call?: EndpointCaller,
  signal?: AbortSignal,
): Promise<ExecuteOutcome> {
  let result: EffResult
  if (call === undefined) {
    result = { ok: false, error: 'not_loaded' }
  } else {
    try {
      result = await call(eff)
    } catch {
      result = { ok: false, error: 'transport_failed' }
    }
  }
  const aborted = signal?.aborted === true && result.ok === false && result.error === 'cancelled'
  const auditOutcome: AuditOutcome = aborted ? 'cancelled' : deriveOutcome(result)
  const auditDef = {
    body: {
      kind: EFFECT_AUDIT_KIND,
      request: eff as unknown as Json,
      result: result as unknown as Json,
      port: eff.port,
      method: eff.method,
      outcome: auditOutcome,
      run: meta.run ?? null,
      emitter: meta.emitter ?? null,
    },
  }
  const auditHash = H(auditDef as unknown as Json)
  const request: WriteRequest = {
    id: `audit-${eff.id}`,
    op: 'put',
    target: { expect_pos: head.hash },
    args: auditDef as unknown as Json,
    by: meta.by,
  }
  const outcome = commit(head, world, request, meta.now)
  if (!outcome.verdict.ok) {
    return { result, world, head, auditHash: null, auditEntry: null }
  }
  const nextHead: Head = outcome.entry
    ? { seq: outcome.entry.seq, hash: outcome.hash as Hash }
    : head
  return { result, world, head: nextHead, auditHash, auditEntry: outcome.entry }
}
