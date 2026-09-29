// SSE 解析与流式累积：以累积索引去重（tool_calls 按 index 合并），文本 / 推理按出现序拼接。
// usage 来源由厂商 `stream_usage` 决定，适配器已归一到 {prompt_tokens, completion_tokens, total_tokens}。

import { isRecord } from './plan.ts'
import type { Json, Rec } from 'plugin-sdk'

/** 适配器解析出的归一化分片。 */
export interface Shard {
  text?: string
  reasoning?: string
  /** 厂商中立推理块（含签名 / 加密）：只随最终值回带，不上行事件。 */
  reasoning_block?: Rec
  tool_call?: { index: number; id?: string; name?: string; arguments_delta?: string }
  usage?: Rec
  stop_reason?: string
  done?: boolean
}

export interface ToolCallValue {
  id: string | null
  name: string | null
  arguments: Json
}

interface ToolCallState {
  id: string | null
  name: string | null
  args: string
}

function parseArguments(raw: string): Json {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw) as Json
  } catch {
    return raw
  }
}

/** 流式累积器：同输入同输出（无时间 / 随机），供最终值与事件分片共用。 */
export class StreamAccumulator {
  private readonly textParts: string[] = []
  private readonly reasoningParts: string[] = []
  private readonly reasoningBlocks: Rec[] = []
  private readonly tools = new Map<number, ToolCallState>()
  private usage: Rec | null = null
  private stopReason: string | null = null

  /** 应用一个分片：更新状态并回传事件载荷片段（无内容返回 null）。 */
  apply(shard: Shard): Rec | null {
    const fragment: Rec = {}
    if (typeof shard.text === 'string' && shard.text.length > 0) {
      this.textParts.push(shard.text)
      fragment['text'] = shard.text
    }
    if (typeof shard.reasoning === 'string' && shard.reasoning.length > 0) {
      this.reasoningParts.push(shard.reasoning)
      fragment['reasoning'] = shard.reasoning
    }
    if (shard.reasoning_block !== undefined) {
      this.reasoningBlocks.push(shard.reasoning_block)
      fragment['reasoning_block'] = shard.reasoning_block
    }
    if (shard.tool_call !== undefined) {
      const call = this.mergeToolCall(shard.tool_call)
      fragment['tool_call'] = call as unknown as Json
    }
    if (shard.usage !== undefined) {
      this.usage = shard.usage
      fragment['usage'] = shard.usage
    }
    if (shard.stop_reason !== undefined) this.stopReason = shard.stop_reason
    if (shard.done === true) fragment['done'] = true
    return Object.keys(fragment).length === 0 ? null : fragment
  }

  private mergeToolCall(call: {
    index: number
    id?: string
    name?: string
    arguments_delta?: string
  }): Rec {
    const existing = this.tools.get(call.index) ?? { id: null, name: null, args: '' }
    if (call.id !== undefined) existing.id = call.id
    if (call.name !== undefined) existing.name = call.name
    if (call.arguments_delta !== undefined) existing.args += call.arguments_delta
    this.tools.set(call.index, existing)
    const fragment: Rec = { index: call.index }
    if (call.id !== undefined) fragment['id'] = call.id
    if (call.name !== undefined) fragment['name'] = call.name
    if (call.arguments_delta !== undefined) fragment['arguments_delta'] = call.arguments_delta
    return fragment
  }

  get text(): string {
    return this.textParts.join('')
  }

  get reasoning(): string {
    return this.reasoningParts.join('')
  }

  /** 适配器在终止分片里给出的中立推理块（按出现序）。 */
  get reasoningBlocksValue(): Rec[] {
    return this.reasoningBlocks
  }

  get usageValue(): Rec | null {
    return this.usage
  }

  get stopReasonValue(): string | null {
    return this.stopReason
  }

  toolCalls(): ToolCallValue[] {
    return [...this.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, state]) => ({
        id: state.id,
        name: state.name,
        arguments: parseArguments(state.args),
      }))
  }
}

/** 增量 SSE 解析器：喂入任意分片文本，产出已完整的 `data:` 载荷串。 */
export function createSseParser(): { push: (chunk: string) => string[] } {
  let buffered = ''
  return {
    push(chunk: string): string[] {
      buffered += chunk
      const events: string[] = []
      let boundary = buffered.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const block = buffered.slice(0, boundary)
        const match = buffered.slice(boundary).match(/^\r?\n\r?\n/)
        buffered = buffered.slice(boundary + (match?.[0].length ?? 2))
        const data = extractData(block)
        if (data !== null) events.push(data)
        boundary = buffered.search(/\r?\n\r?\n/)
      }
      return events
    },
  }
}

function extractData(block: string): string | null {
  const lines = block.split(/\r?\n/)
  const parts: string[] = []
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, ''))
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/** 从对象里安全取字符串字段。 */
export function stringField(record: Rec, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** 判断一个 JSON 值是否为普通对象。 */
export function asRecord(value: Json | undefined): Rec | null {
  return isRecord(value) ? value : null
}

/** 厂商中立推理块形状（字段固定）：流式解码在消费方构造，整包解析由 `msg-dialect` 对称产出。 */
export interface ReasoningBlock {
  provider: string
  model: string
  form: 'text' | 'blocks'
  payload: string
  signature: string
  encrypted: string
  tokens: number
}

/** 构造中立块（消费方流式路径用；形状与 `msg-dialect` 一致）。 */
export function reasoningBlock(
  provider: string,
  model: string,
  form: 'text' | 'blocks',
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

/** 缓存 token 归一（与 `msg-dialect` 同口径）：只落出现过的字段。 */
function cacheTokens(source: Rec): Rec {
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

/** 归一用量为 `{prompt_tokens, completion_tokens, total_tokens}`（含缓存 token）。 */
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
