// 计划构造与共享纯函数：只返回写计划（`$directives`），不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import { BadArgsError } from './types.ts'
import type { CallEnv, Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 字符串数组：缺省回空数组；含非字符串即拒（结构化 bad_args）。 */
export function asStringList(value: Json | undefined, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadArgsError(`${field} must be an array`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new BadArgsError(`${field} must contain strings`)
    out.push(item)
  }
  return out
}

/** 规范化 + 去空 + 精确去重（保序）。 */
export function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = item.trim().replace(/\s+/g, ' ')
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 帧 env 的固定时钟；env 缺失时回落 args.now，绝不自取时钟。 */
export function nowOf(env: CallEnv, args: Rec): number {
  if (typeof env.now === 'number' && Number.isFinite(env.now)) return env.now
  const fallback = args['now']
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0
}

/** 宿主时钟（毫秒）→ ISO 8601 字符串；纯格式化，不取当前时间。 */
export function isoAt(now: number): string {
  return new Date(now).toISOString()
}

/** 可选整数字段：缺省回落 fallback；非整数 / 越下界即拒。 */
export function integerField(value: Json | undefined, field: string, fallback: number, min: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new BadArgsError(`${field} must be an integer`)
  if (value < min) throw new BadArgsError(`${field} must be >= ${min}`)
  return value
}

/** 可选数值字段：缺省回落 fallback；非有限数 / 越界即拒。 */
export function numberField(
  value: Json | undefined,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadArgsError(`${field} must be a number`)
  if (value < min || value > max) throw new BadArgsError(`${field} must be within [${min}, ${max}]`)
  return value
}

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/** 单条 add_gen 子操作：payload / sig 指向同批更早的 put（四字段全必填）。 */
export function addGenOp(id: string, index: number): Json {
  return { op: 'add_gen', args: { id, payload: { $n: index }, sig: { $n: index }, pins: {} } }
}

/** 一条原子 batch write 计划条目。 */
export function batchDirective(ops: Json[]): Json {
  return { kind: 'write', request: { op: 'batch', args: { ops } } }
}

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 组装最终计划值：一条 batch + 一条 extern。 */
export function planOf(ops: Json[], payload: Json): Json {
  return { $directives: [batchDirective(ops), externDirective(payload)] }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

/** 结构化失败值（失败作数据，不炸本轮）。 */
export function errorValue(code: string, message: string): Rec {
  return { ok: false, error: { code, message } }
}
