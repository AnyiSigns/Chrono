// 计划构造与共享纯函数：只返回写计划（`$directives`）与事件，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}`；
// 占位符 `{"$n":k}` 只指向同批更早的 `put`（内核批处理替换，规矩 A）。

import type { CallEnv, Json, Rec } from './types.ts'

export function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 帧 env 的固定时钟；env 缺失时回落 0，绝不自取时钟。 */
export function nowOf(env: CallEnv): number {
  return typeof env.now === 'number' && Number.isFinite(env.now) ? env.now : 0
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
