// 共享纯函数真源在 `plugin-sdk`；本文件保留本插件的字段规范化与计划值构造。
// 服务不读投影、不落账、不构造世界写计划——队列与游标写自有持久存储（`store.ts`），
// 返回的 `$directives` 只含 `extern`（观测），不含 `write`。

import { asString, defHashOf, isRecord, summaryOf } from 'plugin-sdk'
import type { Json, Rec } from 'plugin-sdk'

export {
  HASH_RE,
  asCount,
  asString,
  defHashOf,
  externDirective,
  externOnly,
  isRecord,
  isoAt,
  nowOf,
  summaryOf,
} from 'plugin-sdk'
export type { Json, Rec } from 'plugin-sdk'

/** 缺省线程键（per-thread 键控）。 */
export const MAIN_THREAD = '_main'

// ── item 字段规范化 ─────────────────────────────────────────────────────────

const KINDS = new Set(['tool_call', 'orchestration_change', 'plugin_write'])

export function normalizeKind(value: Json | undefined): string | null {
  const kind = asString(value)
  return kind !== null && KINDS.has(kind) ? kind : null
}

/**
 * enqueue 的 kind 判据：显式 `kind` 优先；否则按 (port, 工具名) 归一——编排提案 → `orchestration_change`，
 * 插件写 → `plugin_write`，其余 `tool_call`。port 与工具名都缺失时回 null（调用方按 bad_args 拒）。
 */
export function normalizeEnqueueKind(args: Rec): string | null {
  const explicit = normalizeKind(args['kind'])
  if (explicit !== null) return explicit
  const tool = asString(args['tool'])
  const port = asString(args['port'])
  if (tool === null && port === null) return null
  if (tool === 'orchestration.propose' || port === 'orchestration') return 'orchestration_change'
  if (tool === 'plugin.write' || port === 'plugin-admin') return 'plugin_write'
  return 'tool_call'
}

/** 实际提供者能力类名：显式 port 优先，否则按 kind 取默认。 */
export function resolvePort(kind: string, port: Json | undefined): string {
  const explicit = asString(port)
  if (explicit !== null) return explicit
  if (kind === 'orchestration_change') return 'orchestration'
  if (kind === 'plugin_write') return 'plugin-admin'
  return 'tool'
}

/**
 * 调用描述：只收调用方显式给出的资产引用或摘要，不内联大 args、不把明文 args 转写进持久存储
 * （明文密钥可能就在 args 里，故缺省即 null，绝不从任意 args 合成摘要）。
 */
export function normalizeArgsRef(value: Json | undefined): Rec | null {
  if (typeof value === 'string' && value.length > 0) return { summary: summaryOf(value, 200) }
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
