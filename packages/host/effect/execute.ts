// 效果执行：每次 EffRequest → EffResult 必留一条 EffectAudit def，并被业务写的 ref 指到。
// 审计 def 由宿主直接提交（不经 run directive），以保证它在业务写之前就可寻址。
// 端点调用由调用方注入（A1 路由 + 服务协议 call）；未注入或调用未执行 → 不解析形态。

import { H, canonicalJson, commit } from '../../kernel/index.ts'
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

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 审计脱敏：`port=secrets` + `method=resolve` 的 `result` 只落白名单 `{name, kind, has}`，
 * 明文（短时句柄 / 密钥本体）不进审计正文；调用方拿到的真实结果不变（回灌走原 result）。
 * 判据用 port 名而非解析后的身份：路由不变式是「pin 名 = 调用的能力类名 = 目标必须声明的类」，
 * 且同一能力类不可被两个身份声明，故 port 名等价于目标声明的类，别名绕过不成立。
 */
function redactAuditResult(eff: EffRequest, result: EffResult): Json {
  if (eff.port !== 'secrets' || eff.method !== 'resolve') return result as unknown as Json
  const args = eff.args
  const authRef = isRecord(args) ? args['auth_ref'] : undefined
  const name = isRecord(authRef) && typeof authRef['name'] === 'string' ? authRef['name'] : null
  const kind = isRecord(authRef) && typeof authRef['kind'] === 'string' ? authRef['kind'] : null
  return { name, kind, has: deriveOutcome(result) === 'ok' }
}

/** host 批量返回方法：结果可能极大（字节 / 源码 / 审计记录）。 */
const HOST_BULK_METHODS: ReadonlySet<string> = new Set(['asset.get', 'source.read', 'audit'])

/**
 * 审计结果序列化上限：超过只落 `{truncated:true,size}`。
 * `host.asset.get`（8 MiB ≈ 10.7 MiB base64）与 `host.audit`（会拷入既往审计记录、超线性增长）
 * 若原样入账，会把 defs / journal / 审计索引撑爆；调用方仍拿到完整结果，只是审计正文留截断标记。
 */
export const MAX_AUDIT_RESULT_BYTES = 64 * 1024

/**
 * 审计请求参数序列化上限：`args` 超过只落 `{truncated:true,size}`，保留 `id`/`port`/`method`。
 * 大参数（源码 / 字节 / 审计记录）原样入账会把 defs / journal 撑爆；调用方仍拿完整 args，
 * 只是审计正文留截断标记。
 */
export const MAX_AUDIT_ARGS_BYTES = 64 * 1024

/** 审计正文口径：先按白名单脱敏，再对 host 批量结果做体积截断。 */
function auditResult(eff: EffRequest, result: EffResult): Json {
  const redacted = redactAuditResult(eff, result)
  if (eff.port !== 'host' || !HOST_BULK_METHODS.has(eff.method)) return redacted
  const size = canonicalJson(redacted).length
  if (size <= MAX_AUDIT_RESULT_BYTES) return redacted
  return { truncated: true, size }
}

/** 审计请求口径：`args` 超限即截断为标记，保留定位所需的 id / port / method。 */
function auditRequest(eff: EffRequest): Json {
  const size = canonicalJson(eff.args).length
  if (size <= MAX_AUDIT_ARGS_BYTES) return eff as unknown as Json
  return { id: eff.id, port: eff.port, method: eff.method, args: { truncated: true, size } }
}

/** 效果调用的结果与取消标记：服务调用与审计落账拆开，以便只把落账放进串行段。 */
export interface EffectCall {
  result: EffResult
  /** signal 已中止且结果记为 cancelled（审计 outcome 走 `cancelled`）。 */
  cancelled: boolean
}

/**
 * 执行端点调用：只做服务调用，不碰世界 / 链头。返回值一律是数据，不抛错。
 * 服务调用可能长时间 await，故调用方应在互斥段之外调用它。
 */
export async function callEffect(
  eff: EffRequest,
  call?: EndpointCaller,
  signal?: AbortSignal,
): Promise<EffectCall> {
  let result: EffResult
  if (signal?.aborted === true) {
    // 已中止：不再发起调用（否则可能依赖「未来 abort 事件」而悬挂），直接按 cancelled 收口
    result = { ok: false, error: 'cancelled' }
  } else if (call === undefined) {
    result = { ok: false, error: 'not_loaded' }
  } else {
    try {
      result = await call(eff)
    } catch {
      result = { ok: false, error: 'transport_failed' }
    }
  }
  const cancelled = signal?.aborted === true && result.ok === false && result.error === 'cancelled'
  return { result, cancelled }
}

/**
 * 把一次效果结局落成审计：构造审计 def、按 `head.hash` 作 `expect_pos` 提交。
 * 在**克隆副本**上提交并返回该副本：落盘（账本追加）成功前不触碰活世界，
 * 调用方须在互斥段内调用（独占 world），落盘成功后再切换 `state.world/head`。
 * @param eff 待解效果
 * @param world 当前世界（只读；提交在副本上完成）
 * @param head 当前链头
 * @param meta 审计元信息（by / now / run / emitter）
 * @param result 已取得的调用结果
 * @param cancelled 是否记为取消（outcome = `cancelled`）
 */
export function commitAudit(
  eff: EffRequest,
  world: World,
  head: Head,
  meta: AuditMeta,
  result: EffResult,
  cancelled: boolean,
): ExecuteOutcome {
  const auditOutcome: AuditOutcome = cancelled ? 'cancelled' : deriveOutcome(result)
  const auditDef = {
    body: {
      kind: EFFECT_AUDIT_KIND,
      request: auditRequest(eff),
      result: auditResult(eff, result),
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
  // 就地 commit 会先改活世界、后由调用方落盘；落盘失败即内存/磁盘分叉。
  // 故在独占副本上提交，只有调用方落盘成功后才把该副本切换为当前世界。
  // 审计写恒为 put（不触 ids）：只克隆 defs 层、ids 按引用共享，避免每次审计深拷全部身份 / 世代，
  // 也让按 ids 缓存的读侧（路由 ownerIndex / 方法级超时）跨审计命中。
  const next: World = { defs: { ...world.defs }, ids: world.ids }
  const outcome = commit(head, next, request, meta.now)
  if (!outcome.verdict.ok) {
    return { result, world: next, head, auditHash: null, auditEntry: null }
  }
  const nextHead: Head = outcome.entry
    ? { seq: outcome.entry.seq, hash: outcome.hash as Hash }
    : head
  return { result, world: next, head: nextHead, auditHash, auditEntry: outcome.entry }
}

/**
 * 执行一次效果并落审计（`callEffect` + `commitAudit` 的便捷组合）。
 * **仅供测试 / 单轮场景**：生产 run loop 必须分开调用两个原语，把落账放进宿主串行段
 * （`run-loop.ts` 的 writer 纪律），直接用它会把 `commitAudit` 落到互斥段之外。
 * 世界按副本演化（`commitAudit` 克隆 defs 层）：`world` 入参只读，结果世界经返回值给出。
 * @param eff 待解效果
 * @param world 当前世界（只读；提交在副本上完成）
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
  const { result, cancelled } = await callEffect(eff, call, signal)
  return commitAudit(eff, world, head, meta, result, cancelled)
}
