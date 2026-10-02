// 模型输出归一（纯函数）：厂商中立推理块形状与构造、缓存 token 归一、用量归一。
// 方言提供方（非流式整包解析）与模型协议消费方（逐段流式解码）共用同一口径，避免两处实现漂移。
// 零内核零宿主依赖。

import { isRecord } from './json.ts'
import type { Json, Rec } from './json.ts'

/** 推理块形态：整段文本或厂商内容块。 */
export type ReasoningForm = 'text' | 'blocks'

/**
 * 厂商中立推理块（字段固定）：装配只原样携带，`payload` / `signature` / `encrypted`
 * 一律不得改写或截断；编成哪家线格式由模型层决定。
 */
export interface ReasoningBlock {
  provider: string
  model: string
  form: ReasoningForm
  payload: string
  signature: string
  encrypted: string
  tokens: number
}

/** 构造中立推理块（全字段就位）。 */
export function reasoningBlock(
  provider: string,
  model: string,
  form: ReasoningForm,
  payload: string,
  signature = '',
  encrypted = '',
  tokens = 0,
): ReasoningBlock {
  return { provider, model, form, payload, signature, encrypted, tokens }
}

function numberField(source: Rec, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * 缓存 token 归一：OpenAI 系 `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` /
 * 顶层 `cached_tokens`；DeepSeek 系 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；
 * Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`；Google `cachedContentTokenCount`。
 * 只落出现过的字段，避免给消费方造零值。
 */
export function cacheTokens(source: Rec): Rec {
  const out: Rec = {}
  const promptDetails = isRecord(source['prompt_tokens_details'])
    ? (source['prompt_tokens_details'] as Rec)
    : null
  const inputDetails = isRecord(source['input_tokens_details'])
    ? (source['input_tokens_details'] as Rec)
    : null
  const cached =
    numberField(source, 'cached_tokens') ??
    (promptDetails === null ? undefined : numberField(promptDetails, 'cached_tokens')) ??
    (inputDetails === null ? undefined : numberField(inputDetails, 'cached_tokens'))
  if (cached !== undefined) out['cached_tokens'] = cached
  const hit = numberField(source, 'prompt_cache_hit_tokens')
  if (hit !== undefined) out['prompt_cache_hit_tokens'] = hit
  const miss = numberField(source, 'prompt_cache_miss_tokens')
  if (miss !== undefined) out['prompt_cache_miss_tokens'] = miss
  const read = numberField(source, 'cache_read_input_tokens')
  if (read !== undefined) out['cache_read_input_tokens'] = read
  const creation = numberField(source, 'cache_creation_input_tokens')
  if (creation !== undefined) out['cache_creation_input_tokens'] = creation
  const googleCached = numberField(source, 'cachedContentTokenCount')
  if (googleCached !== undefined) out['cached_content_tokens'] = googleCached
  return out
}

/**
 * 归一用量为 `{prompt_tokens, completion_tokens, total_tokens}`（含缓存 token）。
 * 两路计数都非数字时返回 null（调用方据此不产出 usage）。
 */
export function normalizeUsage(
  prompt: Json | undefined,
  completion: Json | undefined,
  source?: Rec,
): Rec | null {
  if (typeof prompt !== 'number' && typeof completion !== 'number') return null
  const promptTokens = typeof prompt === 'number' ? prompt : 0
  const completionTokens = typeof completion === 'number' ? completion : 0
  const usage: Rec = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
  if (source !== undefined) Object.assign(usage, cacheTokens(source))
  return usage
}
