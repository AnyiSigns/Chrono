// schema 参数装载与可调项解析。
// 基线值住同包 `schema/title.json`（启动时读一次，缺省回落内置常量）；
// 调用方入口 term 若把身份数据读出随 args 传入，可按次覆盖（热改路径）。

import { readFileSync } from 'node:fs'
import { log } from './frames.ts'
import { asString, isRecord, positiveInt } from './plan.ts'
import type { Json, Rec } from './types.ts'

/** 字数上限硬顶：任何来源的配置都不得超过它（Unicode 码点）。 */
export const HARD_MAX_CHARS = 10

export const DEFAULT_PROMPT =
  '你是会话标题生成器。请依据用户的第一条消息生成一个简洁的中文标题。' +
  '要求：只输出标题本身，不超过 10 个字，不要加引号、标点、解释或换行。'

export const DEFAULT_MAX_CHARS = 10
export const DEFAULT_MAX_TOKENS = 64
export const DEFAULT_TIMEOUT_MS = 15000

export interface TitleConfig {
  prompt: string
  maxChars: number
  maxTokens: number
  timeoutMs: number
}

function readSchema(): Rec {
  try {
    const text = readFileSync(new URL('../schema/title.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch (err) {
    log(`cannot read schema/title.json: ${(err as Error).message}`)
  }
  return {}
}

function propertyDefault(schema: Rec, key: string): Json | undefined {
  const properties = schema['properties']
  if (!isRecord(properties)) return undefined
  const property = properties[key]
  return isRecord(property) ? property['default'] : undefined
}

function clampMaxChars(value: number): number {
  if (value < 1) return 1
  if (value > HARD_MAX_CHARS) return HARD_MAX_CHARS
  return value
}

/** 从 schema 默认值构造基线配置。 */
export function loadBaseConfig(): TitleConfig {
  const schema = readSchema()
  const prompt = asString(propertyDefault(schema, 'prompt')) ?? DEFAULT_PROMPT
  const maxChars = clampMaxChars(positiveInt(propertyDefault(schema, 'max_chars'), DEFAULT_MAX_CHARS))
  const maxTokens = positiveInt(propertyDefault(schema, 'max_tokens'), DEFAULT_MAX_TOKENS)
  const timeoutMs = positiveInt(propertyDefault(schema, 'timeout_ms'), DEFAULT_TIMEOUT_MS)
  return { prompt, maxChars, maxTokens, timeoutMs }
}

/** 按 args 覆盖基线配置（缺省 / 非法值保留基线）。 */
export function resolveConfig(base: TitleConfig, args: Rec): TitleConfig {
  return {
    prompt: asString(args['prompt']) ?? base.prompt,
    maxChars: clampMaxChars(positiveInt(args['max_chars'], base.maxChars)),
    maxTokens: positiveInt(args['max_tokens'], base.maxTokens),
    timeoutMs: positiveInt(args['timeout_ms'], base.timeoutMs),
  }
}
