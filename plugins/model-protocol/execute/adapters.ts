// 三协议**流式**解码（消费方）：把 SSE data 载荷解析为归一化分片（文本 / 推理 / 推理块 / 工具调用 / 用量 / 停止原因）。
// 请求编形与非流式整包解析在 `msg-dialect`（经反向 `port.call`）；逐段流式解码留本插件，因跨插件 RPC 不能传流式回调。
// 有界解码器——每个 protocol 一种；厂商差异经 quirks 声明的少量字段覆盖。

import { ModelError } from './errors.ts'
import {
  asRecord,
  normalizeUsage,
  reasoningBlock,
  stringField,
  StreamAccumulator,
} from './stream.ts'
import type { ReasoningBlock } from './stream.ts'
import type { Json, Rec } from 'plugin-sdk'

export interface ModelOutput {
  text: string
  reasoning?: string
  reasoning_blocks?: ReasoningBlock[]
  tool_calls: Json[]
  usage: Rec | null
  stop_reason?: string
}

export interface AdapterIdentity {
  provider: string
  model: string
}

/** 流式解码器：只解 SSE 分片，不编请求、不解析整包。 */
export interface StreamDecoder {
  readonly protocol: string
  handleStreamData(data: string, acc: StreamAccumulator): Rec[]
}

function isRecord(value: Json | undefined): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function single(fragment: Rec | null): Rec[] {
  return fragment === null ? [] : [fragment]
}

function pushFragment(target: Rec[], fragment: Rec | null): void {
  if (fragment !== null) target.push(fragment)
}

/** openai-chat：`/chat/completions` + `data:` 分片。 */
class OpenAiChatStreamDecoder implements StreamDecoder {
  readonly protocol = 'openai-chat'
  private readonly reasoningFields: string[]

  constructor(reasoningResponseField: string | null) {
    // 未显式声明响应推理字段时，按主流 OpenAI 兼容实现回退：DeepSeek 系 `reasoning_content`、
    // 网关 / OpenAI 系 `reasoning`、部分实现 `thinking`。显式声明则只用声明值。
    this.reasoningFields =
      reasoningResponseField !== null
        ? [reasoningResponseField]
        : ['reasoning_content', 'reasoning', 'thinking']
  }

  private pickReasoning(source: Rec): string | undefined {
    for (const field of this.reasoningFields) {
      const value = stringField(source, field)
      if (value !== undefined) return value
    }
    return undefined
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    if (data.trim() === '[DONE]') return single(acc.apply({ done: true }))
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const fragments: Rec[] = []
    const usage = isRecord(json['usage']) ? json['usage'] : undefined
    const choices = Array.isArray(json['choices']) ? json['choices'] : []
    if (choices.length === 0 && usage !== undefined) {
      pushFragment(
        fragments,
        acc.apply({
          usage:
            normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'], usage) ?? undefined,
        }),
      )
      return fragments
    }
    const choice = asRecord(choices[0])
    if (choice === null) return fragments
    const delta = asRecord(choice['delta']) ?? {}
    const shard: Parameters<StreamAccumulator['apply']>[0] = {}
    const text = stringField(delta, 'content')
    if (text !== undefined) shard.text = text
    const reasoning = this.pickReasoning(delta)
    if (reasoning !== undefined) shard.reasoning = reasoning
    if (Array.isArray(delta['tool_calls'])) {
      for (const rawCall of delta['tool_calls']) {
        const call = asRecord(rawCall)
        if (call === null) continue
        const fn = asRecord(call['function']) ?? {}
        pushFragment(
          fragments,
          acc.apply({
            tool_call: {
              index: typeof call['index'] === 'number' ? call['index'] : 0,
              id: stringField(call, 'id'),
              name: stringField(fn, 'name'),
              arguments_delta: stringField(fn, 'arguments'),
            },
          }),
        )
      }
    }
    if (shard.text !== undefined || shard.reasoning !== undefined)
      pushFragment(fragments, acc.apply(shard))
    if (usage !== undefined) {
      const normalized = normalizeUsage(usage['prompt_tokens'], usage['completion_tokens'], usage)
      if (normalized !== null) pushFragment(fragments, acc.apply({ usage: normalized }))
    }
    const finish = choice['finish_reason']
    if (typeof finish === 'string') pushFragment(fragments, acc.apply({ stop_reason: finish }))
    return fragments
  }
}

/** openai-responses：`/responses` + 类型化事件流。 */
class OpenAiResponsesStreamDecoder implements StreamDecoder {
  readonly protocol = 'openai-responses'
  private readonly toolIndex = new Map<string, number>()
  private nextToolIndex = 0
  private readonly identity: AdapterIdentity

  constructor(identity: AdapterIdentity) {
    this.identity = identity
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const type = stringField(json, 'type') ?? ''
    if (type === 'response.output_text.delta')
      return single(acc.apply({ text: stringField(json, 'delta') ?? '' }))
    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      return single(acc.apply({ reasoning: stringField(json, 'delta') ?? '' }))
    }
    if (type === 'response.output_item.added') return this.outputItemAdded(json, acc)
    if (type === 'response.function_call_arguments.delta') return this.argumentsDelta(json, acc)
    if (type === 'response.completed') return this.completed(json, acc)
    if (type === 'response.failed' || type === 'error') {
      throw new ModelError('model_server_error', `responses stream ${type}`, { retryable: true })
    }
    return []
  }

  private outputItemAdded(json: Rec, acc: StreamAccumulator): Rec[] {
    const item = asRecord(json['item'])
    if (item === null || item['type'] !== 'function_call') return []
    const itemId = stringField(item, 'id') ?? stringField(item, 'call_id') ?? ''
    const index = this.nextToolIndex
    this.nextToolIndex += 1
    this.toolIndex.set(itemId, index)
    return single(
      acc.apply({
        tool_call: { index, id: stringField(item, 'call_id'), name: stringField(item, 'name') },
      }),
    )
  }

  private argumentsDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const itemId = stringField(json, 'item_id') ?? ''
    const index = this.toolIndex.get(itemId) ?? 0
    return single(
      acc.apply({ tool_call: { index, arguments_delta: stringField(json, 'delta') ?? '' } }),
    )
  }

  private completed(json: Rec, acc: StreamAccumulator): Rec[] {
    const response = asRecord(json['response']) ?? {}
    const fragments: Rec[] = []
    for (const block of this.reasoningBlocksFromOutput(response['output'])) {
      pushFragment(fragments, acc.apply({ reasoning_block: block as unknown as Rec }))
    }
    const usage = asRecord(response['usage'])
    const normalized =
      usage === null ? null : normalizeUsage(usage['input_tokens'], usage['output_tokens'], usage)
    pushFragment(fragments, acc.apply({ usage: normalized ?? undefined, done: true }))
    return fragments
  }

  private reasoningBlocksFromOutput(output: Json | undefined): ReasoningBlock[] {
    if (!Array.isArray(output)) return []
    const blocks: ReasoningBlock[] = []
    for (const item of output) {
      const record = asRecord(item)
      if (record === null || record['type'] !== 'reasoning') continue
      const text = extractResponseReasoning(record)
      const encrypted = stringField(record, 'encrypted_content') ?? ''
      if (text.length === 0 && encrypted.length === 0) continue
      blocks.push(
        reasoningBlock(this.identity.provider, this.identity.model, 'text', text, '', encrypted),
      )
    }
    return blocks
  }
}

function extractResponseText(content: Json | undefined): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    const record = asRecord(part)
    if (record !== null && typeof record['text'] === 'string') text += record['text'] as string
  }
  return text
}

/** Responses 的推理项：摘要（summary）与推理正文（content）都是 text 片段。 */
function extractResponseReasoning(record: Rec): string {
  let text = extractResponseText(record['summary'])
  text += extractResponseText(record['content'])
  if (text.length === 0 && typeof record['text'] === 'string') text = record['text'] as string
  return text
}

/** anthropic-messages：`/messages` + 顶层 system 字段 + `x-api-key`。 */
class AnthropicMessagesStreamDecoder implements StreamDecoder {
  readonly protocol = 'anthropic-messages'
  private usageInput = 0
  private usageOutput = 0
  private usageCacheRead = 0
  private usageCacheCreation = 0
  private readonly pendingBlocks = new Map<
    number,
    { form: 'text' | 'blocks'; payload: string; signature: string; encrypted: string }
  >()
  private readonly identity: AdapterIdentity

  constructor(identity: AdapterIdentity) {
    this.identity = identity
  }

  handleStreamData(data: string, acc: StreamAccumulator): Rec[] {
    const json = JSON.parse(data) as Json
    if (!isRecord(json)) return []
    const type = stringField(json, 'type') ?? ''
    if (type === 'message_start') return this.messageStart(json, acc)
    if (type === 'content_block_start') return this.blockStart(json, acc)
    if (type === 'content_block_delta') return this.blockDelta(json, acc)
    if (type === 'message_delta') return this.messageDelta(json, acc)
    if (type === 'message_stop') return this.messageStop(acc)
    if (type === 'error')
      throw new ModelError('model_server_error', 'anthropic stream error', { retryable: true })
    return []
  }

  private messageStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const message = asRecord(json['message']) ?? {}
    const usage = asRecord(message['usage'])
    if (usage !== null && typeof usage['input_tokens'] === 'number') {
      this.usageInput = usage['input_tokens'] as number
      if (typeof usage['cache_read_input_tokens'] === 'number')
        this.usageCacheRead = usage['cache_read_input_tokens'] as number
      if (typeof usage['cache_creation_input_tokens'] === 'number') {
        this.usageCacheCreation = usage['cache_creation_input_tokens'] as number
      }
      return single(acc.apply({ usage: this.usage() ?? undefined }))
    }
    return []
  }

  private blockStart(json: Rec, acc: StreamAccumulator): Rec[] {
    const block = asRecord(json['content_block'])
    if (block === null) return []
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    if (block['type'] === 'thinking') {
      this.pendingBlocks.set(index, { form: 'blocks', payload: '', signature: '', encrypted: '' })
      return []
    }
    if (block['type'] === 'redacted_thinking') {
      const data = stringField(block, 'data') ?? ''
      this.pendingBlocks.set(index, { form: 'blocks', payload: '', signature: '', encrypted: data })
      return []
    }
    if (block['type'] !== 'tool_use') return []
    return single(
      acc.apply({
        tool_call: { index, id: stringField(block, 'id'), name: stringField(block, 'name') },
      }),
    )
  }

  private blockDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const delta = asRecord(json['delta']) ?? {}
    const index = typeof json['index'] === 'number' ? json['index'] : 0
    if (delta['type'] === 'text_delta')
      return single(acc.apply({ text: stringField(delta, 'text') ?? '' }))
    if (delta['type'] === 'thinking_delta') {
      const text = stringField(delta, 'thinking') ?? ''
      const pending = this.pendingBlocks.get(index)
      if (pending !== undefined) pending.payload += text
      return single(acc.apply({ reasoning: text }))
    }
    if (delta['type'] === 'signature_delta') {
      const pending = this.pendingBlocks.get(index)
      if (pending !== undefined) pending.signature = stringField(delta, 'signature') ?? ''
      return []
    }
    if (delta['type'] === 'input_json_delta') {
      return single(
        acc.apply({
          tool_call: { index, arguments_delta: stringField(delta, 'partial_json') ?? '' },
        }),
      )
    }
    return []
  }

  private messageDelta(json: Rec, acc: StreamAccumulator): Rec[] {
    const usage = asRecord(json['usage'])
    const delta = asRecord(json['delta']) ?? {}
    const fragments: Rec[] = []
    if (usage !== null && typeof usage['output_tokens'] === 'number') {
      this.usageOutput = usage['output_tokens'] as number
      pushFragment(fragments, acc.apply({ usage: this.usage() ?? undefined }))
    }
    if (typeof delta['stop_reason'] === 'string')
      pushFragment(fragments, acc.apply({ stop_reason: delta['stop_reason'] as string }))
    return fragments
  }

  private messageStop(acc: StreamAccumulator): Rec[] {
    const fragments: Rec[] = []
    for (const [, pending] of [...this.pendingBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (
        pending.payload.length === 0 &&
        pending.signature.length === 0 &&
        pending.encrypted.length === 0
      )
        continue
      const block = reasoningBlock(
        this.identity.provider,
        this.identity.model,
        pending.form,
        pending.payload,
        pending.signature,
        pending.encrypted,
      )
      pushFragment(fragments, acc.apply({ reasoning_block: block as unknown as Rec }))
    }
    pushFragment(fragments, acc.apply({ done: true }))
    return fragments
  }

  private usage(): Rec | null {
    const usage = normalizeUsage(this.usageInput, this.usageOutput)
    if (usage === null) return null
    if (this.usageCacheRead > 0) usage['cache_read_input_tokens'] = this.usageCacheRead
    if (this.usageCacheCreation > 0) usage['cache_creation_input_tokens'] = this.usageCacheCreation
    return usage
  }
}

/** 按 protocol 取流式解码器；不支持的协议 → model_unsupported。 */
export function getStreamDecoder(
  protocol: string,
  reasoningResponseField: string | null,
  identity: AdapterIdentity,
): StreamDecoder {
  if (protocol === 'openai-chat') return new OpenAiChatStreamDecoder(reasoningResponseField)
  if (protocol === 'openai-responses') return new OpenAiResponsesStreamDecoder(identity)
  if (protocol === 'anthropic-messages') return new AnthropicMessagesStreamDecoder(identity)
  throw new ModelError('model_unsupported', `unsupported protocol: ${protocol}`)
}
