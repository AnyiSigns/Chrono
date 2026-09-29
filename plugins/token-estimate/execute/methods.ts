// 能力类 `token-estimate` 的方法表：count（批量计数）与 version（估算器规格版本）。
// 计数唯一实现是原生扩展（`native/tokenizer`），本服务不回落 JS 计数；批量入口一次调用计一组文本，
// 供上层 `context-window` 每轮装配只发一次批量 count（热路径红线）。
// 纯函数面：不取时间 / 随机、不读投影、不写世界。

import { BadArgsError, isRecord } from 'plugin-sdk'
import { countTokens, tokenizerVersion } from './native.ts'
import type { Handler, Json } from 'plugin-sdk'

/** 解析 count 的 args：取非空字符串数组；缺失 / 非数组 / 含非字符串项抛 bad_args。 */
function parseTexts(args: Json): string[] {
  const texts = isRecord(args) ? args['texts'] : undefined
  if (!Array.isArray(texts)) throw new BadArgsError('texts must be an array of strings')
  const out: string[] = []
  for (const item of texts) {
    if (typeof item !== 'string') throw new BadArgsError('texts must be an array of strings')
    out.push(item)
  }
  return out
}

/** 批量计数：逐条按 v1 估算器规格计数，返回同序数组。 */
function count(args: Json): Json {
  return { counts: parseTexts(args).map((text) => countTokens(text)) }
}

/** 估算器规格版本（接缝替换真 tokenizer 时随之变更）。 */
function version(): Json {
  return { version: tokenizerVersion() }
}

/** 构造方法表（无依赖注入）。 */
export function createHandlers(): Record<string, Handler> {
  return {
    count: (args) => ({ value: count(args), events: [] }),
    version: () => ({ value: version(), events: [] }),
  }
}
