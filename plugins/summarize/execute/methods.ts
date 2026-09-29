// 能力类 `summarize` 的方法表：derive / parse / current / to_l1 / to_l2 / sentences / merge。
// 结构化摘要形状与确定性派生原语（纯函数、同输入同输出、不取时间 / 随机）：
// - derive：结构化字段优先、缺失由会话切片按句派生；
// - parse / current：从摘要记录解析（current 另按目标长度截断全字段）；
// - sentences：从会话切片派生句子（extract 候选补足用）；
// - to_l1 / to_l2：写出 L1（六字段）/ L2（无 next_steps）形状；
// - merge：既有列表 + 去重后的新条目拼接；去重结果由消费方经 `dedup` 提供方算好后传入。
// 本服务无反向调用、不读投影、不写世界。

import { BadArgsError, isRecord } from 'plugin-sdk'
import {
  deriveSentences,
  mergeSummaries,
  parseSummary,
  summaryFromSource,
  summaryToJson,
  summaryToL2Json,
  truncateSummary,
} from './summary.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

function requireTargetLength(args: Rec): number {
  const value = args['target_length']
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadArgsError('target_length must be a positive integer')
  }
  return value
}

function requirePositiveInt(value: Json | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadArgsError(`${field} must be a positive integer`)
  }
  return value
}

/** 派生摘要来源：优先 args.summary（压缩产物），否则由扁平字段 / 切片派生。 */
function derive(args: Json): Json {
  const parsed = requireRecord(args)
  const targetLength = requireTargetLength(parsed)
  const extractItems = requirePositiveInt(parsed['extract_items'], 'extract_items')
  const source = isRecord(parsed['args']) ? parsed['args'] : {}
  return { summary: summaryFromSource(source, targetLength, extractItems) }
}

/** 解析摘要记录（不截断）；缺失 / 非字符串项忽略。 */
function parse(args: Json): Json {
  const parsed = requireRecord(args)
  return { summary: parseSummary(parsed['record']) }
}

/** 解析并按目标长度统一截断全字段。 */
function current(args: Json): Json {
  const parsed = requireRecord(args)
  return { summary: truncateSummary(parseSummary(parsed['record']), requireTargetLength(parsed)) }
}

/** 从会话切片派生句子（去重、截断、取前 limit 条）。 */
function sentences(args: Json): Json {
  const parsed = requireRecord(args)
  const targetLength = requireTargetLength(parsed)
  const limit = requirePositiveInt(parsed['limit'], 'limit')
  return { sentences: deriveSentences(parsed['session_slice'], limit, targetLength) }
}

/** 合并：既有列表 + 去重结果（消费方传入）；goal 新值优先。 */
function merge(args: Json): Json {
  const parsed = requireRecord(args)
  return mergeSummaries(
    parseSummary(parsed['existing']),
    parseSummary(parsed['incoming']),
    parsed['outcomes'],
  )
}

/** 写出 L1 形状（六个字段）。 */
function toL1(args: Json): Json {
  const parsed = requireRecord(args)
  return { record: summaryToJson(parseSummary(parsed['summary'])) }
}

/** 写出 L2 形状（无 next_steps）。 */
function toL2(args: Json): Json {
  const parsed = requireRecord(args)
  return { record: summaryToL2Json(parseSummary(parsed['summary'])) }
}

/** 构造方法表（纯函数，无依赖注入）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    derive: (args: Json, _env: CallEnv): HandlerResult => ({ value: derive(args), events: [] }),
    parse: (args: Json, _env: CallEnv): HandlerResult => ({ value: parse(args), events: [] }),
    current: (args: Json, _env: CallEnv): HandlerResult => ({ value: current(args), events: [] }),
    sentences: (args: Json, _env: CallEnv): HandlerResult => ({
      value: sentences(args),
      events: [],
    }),
    merge: (args: Json, _env: CallEnv): HandlerResult => ({ value: merge(args), events: [] }),
    to_l1: (args: Json, _env: CallEnv): HandlerResult => ({ value: toL1(args), events: [] }),
    to_l2: (args: Json, _env: CallEnv): HandlerResult => ({ value: toL2(args), events: [] }),
  }
}
