// 计划构造与共享纯函数：只把各段返回的写计划机械合并为顶层 `$directives`，不落账、不读投影。
// 段序合并 = 数组拼接（不构造新 JSON 对象、不解读条目语义）；服务不写世界本体。

import type { Json, Rec } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 def 引用 / 裸哈希取哈希；形态非法返回 null。 */
export function defHashOf(value: Json | undefined): string | null {
  if (typeof value === 'string') return HASH_RE.test(value) ? value : null
  if (!isRecord(value)) return null
  const hash = value['def']
  return typeof hash === 'string' && HASH_RE.test(hash) ? hash : null
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 正整数；否则 null（用于 limit 等可选窗口）。 */
export function positiveInt(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** 有限数值；否则 null（用于 context_window / max_output 等档案字段）。 */
export function numberField(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 值是否为结构化失败（`{ok:false,...}`）——任一段失败即停、以 extern 收口。 */
export function isErrorValue(value: Json): boolean {
  return isRecord(value) && value['ok'] === false
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
export function externOnly(payload: Json): Json {
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
