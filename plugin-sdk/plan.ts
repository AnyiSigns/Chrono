// 计划值 helper：服务没有写通道，只回普通值 / extern 观测计划。
// 结构化失败作数据（`{ok:false,...}`），不炸本轮。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

export { asString, isRecord } from './json.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

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

/** 非负整数；缺失 / 非法返回 null。 */
export function asCount(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 帧 env 的固定时钟；env 缺失回落 args.now（若给出），绝不自取时钟。 */
export function nowOf(env: { now: number }, args?: Rec): number {
  if (typeof env.now === 'number' && Number.isFinite(env.now)) return env.now
  const fallback = args === undefined ? undefined : args['now']
  return numberField(fallback) ?? 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 一句摘要（事件 / trace 用）；对象取 `content`，其余取 JSON 串。 */
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

/** 值里是否带计划通道包装 `$directives`。 */
export function hasDirectives(value: Json): value is Rec {
  return isRecord(value) && Array.isArray(value['$directives'])
}

/** 取值的计划条目（无 `$directives` 回空数组）。 */
export function directivesOf(value: Json): Json[] {
  return hasDirectives(value) ? (value['$directives'] as Json[]) : []
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Rec {
  return { $directives: [externDirective(payload)] }
}

/** 按段序机械合并各段计划条目：数组拼接，不构造新 JSON 对象。 */
export function mergeDirectives(segments: Json[]): Rec {
  const merged: Json[] = []
  for (const segment of segments) {
    for (const directive of directivesOf(segment)) merged.push(directive)
  }
  return { $directives: merged }
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 值是否为结构化失败（`{ok:false,...}`）。 */
export function isErrorValue(value: Json): boolean {
  return isRecord(value) && value['ok'] === false
}
