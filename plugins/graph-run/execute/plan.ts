// 计划与共享纯函数：本插件只把节点返回的写计划机械装入 `$directives` 序列；不落账、不读投影。
// 回合累积（trace 与 verdict 同世代）归 turn-ledger。
// 形态判定 / def 引用等共享纯函数真源在 `plugin-sdk`；本文件只保留本插件特有的计划组装与剥离。

import { isRecord } from 'plugin-sdk'
import type { Json, Rec } from './types.ts'

export {
  HASH_RE,
  asArray,
  asString,
  asStringArray,
  defHashOf,
  directivesOf,
  isRecord,
  numberField,
} from 'plugin-sdk'

/** 单条 put 子操作。 */
export function putOp(body: Json): Json {
  return { op: 'put', args: { body } }
}

/**
 * 一条 eval 计划条目（宿主按命令名解析入口）。
 * `inject` 声明宿主执行期把投影片段按路径并入 args（键 → 投影路径）。
 */
export function evalDirective(command: string, args: Json, inject?: Rec): Json {
  const directive: Rec = { kind: 'eval', command, args }
  if (inject !== undefined) directive['inject'] = inject
  return directive
}

/**
 * 递归剥掉计划通道键 `$directives`：工具结果里的写计划含 `$n` 占位符，
 * 一旦随消息展示数据 / 续跑游标落进世界，会被内核保留命名空间拒绝或误替换。
 */
export function stripPlans(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => stripPlans(item))
  if (value === null || typeof value !== 'object') return value
  const out: Rec = {}
  for (const [key, item] of Object.entries(value as Rec)) {
    if (key === '$directives') continue
    out[key] = stripPlans(item)
  }
  return out
}

/**
 * 递归把数据里的 `{'$n':k}` 字面量包成内核转义 `{'$lit':…}`：工具结果 / 游标是任意 JSON，
 * 可能恰好含 `$n` 形状；不转义会被内核当占位符替换（越界则 bad_selfref）。
 * 内核在落账时还原 `$lit`，故世界里的数据逐字不变。
 */
export function escapeRefs(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => escapeRefs(item))
  if (value === null || typeof value !== 'object') return value
  const record = value as Rec
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$n') return { $lit: { $n: record['$n'] } }
  const out: Rec = {}
  for (const [key, item] of Object.entries(record)) out[key] = escapeRefs(item)
  return out
}

/**
 * 工具结果里冒泡的写计划：`results[].result.$directives`。
 * `tool-dispatch.dispatch` 只回 results、不冒泡计划，故 question / todo 等提供者把写计划放进工具结果，由此收集并入回合尾计划。
 */
export function nestedDirectivesOf(value: Json): Json[] {
  if (!isRecord(value)) return []
  const results = value['results']
  if (!Array.isArray(results)) return []
  const out: Json[] = []
  for (const item of results) {
    if (!isRecord(item)) continue
    const result = item['result']
    if (isRecord(result) && Array.isArray(result['$directives'])) {
      for (const directive of result['$directives'] as Json[]) out.push(directive)
    }
  }
  return out
}
