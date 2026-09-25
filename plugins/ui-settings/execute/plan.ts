// 计划构造与共享纯函数：只返回 extern 透传计划，不落账、不读投影。
// 运行记录（输入槽 / 记忆）已出世界，读写经 owner 服务（`port.call`）——本插件不构造世界写计划。

import { isRecord } from './types.ts'
import type { Json } from './types.ts'

export type Rec = { [key: string]: Json }

/** 一条 extern 透传计划条目（不写世界、不推进）。 */
export function externDirective(payload: Json): Json {
  return { kind: 'extern', payload }
}

/** 无业务写时的计划值：只有一条 extern（不构造空 batch）。 */
export function externOnly(payload: Json): Json {
  return { $directives: [externDirective(payload)] }
}

export { isRecord }
