// 计划构造与共享纯函数：门面把执行 / 账本提供方返回的计划机械合并为顶层 `$directives`，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}` /
// `{kind:'eval', command, args}`。回合累积（trace 与 verdict 同世代）归 turn-ledger。

import type { Json, Rec } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 数组；否则 null。 */
export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 字符串数组：缺省空数组；含非字符串即剔（不抛）。 */
export function asStringArray(value: Json | undefined): string[] {
  const list = asArray(value)
  if (list === null) return []
  return list.filter((item): item is string => typeof item === 'string')
}

/** 有限数值；否则 null。 */
export function numberField(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 正整数；否则 null。 */
export function positiveInt(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失回落 args.now，绝不自取时钟。 */
export function nowOf(env: { now: number }, args: Rec): number {
  if (typeof env.now === 'number' && Number.isFinite(env.now)) return env.now
  return numberField(args['now']) ?? 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（事件 / trace 用）。 */
export function summaryOf(value: Json, limit = 160): string {
  let text = ''
  if (typeof value === 'string') text = value
  else if (isRecord(value) && typeof value['content'] === 'string') text = value['content']
  else text = JSON.stringify(value) ?? ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 从 def 引用 / 裸哈希取哈希；形态非法返回 null。 */
export function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return HASH_RE.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 组装最终计划值：写条目 + 一条 extern 摘要。 */
export function planOf(directives: Json[], payload: Json): Json {
  return { $directives: [...directives, externDirective(payload)] }
}
