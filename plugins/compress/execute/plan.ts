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

/** 规范化文本：trim + 空白折叠；非字符串回空串。 */
export function normalizeText(value: Json | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
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
    const text = normalizeText(item)
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

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/** 单条 add_gen 子操作：payload / sig 指向同批更早的 put；`base` 存在即补丁世代。 */
export function addGenOp(id: string, index: number, base?: number): Json {
  const args: Rec = { id, payload: { $n: index }, sig: { $n: index }, pins: {} }
  if (base !== undefined) args['base'] = base
  return { op: 'add_gen', args }
}

/** `data_gen` 视图里的 `seq`（非负整数）；缺失 / 非法回 null。 */
export function dataGenSeqOf(value: Json | undefined): number | null {
  if (!isRecord(value)) return null
  const seq = value['seq']
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}

/** JSON 结构相等（键序无关、类型严格）。 */
function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  }
  return false
}

/** 顶层字段补丁：变者 replace、缺者 delete；不变者不产 op。 */
export function bodyPatches(prev: Rec, next: Rec): Json[] {
  const ops: Json[] = []
  for (const key of Object.keys(next)) {
    if (!jsonEqual(prev[key], next[key])) ops.push({ op: 'replace', path: [key], value: next[key] })
  }
  for (const key of Object.keys(prev)) {
    if (key in next) continue
    ops.push({ op: 'delete', path: [key] })
  }
  return ops
}

/**
 * 追加数据世代的写子操作：有数据世代（base）且补丁非空 ⇒ put(补丁) + add_gen(base)；
 * 否则整份 put + add_gen。调用方在调用前取 `ops.length` 作为 put 下标（本函数内部完成 push）。
 */
export function pushBodyGen(ops: Json[], id: string, prev: Rec, next: Rec, base: number | null): void {
  const index = ops.length
  if (base !== null) {
    const patches = bodyPatches(prev, next)
    if (patches.length > 0) {
      ops.push(putOp({ ops: patches }))
      ops.push(addGenOp(id, index, base))
      return
    }
  }
  ops.push(putOp(next))
  ops.push(addGenOp(id, index))
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
