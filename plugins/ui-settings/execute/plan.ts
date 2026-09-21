// 计划构造与共享纯函数：只返回写计划（`$directives`）与结果值，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换）。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

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

export { isRecord }
