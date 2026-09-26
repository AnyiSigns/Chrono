// 计划值 helper：服务没有写通道，只回普通值 / extern 观测计划。
// 结构化失败作数据（`{ok:false,...}`），不炸本轮。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

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
