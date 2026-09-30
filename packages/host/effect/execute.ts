// 效果执行：每次 EffRequest → EffResult 必留一条审计草稿（旁路侧存，不进世界 def、不落链）。
// 审计由调用方在取得结果后交给侧存追加；端点调用由调用方注入（A1 路由 + 服务协议 call）。
// 未注入或调用未执行 → 不解析形态，仍记 transport_failed 审计。

import { canonicalJson } from '../../kernel/index.ts'
import type { EffRequest, EffResult, Json } from '../../kernel/index.ts'
import { EFFECT_AUDIT_KIND } from '../audit.ts'
import type { AuditDraft, AuditOutcome } from '../audit.ts'
import { shapeAuditArgs } from '../audit-redact.ts'
import { isRecord } from '../common/json.ts'

/**
 * 端点调用器：由调用方（run loop）按 A1 路由后注入；返回值一律是数据，
 * 不抛错——没执行（连接 / 帧 / 进程死亡 / 未解析 / 超时）返回 `{ok:false}`。
 */
export type EndpointCaller = (eff: EffRequest) => Promise<EffResult>

/** 审计元信息：记录的时间戳 / 发起者，以及审计正文里的 `run` / `emitter`（F8 只读面按此过滤）。 */
export interface AuditMeta {
  /** 发起者（审计记录的 `by`）。 */
  by: string
  /** 该轮固定时间戳（审计记录的 `at`）。 */
  now: number
  /** 本 run 的 run id（`accepted{run}` 同值）；不传记 null。 */
  run?: string
  /** 发出者身份（A1 路由基准）；不传记 null。 */
  emitter?: string
}

/**
 * 槽调用的一个审计元素：`element` 是该成员已执行的结果记录（成功值或错误记录）；
 * `null` = 未执行（整体取消后剩余成员不再有语义）。`keys` 是该提供方声明的脱敏白名单。
 */
export interface SlotAuditElement {
  provider: string
  keys?: readonly string[]
  element: Json | null
}

/** 槽调用的审计数据：按成员顺序的逐元素表（含未执行者，落审计时省略其正文）。 */
export interface SlotAudit {
  elements: SlotAuditElement[]
}

function deriveOutcome(result: EffResult): AuditOutcome {
  if (result.ok !== true) return 'transport_failed'
  const value = result.value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (typeof (value as { [k: string]: Json })['error'] === 'string') return 'error'
  }
  return 'ok'
}

/**
 * 审计脱敏：调用方给出声明式白名单键（`schema.audit_redact`，由宿主按被调身份解析）时，
 * `result` 只落白名单键 + 派生 `has`（由 outcome 推导），明文（短时句柄 / 密钥本体）不进审计正文；
 * 调用方拿到的真实结果不变（回灌走原 result）。白名单键从调用的 `args.auth_ref` 引用取
 * （世界只存引用不存本体），取不到记 null。
 */
function redactAuditResult(
  eff: EffRequest,
  result: EffResult,
  redactKeys: readonly string[] | undefined,
): Json {
  if (redactKeys === undefined) return result as unknown as Json
  const args = eff.args
  const authRef = isRecord(args) ? args['auth_ref'] : undefined
  const out: { [k: string]: Json } = {}
  for (const key of redactKeys) {
    out[key] = isRecord(authRef) && typeof authRef[key] === 'string' ? authRef[key] : null
  }
  out['has'] = deriveOutcome(result) === 'ok'
  return out
}

/**
 * 审计结果序列化上限：超过只落 `{truncated:true,size}`。
 * 任意端口的返回值都可能极大——`host.asset.get`（8 MiB ≈ 10.7 MiB base64）、`host.audit`
 * （拷入既往审计记录、超线性增长）、以及 `ui-approval.decide` / `chat.resume` 这类把整段
 * 续跑游标放进计划值的命令。原样入账会把侧存 / 审计索引撑爆，并在写入时同步序列化多兆字节
 * 而卡住宿主事件循环（进而触发全服务健康超时误杀）。
 * 调用方仍拿到完整结果，只是审计正文留截断标记。
 */
export const MAX_AUDIT_RESULT_BYTES = 64 * 1024

/**
 * 审计请求形状摘要的序列化上限：形状（顶层键 + 各值体量 + 白名单字段）超过它即退化为单条截断标记。
 * `args` 正文不再内嵌，正常远低于上限；此上限只防键数异常多时形状本身撑爆侧存。
 */
export const MAX_AUDIT_ARGS_BYTES = 64 * 1024

/** 审计正文口径：先按声明白名单脱敏，再对结果做**全端口**体积截断。 */
function auditResult(
  eff: EffRequest,
  result: EffResult,
  redactKeys: readonly string[] | undefined,
): Json {
  const redacted = redactAuditResult(eff, result, redactKeys)
  const size = canonicalJson(redacted).length
  if (size <= MAX_AUDIT_RESULT_BYTES) return redacted
  return { truncated: true, size }
}

/**
 * 审计请求口径：不再内嵌 `args` 正文（大参数内嵌会把侧存撑爆），只落形状摘要 + 关键标识
 * （`id`/`port`/`method`/`caps`；`run`/`emitter`/`outcome` 已在正文顶层）+ 白名单放行字段。
 * 形状摘要仍超上限（键数异常多）时按既有口径退化为 `{truncated:true,size}`；调用方仍拿完整 args。
 */
function auditRequest(eff: EffRequest, redactKeys: readonly string[] | undefined): Json {
  const shape = shapeAuditArgs(eff.args, redactKeys)
  const args =
    canonicalJson(shape).length <= MAX_AUDIT_ARGS_BYTES
      ? shape
      : { truncated: true, size: canonicalJson(eff.args).length }
  return { id: eff.id, port: eff.port, method: eff.method, caps: eff.caps, args }
}

/**
 * 槽的一个已执行元素的审计正文：保留 `{provider, ok}` 骨架，失败补 `error` / `message`；
 * 声明式脱敏时以白名单投影（取 `args.auth_ref` 引用）替换 `value` 并派生 `has`，否则原样保留元素 `value`。
 */
function slotElementAudit(
  eff: EffRequest,
  element: Json,
  keys: readonly string[] | undefined,
): { [k: string]: Json } {
  const record = isRecord(element) ? element : {}
  const ok = record['ok'] === true
  const provider = record['provider']
  const out: { [k: string]: Json } = {
    provider: typeof provider === 'string' ? provider : null,
    ok,
  }
  if (!ok) {
    const error = record['error']
    out['error'] = typeof error === 'string' ? error : 'transport_failed'
    const message = record['message']
    if (message !== undefined) out['message'] = message
  }
  if (keys !== undefined) {
    const authRef = isRecord(eff.args) ? eff.args['auth_ref'] : undefined
    for (const key of keys) {
      out[key] = isRecord(authRef) && typeof authRef[key] === 'string' ? authRef[key] : null
    }
    out['has'] = ok
  } else if (record['value'] !== undefined) {
    out['value'] = record['value']
  }
  return out
}

/** 单元素超限即只留 `{provider, ok, value:{truncated,size}}`；聚合总量预算仍由调用方兜底。 */
function truncateSlotElement(entry: { [k: string]: Json }): { [k: string]: Json } {
  const size = canonicalJson(entry).length
  if (size <= MAX_AUDIT_RESULT_BYTES) return entry
  return { provider: entry['provider'], ok: entry['ok'], value: { truncated: true, size } }
}

/**
 * 槽审计正文：逐元素脱敏 / 截断（未执行者省略）；聚合总量超预算时整槽落标记 + `{provider, ok}` 骨架表——
 * 否则一个超限元素会吞掉全槽取证，或 N 个大元素各自合规却撑爆侧存。
 */
function auditSlotResult(eff: EffRequest, slotAudit: SlotAudit): Json {
  const elements: { [k: string]: Json }[] = []
  for (const element of slotAudit.elements) {
    if (element.element === null) continue
    elements.push(truncateSlotElement(slotElementAudit(eff, element.element, element.keys)))
  }
  const size = canonicalJson(elements).length
  if (size <= MAX_AUDIT_RESULT_BYTES) return elements
  const skeleton = elements.map((entry) => ({ provider: entry['provider'], ok: entry['ok'] }))
  return { truncated: true, size, elements: skeleton }
}

/** 槽审计结局：取消优先；任一元素失败 → `error`；否则 `ok`（不依赖 `deriveOutcome` 的数组行为）。 */
function slotOutcomeOf(slotAudit: SlotAudit, cancelled: boolean): AuditOutcome {
  if (cancelled) return 'cancelled'
  for (const element of slotAudit.elements) {
    if (isRecord(element.element) && element.element['ok'] === false) return 'error'
  }
  return 'ok'
}

/** 效果调用的结果与取消标记：服务调用与审计草稿构造拆开，便于调用方各自放置。 */
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
 * 构造一次效果的审计草稿（纯函数，不碰世界 / 链头 / 侧存）。
 * `seq` 由侧存在追加时分配；调用方须在结果取得后、由单写者串行交给侧存。
 * @param eff 待解效果
 * @param meta 审计元信息（by / now / run / emitter）
 * @param result 已取得的调用结果
 * @param cancelled 是否记为取消（outcome = `cancelled`）
 * @param redactKeys 声明式脱敏白名单键（`schema.audit_redact`）；缺省落完整结果
 * @param slotAudit 槽调用的逐元素审计数据；给定时按聚合口径落正文与结局，`redactKeys` 不参与
 */
export function buildAudit(
  eff: EffRequest,
  meta: AuditMeta,
  result: EffResult,
  cancelled: boolean,
  redactKeys?: readonly string[],
  slotAudit?: SlotAudit,
): AuditDraft {
  const auditOutcome: AuditOutcome =
    slotAudit === undefined
      ? cancelled
        ? 'cancelled'
        : deriveOutcome(result)
      : slotOutcomeOf(slotAudit, cancelled)
  const auditBody =
    slotAudit === undefined ? auditResult(eff, result, redactKeys) : auditSlotResult(eff, slotAudit)
  // 请求形状的白名单字段：单值调用取方法级声明；槽调用取各元素提供方声明的并集。
  const requestKeys =
    redactKeys ?? slotAudit?.elements.flatMap((element) => element.keys ?? [])
  return {
    at: meta.now,
    by: meta.by,
    body: {
      kind: EFFECT_AUDIT_KIND,
      request: auditRequest(eff, requestKeys),
      result: auditBody,
      port: eff.port,
      method: eff.method,
      outcome: auditOutcome,
      run: meta.run ?? null,
      emitter: meta.emitter ?? null,
    },
  }
}
