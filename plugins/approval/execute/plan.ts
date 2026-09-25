// 共享纯函数：字段规范化与计划值构造。服务不读投影、不落账、不构造世界写计划——
// 队列与游标写自有持久存储（`store.ts`），返回的 `$directives` 只含 `extern`（观测），不含 `write`。

import type { CallEnv, Json } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

/** 缺省线程键（per-thread 键控）。 */
export const MAIN_THREAD = '_main'

export type Rec = { [key: string]: Json }

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 非负整数；缺失 / 非法返回 null。 */
export function asCount(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失（不该发生）时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（args_ref.summary / 事件载荷用）。 */
export function summaryOf(value: Json, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 无业务写时的计划值：只有一条 extern（服务从不构造世界写）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 从 def 引用 / 裸哈希取哈希；形态非法返回 null。 */
export function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return HASH_RE.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
}

// ── item 字段规范化 ─────────────────────────────────────────────────────────

const KINDS = new Set(['tool_call', 'orchestration_change', 'plugin_write'])

export function normalizeKind(value: Json | undefined): string | null {
  const kind = asString(value)
  return kind !== null && KINDS.has(kind) ? kind : null
}

/** 实际提供者能力类名：显式 port 优先，否则按 kind 取默认。 */
export function resolvePort(kind: string, port: Json | undefined): string {
  const explicit = asString(port)
  if (explicit !== null) return explicit
  if (kind === 'orchestration_change') return 'orchestration-admin'
  if (kind === 'plugin_write') return 'plugin-admin'
  return 'tool'
}

/**
 * 调用描述：只收调用方显式给出的资产引用或摘要，不内联大 args、不把明文 args 转写进持久存储
 * （明文密钥可能就在 args 里，故缺省即 null，绝不从任意 args 合成摘要）。
 */
export function normalizeArgsRef(value: Json | undefined): Rec | null {
  if (typeof value === 'string' && value.length > 0) return { summary: summaryOf(value) }
  if (!isRecord(value)) return null
  const sha256 = asString(value['sha256'])
  if (sha256 !== null) return { sha256 }
  const summary = asString(value['summary'])
  if (summary !== null) return { summary }
  return null
}

/** 续跑依据：`{command:'chat.resume', args:{cursor, thread}}`；无 cursor 时 null。 */
export function buildResume(args: Rec, thread: string): Rec | null {
  if (!Object.hasOwn(args, 'cursor')) return null
  const cursor = args['cursor']
  if (cursor === null || cursor === undefined) return null
  return { command: 'chat.resume', args: { cursor, thread } }
}

/** 影子回放指标 def 引用；非法返回 null。 */
export function normalizeShadow(value: Json | undefined): Rec | null {
  const hash = defHashOf(value)
  return hash === null ? null : { def: hash }
}

/** verdict 槽词汇 → item 结果态（写死映射）。 */
export function verdictToStatus(verdict: string | null): string | null {
  if (verdict === 'accept') return 'approved'
  if (verdict === 'deny') return 'denied'
  return null
}

export function statusOf(item: Rec): string | null {
  return asString(item['status'])
}

/** 线程键：args.thread_id 非空字符串，否则 `_main`。 */
export function threadKeyOf(args: Rec): string {
  return asString(args['thread_id']) ?? MAIN_THREAD
}
