// 计划构造与共享纯函数：只返回写计划（`$directives`），不落账、不读投影、不自取时钟。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换，规矩 A）。

import type { CallEnv, Json } from './types.ts'

/** def 键形状：64 位小写十六进制。 */
export const HASH_RE = /^[0-9a-f]{64}$/

export type Rec = { [key: string]: Json }

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}

/** 帧 env 的固定时钟；env 缺失时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
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

/** 数据世代基准：切片上的 `data_gen.seq`（含 `body.data_gen` 包裹形态）；无 → null，写整份世代。 */
export function baseSeqOf(slice: Rec): number | null {
  for (const candidate of [slice, isRecord(slice['body']) ? (slice['body'] as Rec) : null]) {
    if (candidate === null) continue
    const dataGen = candidate['data_gen']
    if (!isRecord(dataGen)) continue
    const seq = dataGen['seq']
    if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) return seq
  }
  return null
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
