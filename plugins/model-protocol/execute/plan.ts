// 计划构造与共享纯函数：只返回写计划（`$directives`）与事件，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import type { Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** 顶层字段补丁：变者 replace、缺者 delete；不变者不产 op。 */
export function bodyPatches(prev: Rec, next: Rec): Json[] {
  const ops: Json[] = []
  for (const key of Object.keys(next)) {
    if (!canonicalEqual(prev[key], next[key])) ops.push({ op: 'replace', path: [key], value: next[key] })
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

/** 稳定序列化（对象键排序、递归），用于「新值与旧值是否相同」的机械比较。 */
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Rec
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export function canonicalEqual(a: Json, b: Json): boolean {
  return canonical(a) === canonical(b)
}

/** 深拷贝 JSON 值（结构克隆；用于写-改-写前复制快照）。 */
export function deepClone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
