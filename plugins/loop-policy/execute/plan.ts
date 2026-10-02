// 计划构造与共享纯函数：门面把执行 / 账本提供方返回的计划机械合并为顶层 `$directives`，不落账、不读投影。
// 计划条目形状与宿主计划通道一致：`{kind:'write', request:{op, args}}` / `{kind:'extern', payload}` /
// `{kind:'eval', command, args}`。回合累积（trace 与 verdict 同世代）归 turn-ledger。
// 形态判定 / 时钟 / def 引用等共享纯函数真源在 `plugin-sdk`；本文件只保留本插件的计划组装。

import { externDirective } from 'plugin-sdk'
import type { Json } from './types.ts'

export {
  HASH_RE,
  asArray,
  asString,
  asStringArray,
  defHashOf,
  externDirective,
  isRecord,
  isoAt,
  nowOf,
  numberField,
  positiveInt,
  summaryOf,
} from 'plugin-sdk'

/** 组装最终计划值：写条目 + 一条 extern 摘要。 */
export function planOf(directives: Json[], payload: Json): Json {
  return { $directives: [...directives, externDirective(payload)] }
}
