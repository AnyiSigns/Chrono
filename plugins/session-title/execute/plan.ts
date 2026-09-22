// 计划构造与共享纯函数：只返回写计划（`$directives`），不落账、不读投影。
// 本插件的写计划来自会话服务 `set_title`，原样上提给入口 term 机械合并；
// 自身不构造 put / add_gen（不写世界本体），只在无计划可上提时回一条 extern。

import type { Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 正整数；否则回落缺省（用于 schema / args 的可调数值）。 */
export function positiveInt(value: Json | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
  return value
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}

/** 值里是否带计划通道包装 `$directives`。 */
export function hasDirectives(value: Json): value is Rec {
  return isRecord(value) && Array.isArray(value['$directives'])
}
