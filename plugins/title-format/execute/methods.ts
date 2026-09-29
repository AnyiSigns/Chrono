// 能力类 `title-format` 的方法表：clean / fallback / resolve。
// 标题后处理原语（纯函数，同输入同输出、不取时间 / 随机）：去引号标点 → 码点截断 → 兜底顺序。
// 服务无反向调用、不读投影、不写世界：只按 args 回标题值，重逻辑全部住本提供方。

import { BadArgsError, asString, isRecord } from 'plugin-sdk'
import { cleanModelTitle, fallbackTitle, resolveTitle } from './title.ts'
import type { CallEnv, Handler, HandlerResult, Json, Rec } from 'plugin-sdk'

/** 取必填字符串；缺失或非字符串抛 `BadArgsError`。 */
function requireString(args: Rec, key: string): string {
  const value = asString(args[key])
  if (value === null) throw new BadArgsError(`${key} required`)
  return value
}

/** 取必填的可空字符串（键必须存在；值可为 string / null）；否则抛 `BadArgsError`。 */
function requireNullableString(args: Rec, key: string): string | null {
  if (!Object.hasOwn(args, key)) throw new BadArgsError(`${key} required`)
  const value = args[key]
  if (value === null) return null
  if (typeof value !== 'string') throw new BadArgsError(`${key} must be a string or null`)
  return value
}

/** 取正整数 `max_chars`；非正整数抛 `BadArgsError`。 */
function requireMaxChars(args: Rec): number {
  const value = args['max_chars']
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BadArgsError('max_chars must be a positive integer')
  }
  return value
}

function requireRecord(args: Json): Rec {
  if (!isRecord(args)) throw new BadArgsError('args must be an object')
  return args
}

/** 清理模型原始输出：取首个非空行、去引号 / 换行 / 结尾标点，再按码点截断。 */
function clean(args: Json): Json {
  const parsed = requireRecord(args)
  return {
    title: cleanModelTitle(requireString(parsed, 'text'), requireMaxChars(parsed)),
  }
}

/** 兜底标题：首条用户消息去空白后前 `max_chars` 字。 */
function fallback(args: Json): Json {
  const parsed = requireRecord(args)
  return {
    title: fallbackTitle(requireString(parsed, 'first_message'), requireMaxChars(parsed)),
  }
}

/** 兜底顺序：模型清理结果 → 首条消息前 N 字 → 调用方缺省标题。 */
function resolve(args: Json): Json {
  const parsed = requireRecord(args)
  const modelText = requireNullableString(parsed, 'model_text')
  const firstMessage = requireString(parsed, 'first_message')
  const titleDefault = requireString(parsed, 'title_default')
  return {
    title: resolveTitle(modelText, firstMessage, requireMaxChars(parsed), titleDefault),
  }
}

/** 构造方法表（纯函数，无依赖注入）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    clean: (args: Json, _env: CallEnv): HandlerResult => ({
      value: clean(args),
      events: [],
    }),
    fallback: (args: Json, _env: CallEnv): HandlerResult => ({
      value: fallback(args),
      events: [],
    }),
    resolve: (args: Json, _env: CallEnv): HandlerResult => ({
      value: resolve(args),
      events: [],
    }),
  }
}
